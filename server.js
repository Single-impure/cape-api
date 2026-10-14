'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const rateLimit = require('express-rate-limit');
const { MIME, validateImage, imageInfo } = require('./validate');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB (PNG 2048x1024 / GIF 480x480 animado)
const MAX_MB = Math.round(MAX_BYTES / (1024 * 1024));
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const kindOfMime = (mime) => (mime === MIME.gif ? 'gif' : 'png');

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// =========================================================
// Storage: Postgres (DATABASE_URL) ou pasta local (dev)
// Interface: get(nick) -> { data, mime, tokenHash, updatedAt } | null
// =========================================================

function createPgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
  // A coluna "png" guarda os bytes da imagem (PNG ou GIF); o nome ficou por compatibilidade.
  const ready = pool
    .query(`
      CREATE TABLE IF NOT EXISTS capes (
        nick       TEXT PRIMARY KEY,
        png        BYTEA NOT NULL,
        token_hash TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    // migracao: linhas antigas viram image/png automaticamente
    .then(() => pool.query(`ALTER TABLE capes ADD COLUMN IF NOT EXISTS mime TEXT NOT NULL DEFAULT 'image/png'`));

  return {
    async get(nick) {
      await ready;
      const r = await pool.query('SELECT png, mime, token_hash, updated_at FROM capes WHERE nick = $1', [nick]);
      if (!r.rowCount) return null;
      const row = r.rows[0];
      return {
        data: row.png,
        mime: row.mime,
        tokenHash: row.token_hash,
        updatedAt: new Date(row.updated_at).getTime(),
      };
    },
    async put(nick, data, mime, tokenHash) {
      await ready;
      // em update o token_hash original e mantido
      await pool.query(
        `INSERT INTO capes (nick, png, mime, token_hash, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (nick) DO UPDATE SET png = EXCLUDED.png, mime = EXCLUDED.mime, updated_at = now()`,
        [nick, data, mime, tokenHash]
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
  const dataPath = (n, kind) => path.join(dir, `${n}.${kind}`);
  const metaPath = (n) => path.join(dir, `${n}.json`);
  return {
    async get(nick) {
      try {
        const j = JSON.parse(await fsp.readFile(metaPath(nick), 'utf8'));
        const mime = j.mime || MIME.png; // dados antigos nao tinham mime
        const data = await fsp.readFile(dataPath(nick, kindOfMime(mime)));
        return { data, mime, tokenHash: j.tokenHash, updatedAt: j.updatedAt };
      } catch {
        return null;
      }
    },
    async put(nick, data, mime, tokenHash) {
      const kind = kindOfMime(mime);
      await fsp.writeFile(dataPath(nick, kind), data);
      await fsp.rm(dataPath(nick, kind === 'png' ? 'gif' : 'png'), { force: true }); // troca de formato
      await fsp.writeFile(metaPath(nick), JSON.stringify({ tokenHash, mime, updatedAt: Date.now() }));
    },
    async del(nick) {
      await fsp.rm(dataPath(nick, 'png'), { force: true });
      await fsp.rm(dataPath(nick, 'gif'), { force: true });
      await fsp.rm(metaPath(nick), { force: true });
    },
  };
}

const store = process.env.DATABASE_URL
  ? createPgStore(process.env.DATABASE_URL)
  : createFileStore(process.env.DATA_DIR || path.join(__dirname, 'data', 'capes'));

console.log(process.env.DATABASE_URL ? '[capes] storage: Postgres' : '[capes] storage: disco local (dados somem em hosts efemeros!)');

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

// Download usado pelo client do jogo: /cape/<nick>.png ou /cape/<nick>.gif
// A extensao precisa bater com o tipo guardado (um client antigo que pede .png
// recebe 404 numa capa GIF, em vez de tentar decodificar um GIF como PNG).
app.get(/^\/cape\/([A-Za-z0-9_]{1,16})\.(png|gif)$/, readLimiter, async (req, res, next) => {
  try {
    const row = await store.get(req.params[0].toLowerCase());
    if (!row || row.mime !== MIME[req.params[1]]) {
      return res.status(404).json({ error: 'Sem capa para este nick.' });
    }
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=60' });
    res.send(row.data); // o Express gera ETag e responde 304 sozinho
  } catch (e) {
    next(e);
  }
});

// Info para o site e para o client: tipo, tamanho e URL certa
app.get('/api/cape/:nick', readLimiter, async (req, res, next) => {
  try {
    const nick = parseNick(req.params.nick);
    if (!nick) return res.status(400).json({ error: 'Nick invalido (1-16 letras, numeros ou _).' });
    const row = await store.get(nick);
    if (!row) return res.json({ exists: false, updatedAt: null });
    const type = kindOfMime(row.mime);
    const { width, height } = imageInfo(row.data, type);
    res.json({
      exists: true,
      updatedAt: row.updatedAt,
      type,
      width,
      height,
      bytes: row.data.length,
      url: `/cape/${nick}.${type}`,
    });
  } catch (e) {
    next(e);
  }
});

// Upload: corpo = PNG ou GIF cru. Primeiro envio devolve a chave de edicao.
app.post(
  '/api/cape/:nick',
  writeLimiter,
  express.raw({ type: ['image/png', 'image/gif'], limit: MAX_BYTES }),
  async (req, res, next) => {
    try {
      const nick = parseNick(req.params.nick);
      if (!nick) return res.status(400).json({ error: 'Nick invalido (1-16 letras, numeros ou _).' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Envie um PNG ou GIF.' });
      }
      const { kind, error } = validateImage(req.body);
      if (error) return res.status(400).json({ error });

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

      await store.put(nick, req.body, MIME[kind], tokenHash);
      res.json({ ok: true, nick, token, type: kind, url: `/cape/${nick}.${kind}` });
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
    return res.status(413).json({ error: `Arquivo grande demais (max ${MAX_MB} MB).` });
  }
  console.error(err);
  res.status(500).json({ error: 'Erro interno.' });
});

const server = app.listen(PORT, () => console.log(`[capes] rodando na porta ${PORT}`));

// WebSocket dos jogos multiplayer (PingPong 1v1 etc.) em /ws
require('./duel').attach(server);