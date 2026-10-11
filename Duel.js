'use strict';

/**
 * Relay WebSocket para os jogos multiplayer do client (PingPong 1v1 e Football).
 *
 * Uma "sala" = jogo + servidor Minecraft (ex.: "pingpong|play.exemplo.com").
 * Cada sala tem no maximo UM "campo" aberto (mesa / gol): o dono ("owner") roda
 * a fisica e as regras e manda o estado. Os outros clients da sala veem tudo e
 * mandam acoes ao dono:
 *   - pingpong: so o convidado (join) manda "hit"; os demais sao espectadores.
 *   - football: qualquer cliente manda "kick" / "place"; o dono avisa "goal" a todos.
 *
 * O servidor NAO simula nada: valida formato/faixas e repassa as mensagens.
 */

const { WebSocketServer } = require('ws');

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const ROOM_RE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const GAME_RE = /^[a-z0-9_]{1,16}$/;

const MAX_CONN_PER_IP = 8;
const MAX_MSG_PER_SEC = 90;

// faixas aceitas (nome -> [min, max])
const TABLE_SPEC = {
  ox: [-3e7, 3e7], oz: [-3e7, 3e7], fx: [-1.01, 1.01], fz: [-1.01, 1.01],
  fy: [-64, 512], dim: [-10, 10], nh: [0.05, 2], br: [0.02, 0.3],
};
const STATE_SPEC = {
  bu: [-60, 60], bv: [-60, 60], by: [-100, 600],
  vu: [-100, 100], vv: [-100, 100], vy: [-100, 100],
  ph: [0, 4], sa: [0, 99], sb: [0, 99], sv: [0, 1], lh: [-1, 1], rs: [0, 9], pt: [-1, 1],
};
const HIT_SPEC = { au: [-60, 60], av: [-60, 60], sp: [0, 60] };

// football
const GOAL_SPEC = {
  ox: [-3e7, 3e7], oz: [-3e7, 3e7], fx: [-1.01, 1.01], fz: [-1.01, 1.01],
  fy: [-64, 512], dim: [-10, 10], gw: [1, 30], gh: [1, 10], gd: [0.5, 10], br: [0.04, 0.6],
};
const BALL_SPEC = {
  bx: [-3e7, 3e7], by: [-100, 600], bz: [-3e7, 3e7],
  vx: [-200, 200], vy: [-200, 200], vz: [-200, 200], on: [0, 1], gl: [0, 9999],
};
const KICK_SPEC = {
  dx: [-1.5, 1.5], dy: [-1.5, 1.5], dz: [-1.5, 1.5], sp: [0, 60],
  ex: [-3e7, 3e7], ey: [-100, 600], ez: [-3e7, 3e7],
};
const PLACE_SPEC = { px: [-3e7, 3e7], py: [-100, 600], pz: [-3e7, 3e7] };
const GOALEV_SPEC = { gx: [-3e7, 3e7], gy: [-100, 600], gz: [-3e7, 3e7], n: [0, 9999] };

/**
 * Config por jogo:
 *  open/state   - campos aceitos ao abrir o campo / no estado do dono
 *  guestMode    - true: existe 1 convidado (join/leave) e so ele manda toOwner
 *  toOwner      - mensagens que os clients mandam so ao dono (o servidor anexa "from")
 *  events       - mensagens que o dono manda a todos (o servidor valida "who")
 */
const GAMES = {
  pingpong: { open: TABLE_SPEC, state: STATE_SPEC, guestMode: true, toOwner: { hit: HIT_SPEC }, events: {} },
  football: {
    open: GOAL_SPEC, state: BALL_SPEC, guestMode: false,
    toOwner: { kick: KICK_SPEC, place: PLACE_SPEC }, events: { goal: GOALEV_SPEC },
  },
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Copia so as chaves da spec; devolve null se alguma faltar ou estiver fora da faixa. */
function pick(msg, spec) {
  const out = {};
  for (const k of Object.keys(spec)) {
    if (!isNum(msg[k], spec[k][0], spec[k][1])) return null;
    out[k] = msg[k];
  }
  return out;
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 2048 });
  const rooms = new Map(); // key -> { clients: Set<ws>, table: null | { owner, guest, data } }
  const perIp = new Map();
  let nextId = 1;

  const send = (ws, obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const broadcast = (room, obj, except) => {
    const text = JSON.stringify(obj);
    for (const c of room.clients) {
      if (c !== except && c.readyState === 1) c.send(text);
    }
  };

  const tableInfo = (room) => {
    const t = room.table;
    return t
      ? { open: 1, owner: t.owner.meta.name, guest: t.guest ? t.guest.meta.name : '', ...t.data }
      : { open: 0, owner: '', guest: '' };
  };

  function cleanup(ws) {
    if (ws.ipKey) {
      const n = (perIp.get(ws.ipKey) || 1) - 1;
      if (n <= 0) perIp.delete(ws.ipKey);
      else perIp.set(ws.ipKey, n);
      ws.ipKey = null;
    }
    if (!ws.meta) return;
    const room = rooms.get(ws.meta.key);
    ws.meta.dead = true;
    if (!room) return;
    room.clients.delete(ws);
    if (room.table) {
      if (room.table.owner === ws) {
        room.table = null;
        broadcast(room, { t: 'closed' });
      } else if (room.table.guest === ws) {
        room.table.guest = null;
        broadcast(room, { t: 'left', owner: room.table.owner.meta.name });
      }
    }
    if (room.clients.size === 0) rooms.delete(ws.meta.key);
  }

  function onHello(ws, msg) {
    const { name, room: roomName, game } = msg;
    if (typeof name !== 'string' || !NAME_RE.test(name)) return send(ws, { t: 'error', m: 'nick-invalido' });
    if (typeof roomName !== 'string' || !ROOM_RE.test(roomName)) return send(ws, { t: 'error', m: 'sala-invalida' });
    if (typeof game !== 'string' || !GAME_RE.test(game) || !has(GAMES, game)) {
      return send(ws, { t: 'error', m: 'jogo-invalido' });
    }

    const key = `${game}|${roomName.toLowerCase()}`;
    let room = rooms.get(key);
    if (!room) {
      room = { clients: new Set(), table: null };
      rooms.set(key, room);
    }
    // mesma pessoa reconectando: derruba a conexao antiga
    for (const c of [...room.clients]) {
      if (c.meta && c.meta.name === name) {
        cleanup(c);
        c.terminate();
      }
    }
    ws.meta = { name, key, id: String(nextId++), game, dead: false };
    room.clients.add(ws);
    send(ws, { t: 'welcome', id: ws.meta.id, n: room.clients.size, ...tableInfo(room) });
  }

  function onMessage(ws, msg) {
    const room = rooms.get(ws.meta.key);
    if (!room) return;
    const cfg = GAMES[ws.meta.game];

    switch (msg.t) {
      case 'ping':
        return send(ws, { t: 'pong' });

      case 'open': {
        if (room.table) return send(ws, { t: 'error', m: 'mesa-ja-aberta', ...tableInfo(room) });
        const data = pick(msg, cfg.open);
        if (!data || Math.abs(data.fx * data.fx + data.fz * data.fz - 1) > 0.05) {
          return send(ws, { t: 'error', m: 'mesa-invalida' });
        }
        room.table = { owner: ws, guest: null, data };
        return broadcast(room, { t: 'table', ...tableInfo(room) });
      }

      case 'close':
        if (room.table && room.table.owner === ws) {
          room.table = null;
          broadcast(room, { t: 'closed' });
        }
        return;

      case 'join': {
        if (!cfg.guestMode) return send(ws, { t: 'error', m: 'nao-da-pra-entrar' });
        const tb = room.table;
        if (!tb || tb.owner === ws || tb.guest) return send(ws, { t: 'error', m: 'nao-da-pra-entrar' });
        tb.guest = ws;
        return broadcast(room, { t: 'joined', owner: tb.owner.meta.name, guest: ws.meta.name });
      }

      case 'leave':
        if (cfg.guestMode && room.table && room.table.guest === ws) {
          room.table.guest = null;
          broadcast(room, { t: 'left', owner: room.table.owner.meta.name });
        }
        return;

      case 'state': {
        if (!room.table || room.table.owner !== ws) return;
        const s = pick(msg, cfg.state);
        if (s) broadcast(room, { t: 'state', ...s }, ws);
        return;
      }

      default: {
        // acao de um cliente para o dono (hit / kick / place)
        if (has(cfg.toOwner, msg.t)) {
          const tb = room.table;
          if (!tb || tb.owner === ws) return;
          if (cfg.guestMode && tb.guest !== ws) return;
          const d = pick(msg, cfg.toOwner[msg.t]);
          if (d) send(tb.owner, { t: msg.t, ...d, from: ws.meta.name });
          return;
        }
        // evento do dono para todos (goal)
        if (has(cfg.events, msg.t)) {
          if (!room.table || room.table.owner !== ws) return;
          const d = pick(msg, cfg.events[msg.t]);
          if (!d) return;
          const who = typeof msg.who === 'string' && NAME_RE.test(msg.who) ? msg.who : '';
          broadcast(room, { t: msg.t, ...d, who }, ws);
        }
        return;
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    ws.ipKey = fwd || req.socket.remoteAddress || 'unknown';
    const n = (perIp.get(ws.ipKey) || 0) + 1;
    perIp.set(ws.ipKey, n);
    if (n > MAX_CONN_PER_IP) {
      cleanup(ws);
      return ws.close(1008, 'too many connections');
    }

    ws.isAlive = true;
    ws.meta = null;
    ws.on('pong', () => { ws.isAlive = true; });

    const helloTimer = setTimeout(() => { if (!ws.meta) ws.terminate(); }, 10_000);

    let windowStart = Date.now();
    let count = 0;
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; count = 0; }
      if (++count > MAX_MSG_PER_SEC) return ws.terminate();

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      if (!ws.meta) {
        if (msg.t === 'hello') onHello(ws, msg);
        return;
      }
      onMessage(ws, msg);
    });

    ws.on('close', () => { clearTimeout(helloTimer); cleanup(ws); });
    ws.on('error', () => {});
  });

  // heartbeat: o Render derruba conexoes ociosas
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25_000);
  wss.on('close', () => clearInterval(beat));

  return wss;
}

module.exports = { attach };