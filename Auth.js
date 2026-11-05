'use strict';

/**
 * Contas (criadas so pelo admin), HWID e sessoes. Tudo no Postgres.
 *  - senha: scrypt com sal (nunca guardada em texto)
 *  - sessao: token aleatorio de 256 bits, so o hash fica no banco, preso ao HWID
 *  - HWID: o client manda um hash; o servidor guarda o hash dele de novo
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL e obrigatoria para o sistema de contas (Postgres).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

/** 'kick' (username): o duel.js derruba os WebSockets dessa conta. */
const events = new EventEmitter();

const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `s1:${salt.toString('hex')}:${h.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [v, salt, hash] = stored.split(':');
  if (v !== 's1') return false;
  const h = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

let DUMMY_HASH = null; // usado quando o usuario nao existe (mesmo tempo de resposta)

const ready = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          BIGSERIAL PRIMARY KEY,
      username    TEXT NOT NULL,
      username_lc TEXT UNIQUE NOT NULL,
      pass_hash   TEXT NOT NULL,
      hwid_hash   TEXT,
      expires_at  TIMESTAMPTZ,
      banned      BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login  TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hwid_hash  TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  DUMMY_HASH = await hashPassword('dummy-password-for-timing');
})();

setInterval(() => {
  pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
}, 3600_000).unref();

// ───────────── Usuario ─────────────

/** So o admin chama isto. Senha vazia = gera uma aleatoria (devolvida UMA vez). */
async function createUser(username, password, days) {
  await ready;
  if (!USER_RE.test(username)) return { status: 400, error: 'Usuario invalido (3-16 letras, numeros ou _).' };
  let generated = null;
  if (!password) password = generated = crypto.randomBytes(9).toString('base64url');
  if (password.length < 8 || password.length > 128) return { status: 400, error: 'A senha precisa ter de 8 a 128 caracteres.' };
  const passHash = await hashPassword(password);
  try {
    await pool.query(
      `INSERT INTO users (username, username_lc, pass_hash, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)`,
      [username, username.toLowerCase(), passHash, days]
    );
  } catch (e) {
    if (e.code === '23505') return { status: 409, error: 'Esse usuario ja existe.' };
    throw e;
  }
  return { ok: true, password: generated }; // password so vem preenchida se foi gerada
}

const fails = new Map(); // username_lc -> { n, until }  (so para contas que existem)

async function login(username, password, hwid) {
  await ready;
  if (!HEX64.test(hwid)) return { status: 400, error: 'Client invalido. Atualize o Obscure.' };
  const generic = { status: 401, error: 'Usuario ou senha invalidos.' };
  if (!USER_RE.test(username) || !password || password.length > 128) return generic;

  const lc = username.toLowerCase();
  const f = fails.get(lc);
  if (f && f.until > Date.now()) {
    return { status: 429, error: 'Muitas tentativas. Tente de novo em alguns minutos.' };
  }

  const r = await pool.query('SELECT * FROM users WHERE username_lc = $1', [lc]);
  const u = r.rows[0];
  const okPw = await verifyPassword(password, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !okPw) {
    if (u) {
      const n = (f && f.until <= Date.now() ? 0 : f ? f.n : 0) + 1;
      fails.set(lc, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    }
    return generic;
  }
  fails.delete(lc);

  if (u.banned) return { status: 403, error: 'Conta banida.' };
  if (u.expires_at && new Date(u.expires_at).getTime() < Date.now()) {
    return { status: 403, error: 'Licenca expirada.' };
  }

  const hw = sha256(hwid);
  if (!u.hwid_hash) {
    await pool.query('UPDATE users SET hwid_hash = $1 WHERE id = $2 AND hwid_hash IS NULL', [hw, u.id]);
  } else if (!safeEq(hw, u.hwid_hash)) {
    return { status: 403, error: 'Este PC nao e o registrado na conta. Peca o reset de HWID ao admin.' };
  }

  // uma sessao por conta (impede compartilhar login)
  events.emit('kick', u.username);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  const token = crypto.randomBytes(32).toString('hex');
  let exp = Date.now() + SESSION_MS;
  if (u.expires_at) exp = Math.min(exp, new Date(u.expires_at).getTime());
  await pool.query('INSERT INTO sessions (token_hash, user_id, hwid_hash, expires_at) VALUES ($1,$2,$3,$4)', [
    sha256(token), u.id, hw, new Date(exp),
  ]);
  await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);

  return {
    ok: true,
    token,
    username: u.username,
    expiresAt: exp,
    daysLeft: u.expires_at ? Math.max(0, Math.ceil((new Date(u.expires_at).getTime() - Date.now()) / 86400000)) : -1,
  };
}

/** Valida token + HWID. Devolve { username, exp } ou null. Usado pelo WebSocket. */
async function validateSession(token, hwid) {
  await ready;
  if (typeof token !== 'string' || !TOKEN_RE.test(token) || typeof hwid !== 'string' || !HEX64.test(hwid)) return null;
  const r = await pool.query(
    `SELECT u.username, u.banned, u.expires_at AS lic, s.hwid_hash, s.expires_at AS sexp
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(token)]
  );
  const row = r.rows[0];
  if (!row || row.banned) return null;
  const now = Date.now();
  let exp = new Date(row.sexp).getTime();
  if (row.lic) exp = Math.min(exp, new Date(row.lic).getTime());
  if (exp <= now) return null;
  if (!safeEq(sha256(hwid), row.hwid_hash)) return null;
  return { username: row.username, exp };
}

async function logout(token) {
  await ready;
  if (typeof token === 'string' && TOKEN_RE.test(token)) {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  }
}

// ───────────── Admin ─────────────

async function listUsers() {
  await ready;
  const r = await pool.query(
    `SELECT id, username, (hwid_hash IS NOT NULL) AS hwid_bound, expires_at, banned, created_at, last_login
       FROM users ORDER BY id DESC LIMIT 1000`
  );
  return r.rows;
}

async function resetHwid(id) {
  await ready;
  const r = await pool.query('UPDATE users SET hwid_hash = NULL WHERE id = $1 RETURNING username', [id]);
  if (!r.rowCount) return false;
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  events.emit('kick', r.rows[0].username);
  return true;
}

async function setBanned(id, banned) {
  await ready;
  const r = await pool.query('UPDATE users SET banned = $2 WHERE id = $1 RETURNING username', [id, banned]);
  if (!r.rowCount) return false;
  if (banned) {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    events.emit('kick', r.rows[0].username);
  }
  return true;
}

async function extend(id, days) {
  await ready;
  const r = await pool.query(
    `UPDATE users SET expires_at = GREATEST(expires_at, now()) + make_interval(days => $2)
      WHERE id = $1 AND expires_at IS NOT NULL`,
    [id, days]
  );
  return r.rowCount > 0;
}

async function deleteUser(id) {
  await ready;
  const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]); // sessoes saem por CASCADE
  if (!r.rowCount) return false;
  events.emit('kick', r.rows[0].username);
  return true;
}

/** Gera nova senha aleatoria (mostrada UMA vez ao admin) e derruba a sessao atual. */
async function resetPassword(id) {
  await ready;
  const pw = crypto.randomBytes(9).toString('base64url');
  const r = await pool.query('UPDATE users SET pass_hash = $2 WHERE id = $1 RETURNING username', [id, await hashPassword(pw)]);
  if (!r.rowCount) return null;
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  events.emit('kick', r.rows[0].username);
  fails.delete(r.rows[0].username.toLowerCase());
  return pw;
}

module.exports = {
  events, login, logout, validateSession,
  createUser, listUsers, resetHwid, setBanned, extend, deleteUser, resetPassword,
  sha256, safeEq,
};