'use strict';

/**
 * Cliente do Turso (libSQL). Variaveis de ambiente:
 *   TURSO_DATABASE_URL  ex.: libsql://meu-banco-usuario.turso.io
 *   TURSO_AUTH_TOKEN    token do banco (segredo: so no Render, nunca no git)
 * Para testar local sem conta: TURSO_DATABASE_URL=file:local.db
 */
const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error('TURSO_DATABASE_URL e obrigatoria (banco Turso).');

// remoto usa a build "web" (JS puro, sem modulo nativo); file: so em desenvolvimento
const { createClient } = url.startsWith('file:') ? require('@libsql/client') : require('@libsql/client/web');

module.exports = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });