'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 512 * 1024; // 512 KB
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// =========================================================
// Storage: Postgres (DATABASE_URL) ou pasta local (dev)
// =========================================================

function createPgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS capes (
      nick       TEXT PRIMARY KEY,
      png        BYTEA NOT NULL,
      token_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  return {
    async get(nick) {
      await ready;
      const r = await pool.query('SELECT png, token_hash, updated_at FROM capes WHERE nick = $1', [nick]);
      if (!r.rowCount) return null;
      const row = r.rows[0];
      return { png: row.png, tokenHash: row.token_hash, updatedAt: new Date(row.updated_at).getTime() };
    },
    async put(nick, png, tokenHash) {
      await ready;
      // em update o token_hash original e mantido
      await pool.query(
        `INSERT INTO capes (nick, png, token_hash, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (nick) DO UPDATE SET png = EXCLUDED.png, updated_at = now()`,
        [nick, png, tokenHash]
      );
    },
    async del(nick) {
      await ready;
      await pool.query('DELETE FROM capes WHERE nick = $1', [nick]);
    },
  };
}

function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = (n) => path.join(dir, `${n}.png`);
  const metaPath = (n) => path.join(dir, `${n}.json`);
  return {
    async get(nick) {
      try {
        const [png, meta] = await Promise.all([fsp.readFile(pngPath(nick)), fsp.readFile(metaPath(nick), 'utf8')]);
        const j = JSON.parse(meta);
        return { png, tokenHash: j.tokenHash, updatedAt: j.updatedAt };
      } catch {
        return null;
      }
    },
    async put(nick, png, tokenHash) {
      await fsp.writeFile(pngPath(nick), png);
      await fsp.writeFile(metaPath(nick), JSON.stringify({ tokenHash, updatedAt: Date.now() }));
    },
    async del(nick) {
      await fsp.rm(pngPath(nick), { force: true });
      await fsp.rm(metaPath(nick), { force: true });
    },
  };
}

const store = process.env.DATABASE_URL
  ? createPgStore(process.env.DATABASE_URL)
  : createFileStore(process.env.DATA_DIR || path.join(__dirname, 'data', 'capes'));

console.log(process.env.DATABASE_URL ? '[capes] storage: Postgres' : '[capes] storage: disco local (dados somem em hosts efemeros!)');

// =========================================================
// Validacao
// =========================================================

/** Valida PNG sem decodificar: assinatura, IHDR, proporcao 2:1 (64x32, 128x64...) e IEND. */
function validatePng(buf) {
  if (buf.length < 45 || !buf.subarray(0, 8).equals(PNG_SIG)) return 'O arquivo precisa ser um PNG.';
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return 'PNG invalido.';
  if (!buf.subarray(buf.length - 12).equals(PNG_IEND)) return 'PNG corrompido ou incompleto.';
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w < 64 || w > 1024 || w % 64 !== 0 || h !== w / 2) {
    return `Tamanho ${w}x${h} nao suportado. Use 64x32 (ou 128x64, 256x128, ... ate 1024x512).`;
  }
  return null;
}

function parseNick(raw) {
  return NICK_RE.test(raw || '') ? raw.toLowerCase() : null;
}

// =========================================================
// App
// =========================================================

const app = express();
app.set('trust proxy', 1); // Render fica atras de proxy
app.disable('x-powered-by');

const readLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Download usado pelo client do jogo: /cape/<nick>.png
app.get(/^\/cape\/([A-Za-z0-9_]{1,16})\.png$/, readLimiter, async (req, res, next) => {
  try {
    const row = await store.get(req.params[0].toLowerCase());
    if (!row) return res.status(404).json({ error: 'Sem capa para este nick.' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' });
    res.send(row.png); // o Express gera ETag e responde 304 sozinho
  } catch (e) {
    next(e);
  }
});

// Info para o site
app.get('/api/cape/:nick', readLimiter, async (req, res, next) => {
  try {
    const nick = parseNick(req.params.nick);
    if (!nick) return res.status(400).json({ error: 'Nick invalido (1-16 letras, numeros ou _).' });
    const row = await store.get(nick);
    res.json({ exists: !!row, updatedAt: row ? row.updatedAt : null });
  } catch (e) {
    next(e);
  }
});

// Upload: corpo = PNG cru. Primeiro envio devolve a chave de edicao.
app.post(
  '/api/cape/:nick',
  writeLimiter,
  express.raw({ type: 'image/png', limit: MAX_BYTES }),
  async (req, res, next) => {
    try {
      const nick = parseNick(req.params.nick);
      if (!nick) return res.status(400).json({ error: 'Nick invalido (1-16 letras, numeros ou _).' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Envie um PNG.' });
      }
      const problem = validatePng(req.body);
      if (problem) return res.status(400).json({ error: problem });

      const existing = await store.get(nick);
      let token = null;
      let tokenHash;
      if (existing) {
        const given = req.get('x-token') || '';
        if (!given || !safeEqualHex(sha256(given), existing.tokenHash)) {
          return res.status(403).json({
            error: 'Este nick ja tem dono. Informe a chave de edicao recebida no primeiro envio.',
          });
        }
        tokenHash = existing.tokenHash;
      } else {
        token = crypto.randomBytes(24).toString('hex');
        tokenHash = sha256(token);
      }

      await store.put(nick, req.body, tokenHash);
      res.json({ ok: true, nick, token, url: `/cape/${nick}.png` });
    } catch (e) {
      next(e);
    }
  }
);

app.delete('/api/cape/:nick', writeLimiter, async (req, res, next) => {
  try {
    const nick = parseNick(req.params.nick);
    if (!nick) return res.status(400).json({ error: 'Nick invalido.' });
    const existing = await store.get(nick);
    if (!existing) return res.status(404).json({ error: 'Sem capa para este nick.' });
    const given = req.get('x-token') || '';
    if (!given || !safeEqualHex(sha256(given), existing.tokenHash)) {
      return res.status(403).json({ error: 'Chave de edicao invalida.' });
    }
    await store.del(nick);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Arquivo grande demais (max 512 KB).' });
  }
  console.error(err);
  res.status(500).json({ error: 'Erro interno.' });
});

app.listen(PORT, () => console.log(`[capes] rodando na porta ${PORT}`));