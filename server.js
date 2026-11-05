'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const rateLimit = require('express-rate-limit');
const { MIME, validateImage, imageInfo } = require('./validate');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 16 * 1024 * 1024; // 16 MB (PNG 4096x4096 / GIF animado)
const MAX_MB = Math.round(MAX_BYTES / (1024 * 1024));
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const KINDS = ['png', 'gif', 'jpg'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const kindOfMime = (mime) => (mime === MIME.gif ? 'gif' : mime === MIME.jpg ? 'jpg' : 'png');

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// =========================================================
// Storage: Postgres (DATABASE_URL) ou pasta local (dev)
// Interface:
//   info(nick) -> { mime, tokenHash, updatedAt, width, height, bytes } | null   (barato, sem a imagem)
//   get(nick)  -> { data, mime } | null                                         (imagem completa)
// =========================================================

function createPgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
  // A coluna "png" guarda os bytes da imagem (PNG, GIF ou JPG); o nome ficou por compatibilidade.
  const ready = pool
    .query(`
      CREATE TABLE IF NOT EXISTS capes (
        nick       TEXT PRIMARY KEY,
        png        BYTEA NOT NULL,
        token_hash TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    .then(() => pool.query(`ALTER TABLE capes ADD COLUMN IF NOT EXISTS mime TEXT NOT NULL DEFAULT 'image/png'`))
    .then(() => pool.query(`ALTER TABLE capes ADD COLUMN IF NOT EXISTS width INT`))
    .then(() => pool.query(`ALTER TABLE capes ADD COLUMN IF NOT EXISTS height INT`));

  return {
    async info(nick) {
      await ready;
      const r = await pool.query(
        'SELECT mime, token_hash, updated_at, width, height, length(png) AS bytes FROM capes WHERE nick = $1',
        [nick]
      );
      if (!r.rowCount) return null;
      const row = r.rows[0];
      let { width, height } = row;
      if (width == null || height == null) {
        // linha antiga (antes das colunas): calcula uma vez e grava
        const full = await pool.query('SELECT png FROM capes WHERE nick = $1', [nick]);
        if (!full.rowCount) return null;
        const d = imageInfo(full.rows[0].png, kindOfMime(row.mime));
        width = d.width;
        height = d.height;
        await pool.query('UPDATE capes SET width = $2, height = $3 WHERE nick = $1', [nick, width, height]);
      }
      return {
        mime: row.mime,
        tokenHash: row.token_hash,
        updatedAt: new Date(row.updated_at).getTime(),
        width,
        height,
        bytes: Number(row.bytes),
      };
    },
    async get(nick) {
      await ready;
      const r = await pool.query('SELECT png, mime FROM capes WHERE nick = $1', [nick]);
      if (!r.rowCount) return null;
      return { data: r.rows[0].png, mime: r.rows[0].mime };
    },
    async put(nick, data, mime, tokenHash, width, height) {
      await ready;
      // em update o token_hash original e mantido
      await pool.query(
        `INSERT INTO capes (nick, png, mime, token_hash, width, height, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (nick) DO UPDATE SET
           png = EXCLUDED.png, mime = EXCLUDED.mime,
           width = EXCLUDED.width, height = EXCLUDED.height, updated_at = now()`,
        [nick, data, mime, tokenHash, width, height]
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
  const readMeta = async (nick) => {
    try {
      return JSON.parse(await fsp.readFile(metaPath(nick), 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    async info(nick) {
      const j = await readMeta(nick);
      if (!j) return null;
      const mime = j.mime || MIME.png; // dados antigos nao tinham mime
      const kind = kindOfMime(mime);
      let { width, height, bytes } = j;
      if (!width || !height || !bytes) {
        try {
          const data = await fsp.readFile(dataPath(nick, kind));
          const d = imageInfo(data, kind);
          width = d.width;
          height = d.height;
          bytes = data.length;
        } catch {
          return null;
        }
      }
      return { mime, tokenHash: j.tokenHash, updatedAt: j.updatedAt, width, height, bytes };
    },
    async get(nick) {
      const j = await readMeta(nick);
      if (!j) return null;
      const mime = j.mime || MIME.png;
      try {
        return { data: await fsp.readFile(dataPath(nick, kindOfMime(mime))), mime };
      } catch {
        return null;
      }
    },
    async put(nick, data, mime, tokenHash, width, height) {
      const kind = kindOfMime(mime);
      await fsp.writeFile(dataPath(nick, kind), data);
      for (const k of KINDS) if (k !== kind) await fsp.rm(dataPath(nick, k), { force: true }); // troca de formato
      await fsp.writeFile(
        metaPath(nick),
        JSON.stringify({ tokenHash, mime, width, height, bytes: data.length, updatedAt: Date.now() })
      );
    },
    async del(nick) {
      for (const k of KINDS) await fsp.rm(dataPath(nick, k), { force: true });
      await fsp.rm(metaPath(nick), { force: true });
    },
  };
}

const store = process.env.TURSO_DATABASE_URL
  ? require('./capestore')(require('./db'))
  : process.env.DATABASE_URL
    ? createPgStore(process.env.DATABASE_URL)
    : createFileStore(process.env.DATA_DIR || path.join(__dirname, 'data', 'capes'));

console.log(process.env.TURSO_DATABASE_URL ? '[capes] storage: Turso'
  : process.env.DATABASE_URL ? '[capes] storage: Postgres'
  : '[capes] storage: disco local (dados somem em hosts efemeros!)');

  
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
const { authRouter, adminRouter } = require('./accounts');
app.use('/api/auth', authRouter);
app.use('/admin/api', adminRouter);

// Download usado pelo client do jogo: /cape/<nick>.png, .gif ou .jpg
// A extensao precisa bater com o tipo guardado.
app.get(/^\/cape\/([A-Za-z0-9_]{1,16})\.(png|gif|jpg)$/, readLimiter, async (req, res, next) => {
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

// Info para o site e para o client: tipo, tamanho e URL certa (nao carrega a imagem)
app.get('/api/cape/:nick', readLimiter, async (req, res, next) => {
  try {
    const nick = parseNick(req.params.nick);
    if (!nick) return res.status(400).json({ error: 'Nick invalido (1-16 letras, numeros ou _).' });
    const row = await store.info(nick);
    if (!row) return res.json({ exists: false, updatedAt: null });
    const type = kindOfMime(row.mime);
    res.json({
      exists: true,
      updatedAt: row.updatedAt,
      type,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      url: `/cape/${nick}.${type}`,
    });
  } catch (e) {
    next(e);
  }
});

// Upload: corpo = PNG, GIF ou JPG cru. Primeiro envio devolve a chave de edicao.
app.post(
  '/api/cape/:nick',
  writeLimiter,
  express.raw({ type: ['image/png', 'image/gif', 'image/jpeg'], limit: MAX_BYTES }),
  async (req, res, next) => {
    try {
      const nick = parseNick(req.params.nick);
      if (!nick) return res.status(400).json({ error: 'Nick invalido (1-16 letras, numeros ou _).' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Envie um PNG, GIF ou JPG.' });
      }
      const { kind, error } = validateImage(req.body);
      if (error) return res.status(400).json({ error });
      const { width, height } = imageInfo(req.body, kind);

      const existing = await store.info(nick);
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

      await store.put(nick, req.body, MIME[kind], tokenHash, width, height);
      res.json({ ok: true, nick, token, type: kind, width, height, url: `/cape/${nick}.${kind}` });
    } catch (e) {
      next(e);
    }
  }
);

app.delete('/api/cape/:nick', writeLimiter, async (req, res, next) => {
  try {
    const nick = parseNick(req.params.nick);
    if (!nick) return res.status(400).json({ error: 'Nick invalido.' });
    const existing = await store.info(nick);
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

// WebSocket dos jogos multiplayer e do chat global em /ws
require('./duel').attach(server);