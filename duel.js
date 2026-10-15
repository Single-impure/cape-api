'use strict';

/**
 * Relay WebSocket para os jogos multiplayer do client (PingPong 1v1, Football, Volei)
 * e para o chat global.
 *
 * Uma "sala" = jogo + servidor Minecraft (ex.: "pingpong|play.exemplo.com").
 * O chat global usa uma sala unica ("chat|global"), compartilhada por todos os usuarios do client.
 *
 * pingpong: cada sala tem no maximo UMA mesa; o dono roda a fisica e as regras e manda o
 *   estado; so o convidado (join) manda "hit"; os demais sao espectadores.
 *
 * football ("world"): cada jogador pode ter 1 gol e 1 bola na sala.
 *   - gset/gdel : o jogador cria/remove o proprio gol (o servidor guarda e repassa).
 *   - ball      : o DONO da bola simula a fisica e manda o estado (o servidor guarda e repassa).
 *   - kick/hold : qualquer jogador interage com a bola de outro; vai so ao dono da bola.
 *   - gscore    : o dono da bola avisa a todos que fez gol (confete + mensagem).
 *   - gone      : o servidor avisa quando alguem sai (some o gol e a bola dele).
 *
 * chat: o client manda { t: 'msg', text }; o servidor sanitiza e repassa
 *   { t: 'msg', who, text } a todos da sala (inclusive ao autor).
 *
 * O servidor NAO simula nada: valida formato/faixas e repassa as mensagens.
 */

const { WebSocketServer } = require('ws');

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const ROOM_RE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const GAME_RE = /^[a-z0-9_]{1,16}$/;

const MAX_CONN_PER_IP = 8;
const MAX_MSG_PER_SEC = 90;

// chat global
const MAX_CHAT_LEN = 200;
const CHAT_COOLDOWN_MS = 800;

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
  fy: [-64, 512], dim: [-10, 10], gw: [1, 30], gh: [1, 10], gd: [0.5, 10],
};
const BALL_SPEC = {
  bx: [-3e7, 3e7], by: [-100, 600], bz: [-3e7, 3e7],
  vx: [-200, 200], vy: [-200, 200], vz: [-200, 200],
  on: [0, 1], dim: [-10, 10], br: [0.04, 0.6],
};
const KICK_SPEC = { dx: [-2, 2], dy: [-2, 2], dz: [-2, 2], sp: [0, 60] };
const HOLD_SPEC = { on: [0, 1], tx: [-3e7, 3e7], ty: [-100, 600], tz: [-3e7, 3e7] };
const SCORE_SPEC = { gx: [-3e7, 3e7], gy: [-100, 600], gz: [-3e7, 3e7] };

// volei (uma quadra por sala; o dono simula a bola e as regras, igual ao pingpong)
const COURT_SPEC = {
  ox: [-3e7, 3e7], oz: [-3e7, 3e7], fx: [-1.01, 1.01], fz: [-1.01, 1.01],
  fy: [-64, 512], dim: [-10, 10], cw: [2, 20], hl: [2, 20], nh: [0.5, 4], br: [0.04, 0.6],
};
const VSTATE_SPEC = {
  bx: [-3e7, 3e7], by: [-100, 600], bz: [-3e7, 3e7],
  vx: [-200, 200], vy: [-200, 200], vz: [-200, 200],
  ph: [0, 3], sa: [0, 99], sb: [0, 99], sv: [0, 1], lt: [-1, 1], tc: [0, 9], pt: [-1, 1], rs: [0, 9],
};
const VHIT_SPEC = { dx: [-2, 2], dy: [-2, 2], dz: [-2, 2], sp: [0, 60], px: [-3e7, 3e7], pz: [-3e7, 3e7] };

/**
 * Config por jogo:
 *  open/state   - (mesa) campos aceitos ao abrir a mesa / no estado do dono
 *  guestMode    - (mesa) true: existe 1 convidado (join/leave) e so ele manda toOwner
 *  toOwner      - (mesa) mensagens que os clients mandam so ao dono (o servidor anexa "from")
 *  world        - true: jogo sem dono unico (cada jogador tem seu gol e sua bola)
 *  chat         - true: sala de chat (so repassa texto sanitizado)
 */
const GAMES = {
  pingpong: { open: TABLE_SPEC, state: STATE_SPEC, guestMode: true, toOwner: { hit: HIT_SPEC }, events: {} },
  football: { world: true },
  volei: { open: COURT_SPEC, state: VSTATE_SPEC, guestMode: false, toOwner: { hit: VHIT_SPEC }, events: {} },
  chat: { chat: true },
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const okName = (v) => (typeof v === 'string' && NAME_RE.test(v) ? v : '');

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
  const rooms = new Map(); // key -> { clients: Set<ws>, table, world }
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

  const findClient = (room, name) => {
    for (const c of room.clients) {
      if (c.meta && c.meta.name === name) return c;
    }
    return null;
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
    if (room.world) {
      const g = room.world.goals.delete(ws.meta.name);
      const b = room.world.balls.delete(ws.meta.name);
      if (g || b) broadcast(room, { t: 'gone', who: ws.meta.name });
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
      room = { clients: new Set(), table: null, world: GAMES[game].world ? { goals: new Map(), balls: new Map() } : null };
      rooms.set(key, room);
    }
    // mesma pessoa reconectando: derruba a conexao antiga
    for (const c of [...room.clients]) {
      if (c.meta && c.meta.name === name) {
        cleanup(c);
        c.terminate();
      }
    }
    // o cleanup pode ter removido a sala (ficou vazia): registra de novo
    if (!rooms.has(key)) rooms.set(key, room);

    ws.meta = { name, key, id: String(nextId++), game, dead: false, lastChat: 0 };
    room.clients.add(ws);
    send(ws, { t: 'welcome', id: ws.meta.id, n: room.clients.size, ...tableInfo(room) });

    // football: manda a quem entrou os gols e as bolas que ja existem
    if (room.world) {
      for (const [n, d] of room.world.goals) send(ws, { t: 'gset', who: n, ...d });
      for (const [n, d] of room.world.balls) send(ws, { t: 'ball', who: n, ...d });
    }
  }

  /** Chat global: so repassa texto sanitizado a todos da sala. */
  function onChatMessage(ws, room, msg) {
    if (msg.t !== 'msg' || typeof msg.text !== 'string') return;
    // remove controles e o caractere de formatacao (§) pra ninguem injetar cor/estilo
    const text = msg.text.replace(/[\u0000-\u001f\u007f\u00a7]/g, '').trim().slice(0, MAX_CHAT_LEN);
    if (!text) return;
    const now = Date.now();
    if (now - (ws.meta.lastChat || 0) < CHAT_COOLDOWN_MS) return send(ws, { t: 'error', m: 'devagar' });
    ws.meta.lastChat = now;
    broadcast(room, { t: 'msg', who: ws.meta.name, text });
  }

  /** Football: gol e bola por jogador. */
  function onWorldMessage(ws, room, msg) {
    const name = ws.meta.name;
    const w = room.world;

    switch (msg.t) {
      case 'gset': {
        const d = pick(msg, GOAL_SPEC);
        if (!d || Math.abs(d.fx * d.fx + d.fz * d.fz - 1) > 0.05) return send(ws, { t: 'error', m: 'gol-invalido' });
        w.goals.set(name, d);
        return broadcast(room, { t: 'gset', who: name, ...d }, ws);
      }

      case 'gdel':
        if (w.goals.delete(name)) broadcast(room, { t: 'gdel', who: name }, ws);
        return;

      case 'ball': {
        const d = pick(msg, BALL_SPEC);
        if (!d) return;
        w.balls.set(name, d);
        return broadcast(room, { t: 'ball', who: name, ...d }, ws);
      }

      case 'kick':
      case 'hold': {
        const target = typeof msg.to === 'string' && NAME_RE.test(msg.to) ? findClient(room, msg.to) : null;
        if (!target || target === ws) return;
        const d = pick(msg, msg.t === 'kick' ? KICK_SPEC : HOLD_SPEC);
        if (d) send(target, { t: msg.t, from: name, ...d });
        return;
      }

      case 'gscore': {
        const d = pick(msg, SCORE_SPEC);
        if (!d) return;
        broadcast(room, { t: 'gscore', who: name, by: okName(msg.by), gown: okName(msg.gown), ...d }, ws);
        return;
      }

      default:
        return;
    }
  }

  function onMessage(ws, msg) {
    const room = rooms.get(ws.meta.key);
    if (!room) return;
    const cfg = GAMES[ws.meta.game];

    if (msg.t === 'ping') return send(ws, { t: 'pong' });
    if (cfg.chat) return onChatMessage(ws, room, msg);
    if (cfg.world) return onWorldMessage(ws, room, msg);

    switch (msg.t) {
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
        // acao de um cliente para o dono (hit)
        if (has(cfg.toOwner, msg.t)) {
          const tb = room.table;
          if (!tb || tb.owner === ws) return;
          if (cfg.guestMode && tb.guest !== ws) return;
          const d = pick(msg, cfg.toOwner[msg.t]);
          if (d) send(tb.owner, { t: msg.t, ...d, from: ws.meta.name });
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