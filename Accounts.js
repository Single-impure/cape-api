'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');

const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');
const badJson = (err, req, res, next) =>
  err && err.type === 'entity.parse.failed' ? res.status(400).json({ error: 'JSON invalido.' }) : next(err);

// So conta tentativas que falharam (status >= 400)
const authLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: 20, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde.' },
});

// ───────────── /api/auth (site e client do jogo) ─────────────

const authRouter = express.Router();
authRouter.use(authLimiter, noStore, express.json({ limit: '2kb' }));

authRouter.post('/login', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await auth.login(str(b.username, 32), str(b.password, 128), str(b.hwid, 64));
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, token: r.token, username: r.username, expiresAt: r.expiresAt, daysLeft: r.daysLeft });
  } catch (e) { next(e); }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    await auth.logout(str((req.body || {}).token, 64));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// o client chama de tempos em tempos: ban/expiracao derrubam o acesso na hora
authRouter.post('/check', async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = await auth.validateSession(str(b.token, 64), str(b.hwid, 64));
    if (!s) return res.status(401).json({ error: 'Sessao invalida.' });
    res.json({ ok: true, username: s.username, expiresAt: s.exp });
  } catch (e) { next(e); }
});
authRouter.use(badJson);

// ───────────── /admin/api (painel do dono) ─────────────
// Protegido por ADMIN_TOKEN (variavel de ambiente no Render, 24+ caracteres aleatorios).

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_OK = ADMIN_TOKEN.length >= 24;
if (!ADMIN_OK) console.warn('[admin] ADMIN_TOKEN ausente ou curto (<24): painel admin DESATIVADO.');
const ADMIN_HASH = ADMIN_OK ? auth.sha256(ADMIN_TOKEN) : null;

function requireAdmin(req, res, next) {
  if (!ADMIN_OK) return res.status(503).json({ error: 'Painel admin desativado.' });
  const m = /^Bearer (.{1,200})$/.exec(req.get('authorization') || '');
  if (!m || !auth.safeEq(auth.sha256(m[1]), ADMIN_HASH)) return res.status(401).json({ error: 'Nao autorizado.' });
  next();
}

const adminRouter = express.Router();
adminRouter.use(adminLimiter, noStore, express.json({ limit: '2kb' }), requireAdmin);

const idOf = (req) => {
  const n = Number(req.params.id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

adminRouter.get('/ping', (req, res) => res.json({ ok: true }));

adminRouter.post('/users', async (req, res, next) => {
  try {
    const b = req.body || {};
    const days = b.days === null || b.days === 0 || b.days === '' || b.days === undefined ? null : Math.floor(Number(b.days));
    if (days !== null && !(days >= 1 && days <= 3650)) return res.status(400).json({ error: 'Dias: 1 a 3650 (ou vazio = vitalicia).' });
    const r = await auth.createUser(str(b.username, 32), str(b.password, 128), days);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, password: r.password });
  } catch (e) { next(e); }
});

adminRouter.delete('/users/:id', async (req, res, next) => {
  try { const id = idOf(req); res.json({ ok: !!id && (await auth.deleteUser(id)) }); } catch (e) { next(e); }
});

adminRouter.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const id = idOf(req);
    const pw = id ? await auth.resetPassword(id) : null;
    if (!pw) return res.status(404).json({ error: 'Usuario nao encontrado.' });
    res.json({ ok: true, password: pw });
  } catch (e) { next(e); }
});

adminRouter.get('/users', async (req, res, next) => {
  try { res.json({ users: await auth.listUsers() }); } catch (e) { next(e); }
});

adminRouter.post('/users/:id/reset-hwid', async (req, res, next) => {
  try { const id = idOf(req); res.json({ ok: !!id && (await auth.resetHwid(id)) }); } catch (e) { next(e); }
});
adminRouter.post('/users/:id/ban', async (req, res, next) => {
  try { const id = idOf(req); res.json({ ok: !!id && (await auth.setBanned(id, true)) }); } catch (e) { next(e); }
});
adminRouter.post('/users/:id/unban', async (req, res, next) => {
  try { const id = idOf(req); res.json({ ok: !!id && (await auth.setBanned(id, false)) }); } catch (e) { next(e); }
});
adminRouter.post('/users/:id/extend', async (req, res, next) => {
  try {
    const id = idOf(req);
    const days = Math.floor(Number((req.body || {}).days));
    if (!id || !(days >= 1 && days <= 3650)) return res.status(400).json({ error: 'Dados invalidos.' });
    res.json({ ok: await auth.extend(id, days) });
  } catch (e) { next(e); }
});
adminRouter.use(badJson);

module.exports = { authRouter, adminRouter };