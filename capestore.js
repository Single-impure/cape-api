'use strict';

/** Armazenamento das capas no Turso (mesma interface do Postgres/arquivo do server.js). */
module.exports = function createTursoStore(db) {
  const ready = db.batch(
    [
      `CREATE TABLE IF NOT EXISTS capes (
         nick       TEXT PRIMARY KEY,
         png        BLOB NOT NULL,
         mime       TEXT NOT NULL DEFAULT 'image/png',
         token_hash TEXT NOT NULL,
         width      INTEGER,
         height     INTEGER,
         bytes      INTEGER,
         updated_at INTEGER NOT NULL
       )`,
    ],
    'write'
  );

  return {
    async info(nick) {
      await ready;
      const r = await db.execute({
        sql: 'SELECT mime, token_hash, updated_at, width, height, bytes FROM capes WHERE nick = ?',
        args: [nick],
      });
      const row = r.rows[0];
      if (!row) return null;
      return {
        mime: row.mime, tokenHash: row.token_hash, updatedAt: Number(row.updated_at),
        width: row.width, height: row.height, bytes: Number(row.bytes),
      };
    },
    async get(nick) {
      await ready;
      const r = await db.execute({ sql: 'SELECT png, mime FROM capes WHERE nick = ?', args: [nick] });
      const row = r.rows[0];
      return row ? { data: Buffer.from(row.png), mime: row.mime } : null;
    },
    async put(nick, data, mime, tokenHash, width, height) {
      await ready;
      // em update o token_hash original e mantido
      await db.execute({
        sql: `INSERT INTO capes (nick, png, mime, token_hash, width, height, bytes, updated_at)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(nick) DO UPDATE SET
                png = excluded.png, mime = excluded.mime, width = excluded.width,
                height = excluded.height, bytes = excluded.bytes, updated_at = excluded.updated_at`,
        args: [nick, data, mime, tokenHash, width, height, data.length, Date.now()],
      });
    },
    async del(nick) {
      await ready;
      await db.execute({ sql: 'DELETE FROM capes WHERE nick = ?', args: [nick] });
    },
  };
};