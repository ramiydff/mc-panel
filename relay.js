#!/usr/bin/env node
'use strict';
/*
 * MC Panel Relay — يشتغل على السيرفر الوسيط (VPS).
 * يوزّع اللاعبين على الجهاز المستضيف، ويشغّل لوحة التحكم.
 */
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// وضع Render: بدون منفذ TCP للاعبين — اللاعبون يتصلون مباشرة على جهاز المضيف.
// اللوحة نفسها تشتغل على منفذ واحد ($PORT) بين HTTP والوكلاء (WebSocket).
const RENDER_MODE = !!process.env.PORT;

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'activity.log.json');

// على Render (وأي بيئة بدون تخزين دائم)، الإعدادات تُقرأ من متغيّر بيئة CONFIG_JSON
// بدل ملف config.json — عشان ما تنكتب أسرار (كلمات مرور، مفاتيح) داخل الكود على GitHub.
let cfg;
if (process.env.CONFIG_JSON) {
  cfg = JSON.parse(process.env.CONFIG_JSON);
} else if (fs.existsSync(CONFIG_PATH)) {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} else {
  console.error('ما لقيت config.json ولا متغيّر CONFIG_JSON — شغّل أولًا: node setup.js');
  process.exit(1);
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)), 500);
}

let activity = [];
try { activity = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch (_) {}

function logEvent(kind, text, actor) {
  activity.unshift({ at: Date.now(), kind, text, actor: actor || 'النظام' });
  activity = activity.slice(0, 300);
  fs.writeFile(LOG_PATH, JSON.stringify(activity), () => {});
  console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${text}`);
  broadcast('activity', { entry: activity[0] });
}

/* الحالة في الذاكرة ====================================================== */

const agents = new Map();   // machineId -> { control, lastBeat, serverUp, stats, remoteIp }
const health = new Map();   // machineId -> { online, latencyMs, lastSeen }
const consoles = new Map(); // machineId -> [lines]
const pendingChannels = new Map();
const pendingRequests = new Map();
const streamClients = new Set();

const machineById = (id) => cfg.machines.find((m) => m.id === id) || null;
const LOG_KEEP = 800;

function pushConsole(machineId, lines) {
  const buf = consoles.get(machineId) || [];
  buf.push(...lines);
  consoles.set(machineId, buf.slice(-LOG_KEEP));
}

function isOnline(m) {
  if (!m) return false;
  if (m.mode === 'agent') {
    const a = agents.get(m.id);
    return !!a && Date.now() - a.lastBeat < 20000 && a.serverUp;
  }
  return !!health.get(m.id)?.online;
}

const isLinked = (m) => {
  const a = agents.get(m.id);
  return !!a && Date.now() - a.lastBeat < 20000;
};

function machineView(m) {
  const h = health.get(m.id) || {};
  const a = agents.get(m.id);
  return {
    id: m.id,
    name: m.name,
    mode: m.mode,
    host: m.mode === 'direct' ? m.host : null,
    port: m.mode === 'direct' ? m.port : m.localPort || 25565,
    online: isOnline(m),
    linked: m.mode === 'agent' ? isLinked(m) : null,
    latencyMs: h.latencyMs ?? null,
    lastSeen: h.lastSeen ?? (a ? a.lastBeat : null),
    active: cfg.activeMachine === m.id,
    lastIp: m.lastIp || null,
    lastActiveAt: m.lastActiveAt || null,
    savedAddresses: m.savedAddresses || [],
    stats: a?.stats || null,
  };
}

/* البث للمتصفح (SSE) ====================================================== */

function broadcast(event, data, machineId) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ machineId, ...data })}\n\n`;
  for (const c of streamClients) {
    try { c.write(payload); } catch (_) { streamClients.delete(c); }
  }
}

/* فحص الأجهزة ====================================================== */

function tcpProbe(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.createConnection({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok ? Date.now() - started : null); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

let downStreak = 0;
async function healthTick() {
  for (const m of cfg.machines) {
    if (m.mode !== 'direct') continue;
    const latency = await tcpProbe(m.host, m.port);
    const prev = health.get(m.id) || {};
    health.set(m.id, {
      online: latency !== null,
      latencyMs: latency,
      lastSeen: latency !== null ? Date.now() : prev.lastSeen ?? null,
    });
  }

  const active = machineById(cfg.activeMachine);
  if (active && !isOnline(active)) {
    downStreak++;
    if (cfg.autoFailover && downStreak >= 3) {
      const backup = cfg.machines.find((m) => m.id !== active.id && isOnline(m));
      if (backup) {
        setActive(backup.id);
        downStreak = 0;
        logEvent('failover', `«${active.name}» وقف، تحوّلت الاستضافة تلقائيًا إلى «${backup.name}»`);
      }
    }
  } else downStreak = 0;
}
setInterval(healthTick, 8000);
healthTick();

function setActive(id) {
  cfg.activeMachine = id;
  const m = machineById(id);
  if (m) m.lastActiveAt = Date.now();
  saveConfig();
}

/* بروتوكول ماين كرافت ====================================================== */

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; bytes.push(b); } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  while (true) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return null;
  }
  return { value: value >>> 0, size: pos - offset };
}

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
};

const mcPacket = (id, ...parts) => {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
};

function offlineResponder(sock, reason) {
  let buf = Buffer.alloc(0);
  let state = 0;
  sock.on('error', () => {});
  sock.setTimeout(15000, () => sock.destroy());
  sock.resume();

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      const len = readVarInt(buf, 0);
      if (!len) return;
      const total = len.size + len.value;
      if (buf.length < total) return;
      const body = buf.subarray(len.size, total);
      buf = buf.subarray(total);
      const pid = readVarInt(body, 0);
      if (!pid) return sock.destroy();

      if (state === 0 && pid.value === 0x00) {
        state = body[body.length - 1] === 2 ? 2 : 1;
        if (state === 2) {
          return sock.end(mcPacket(0x00, mcString(JSON.stringify({ text: reason, color: 'gold' }))));
        }
      } else if (state === 1 && pid.value === 0x00) {
        sock.write(mcPacket(0x00, mcString(JSON.stringify({
          version: { name: 'مستضيف بانتظار', protocol: -1 },
          players: { max: 0, online: 0, sample: [] },
          description: { text: reason, color: 'gold' },
        }))));
      } else if (state === 1 && pid.value === 0x01) {
        sock.write(mcPacket(0x01, body.subarray(pid.size, pid.size + 8)));
        sock.end();
      }
    }
  });
}

/* قنوات الأجهزة ====================================================== */

function openChannel(m, purpose, meta) {
  return new Promise((resolve, reject) => {
    if (m.mode === 'direct' && purpose === 'player') {
      const s = net.createConnection({ host: m.host, port: m.port });
      s.setTimeout(8000);
      s.once('connect', () => { s.setTimeout(0); resolve(s); });
      s.once('timeout', () => { s.destroy(); reject(new Error('timeout')); });
      s.once('error', reject);
      return;
    }
    const agent = agents.get(m.id);
    if (!agent) return reject(new Error('الوكيل غير متصل'));

    const connId = crypto.randomBytes(9).toString('base64url');
    const timer = setTimeout(() => {
      pendingChannels.delete(connId);
      reject(new Error('انتهت مهلة فتح القناة'));
    }, 10000);
    pendingChannels.set(connId, { resolve: (s) => { clearTimeout(timer); resolve(s); } });
    try {
      agent.control.write(JSON.stringify({ type: 'open', connId, purpose, meta }) + '\n');
    } catch (e) { clearTimeout(timer); pendingChannels.delete(connId); reject(e); }
  });
}

function agentRequest(machineId, action, payload, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const agent = agents.get(machineId);
    if (!agent) return reject(new Error('الجهاز غير مرتبط باللوحة'));
    const id = crypto.randomBytes(8).toString('base64url');
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('الجهاز ما رد في الوقت المحدد'));
    }, timeout);
    pendingRequests.set(id, { resolve, reject, timer });
    try {
      agent.control.write(JSON.stringify({ type: 'req', id, action, payload }) + '\n');
    } catch (e) { clearTimeout(timer); pendingRequests.delete(id); reject(e); }
  });
}

/* سيرفر اللاعبين ====================================================== */

let playersOnline = 0;

if (!RENDER_MODE) {
  // وضع محلي/VPS عادي: اللوحة توزّع اللاعبين بنفسها عبر منفذ TCP مخصص.
  net.createServer(async (sock) => {
    sock.pause();
    sock.on('error', () => {});
    const m = machineById(cfg.activeMachine);
    if (!m) return offlineResponder(sock, 'ما في جهاز مستضيف حاليًا — تواصل مع الأدمن');
    if (!isOnline(m)) return offlineResponder(sock, `«${m.name}» غير متصل — انتظر تحويل الاستضافة`);

    let backend;
    try { backend = await openChannel(m, 'player', {}); }
    catch (_) { return offlineResponder(sock, 'ما قدرت أوصل للجهاز المستضيف — جرّب بعد شوي'); }

    if (m.proxyProtocol) {
      const src = (sock.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
      backend.write(`PROXY ${src.includes(':') ? 'TCP6' : 'TCP4'} ${src} 127.0.0.1 ${sock.remotePort} 25565\r\n`);
    }

    playersOnline++;
    const cleanup = () => { playersOnline = Math.max(0, playersOnline - 1); sock.destroy(); backend.destroy(); };
    backend.on('error', cleanup);
    sock.on('close', cleanup);
    backend.on('close', cleanup);
    sock.pipe(backend); backend.pipe(sock); sock.resume();
  }).listen(cfg.ports.players, () => console.log(`منفذ اللاعبين: ${cfg.ports.players}`));
} else {
  console.log('وضع Render: اللاعبون يتصلون مباشرة على عنوان الجهاز المضيف (بدون توزيع عبر اللوحة).');
}

/* سيرفر الوكلاء ====================================================== */

function tokenMatches(machine, token) {
  if (!machine?.token || !token) return false;
  const a = Buffer.from(machine.token), b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// معالجة رسالة تحكم واحدة من وكيل، بعد التحقق من المفتاح.
// conn: واجهة موحّدة {write(str), destroy(), remoteAddress} — تشتغل فوق net.Socket أو WebSocket.
function attachAgentControl(conn, m) {
  agents.get(m.id)?.control.destroy();
  const ip = (conn.remoteAddress || '').replace(/^::ffff:/, '');
  const agent = { control: conn, lastBeat: Date.now(), serverUp: false, stats: null };
  agents.set(m.id, agent);

  if (ip && m.lastIp !== ip) {
    m.lastIp = ip;
    m.ipHistory = [{ ip, at: Date.now() }, ...(m.ipHistory || []).filter((x) => x.ip !== ip)].slice(0, 10);
    saveConfig();
  }
  logEvent('link', `«${m.name}» ارتبط باللوحة`);
  conn.write(JSON.stringify({ type: 'hello', name: m.name }) + '\n');

  const onLine = (raw) => {
    let beat;
    try { beat = JSON.parse(raw); } catch (_) { return; }

    if (beat.type === 'control-init') {
      agent.serverUp = !!beat.serverUp;
      return;
    }
    if (beat.type === 'beat') {
      agent.lastBeat = Date.now();
      const was = agent.serverUp;
      agent.serverUp = !!beat.serverUp;
      agent.stats = beat.stats || null;
      health.set(m.id, { online: agent.serverUp, latencyMs: beat.latencyMs ?? null, lastSeen: Date.now() });
      broadcast('stats', { stats: agent.stats, online: agent.serverUp }, m.id);
      if (was !== agent.serverUp) {
        logEvent('status', `سيرفر «${m.name}» ${agent.serverUp ? 'اشتغل' : 'توقف'}`);
      }
    } else if (beat.type === 'log') {
      pushConsole(m.id, beat.lines);
      broadcast('log', { lines: beat.lines }, m.id);
    } else if (beat.type === 'res') {
      const req = pendingRequests.get(beat.id);
      if (req) {
        clearTimeout(req.timer);
        pendingRequests.delete(beat.id);
        beat.ok ? req.resolve(beat.data) : req.reject(new Error(beat.error || 'فشل'));
      }
    }
  };

  const onClose = () => {
    if (agents.get(m.id) === agent) {
      agents.delete(m.id);
      logEvent('link', `فُقد الاتصال باللوحة «${m.name}»`);
    }
  };

  return { agent, onLine, onClose };
}

if (!RENDER_MODE) {
  // وضع محلي/VPS: قناة تحكم عبر TCP خام على منفذ مخصص (agents port)، مطابقة للتصميم الأصلي.
  net.createServer((sock) => {
    sock.on('error', () => {});
    sock.setTimeout(15000);
    let header = '';

    const onHeader = (chunk) => {
      header += chunk.toString('utf8');
      const nl = header.indexOf('\n');
      if (nl === -1) { if (header.length > 4096) sock.destroy(); return; }
      sock.removeListener('data', onHeader);
      sock.setTimeout(0);

      const rest = Buffer.from(header.slice(nl + 1), 'binary');
      let msg;
      try { msg = JSON.parse(header.slice(0, nl)); } catch (_) { return sock.destroy(); }

      const m = machineById(msg.machineId);
      if (!tokenMatches(m, msg.token)) {
        return sock.end(JSON.stringify({ type: 'error', message: 'مفتاح غير صحيح' }) + '\n');
      }

      if (msg.type === 'data') {
        const pending = pendingChannels.get(msg.connId);
        if (!pending) return sock.destroy();
        pendingChannels.delete(msg.connId);
        if (rest.length) sock.unshift(rest);
        sock.pause();
        return pending.resolve(sock);
      }

      if (msg.type !== 'control') return sock.destroy();

      const conn = {
        write: (str) => sock.write(str),
        destroy: () => sock.destroy(),
        remoteAddress: sock.remoteAddress,
      };
      const { onLine, onClose } = attachAgentControl(conn, m);
      agents.get(m.id).serverUp = !!msg.serverUp;

      let line = '';
      sock.on('data', (d) => {
        line += d.toString('utf8');
        let i;
        while ((i = line.indexOf('\n')) !== -1) {
          onLine(line.slice(0, i));
          line = line.slice(i + 1);
        }
        if (line.length > 2e6) line = '';
      });
      sock.on('close', onClose);
    };

    sock.on('data', onHeader);
    sock.on('timeout', () => sock.destroy());
  }).listen(cfg.ports.agents, () => console.log(`منفذ الأجهزة: ${cfg.ports.agents}`));
}

/* الجلسات ====================================================== */

const sessions = new Map();
const loginAttempts = new Map();

const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function verifyUser(username, password) {
  const u = cfg.users.find((x) => x.username === username);
  if (!u) return null;
  const a = Buffer.from(hashPassword(password, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return u;
}

function sessionOf(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  const s = sessions.get(match[1]);
  if (!s) return null;
  if (Date.now() - s.at > 432e5) { sessions.delete(match[1]); return null; }
  return { ...s, sid: match[1] };
}

// صلاحيات: المالك يقدر على كل شي، الأدمن على التشغيل والكونسول والتحويل
const ADMIN_ALLOWED = new Set([
  'state', 'stream', 'switch', 'release', 'console', 'command', 'password', 'logout',
  'server.start', 'server.stop', 'server.restart', 'server.command',
  'stats', 'log.history', 'addons.list', 'addons.upload', 'addons.toggle', 'addons.delete',
  'backup.list', 'backup.create', 'props.read',
]);

/* الويب ====================================================== */

const sendJSON = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
});

function buildState(user) {
  const active = machineById(cfg.activeMachine);
  const directAddress = active
    ? `${active.lastIp || active.host || '؟'}:${active.mode === 'direct' ? active.port : active.localPort || 25565}`
    : null;
  return {
    me: { username: user.username, role: user.role },
    renderMode: RENDER_MODE,
    address: RENDER_MODE
      ? directAddress
      : cfg.publicAddress + (cfg.ports.players === 25565 ? '' : ':' + cfg.ports.players),
    machines: cfg.machines.map(machineView),
    activeMachine: cfg.activeMachine,
    activeOnline: isOnline(active),
    autoFailover: !!cfg.autoFailover,
    playersOnline,
    users: cfg.users.map((u) => ({ username: u.username, role: u.role })),
    activity: activity.slice(0, 60),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const web = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (!route.startsWith('/api/')) {
    const file = route === '/' ? 'index.html' : route.replace(/[^a-zA-Z0-9._/-]/g, '');
    const full = path.join(ROOT, 'public', file);
    if (!full.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(full)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'text/plain; charset=utf-8' });
    return fs.createReadStream(full).pipe(res);
  }

  if (route === '/api/login' && req.method === 'POST') {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.socket.remoteAddress || '?';
    const gate = loginAttempts.get(ip);
    if (gate?.until > Date.now()) return sendJSON(res, 429, { error: 'محاولات كثيرة — انتظر دقيقة' });
    const { username, password } = await readBody(req);
    const user = verifyUser(String(username || ''), String(password || ''));
    if (!user) {
      const count = (gate?.count || 0) + 1;
      loginAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
      return sendJSON(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    loginAttempts.delete(ip);
    const sid = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, { username: user.username, role: user.role, at: Date.now() });
    res.setHeader('set-cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=432000`);
    return sendJSON(res, 200, { ok: true });
  }

  const user = sessionOf(req);
  if (!user) return sendJSON(res, 401, { error: 'الجلسة منتهية' });

  const deny = () => sendJSON(res, 403, { error: 'هذا الإجراء للمالك فقط' });
  const allowed = (key) => user.role === 'owner' || ADMIN_ALLOWED.has(key);

  /* ---- بث حي ---- */
  if (route === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    streamClients.add(res);
    const beat = setInterval(() => {
      try { res.write(`event: state\ndata: ${JSON.stringify(buildState(user))}\n\n`); }
      catch (_) {}
    }, 3000);
    res.write(`event: state\ndata: ${JSON.stringify(buildState(user))}\n\n`);
    req.on('close', () => { clearInterval(beat); streamClients.delete(res); });
    return;
  }

  if (route === '/api/logout' && req.method === 'POST') {
    sessions.delete(user.sid);
    res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/state') return sendJSON(res, 200, buildState(user));

  /* ---- الكونسول والإدارة عبر الوكيل ---- */
  if (route === '/api/console') {
    const id = url.searchParams.get('machine');
    if (!machineById(id)) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });
    const cached = consoles.get(id) || [];
    if (cached.length) return sendJSON(res, 200, { lines: cached });
    try {
      const data = await agentRequest(id, 'log.history', { limit: 400 });
      pushConsole(id, data.lines || []);
      return sendJSON(res, 200, { lines: data.lines || [] });
    } catch (e) { return sendJSON(res, 200, { lines: [], warning: e.message }); }
  }

  if (route === '/api/agent' && req.method === 'POST') {
    const body = await readBody(req);
    const { machineId, action, payload } = body;
    const m = machineById(machineId);
    if (!m) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });
    if (!allowed(action)) return deny();
    if (action === 'server.command' && !allowed('command')) return deny();

    const NOISY = { 'server.start': 'شغّل السيرفر', 'server.stop': 'أوقف السيرفر', 'server.restart': 'أعاد تشغيل السيرفر' };
    try {
      const data = await agentRequest(machineId, action, payload || {}, action === 'backup.create' ? 120000 : 25000);
      if (NOISY[action]) logEvent('server', `${NOISY[action]} على «${m.name}»`, user.username);
      if (action === 'server.command') logEvent('command', `أمر على «${m.name}»: ${String(payload?.text || '').slice(0, 80)}`, user.username);
      if (action === 'addons.toggle') logEvent('addon', `غيّر حالة ${payload?.file} على «${m.name}»`, user.username);
      if (action === 'addons.delete') logEvent('addon', `حذف ${payload?.file} من «${m.name}»`, user.username);
      return sendJSON(res, 200, { ok: true, data });
    } catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  /* ---- رفع المودات ---- */
  if (route === '/api/upload' && req.method === 'POST') {
    if (!allowed('addons.upload')) return deny();
    const machineId = url.searchParams.get('machine');
    const dir = url.searchParams.get('dir') || 'mods';
    const name = url.searchParams.get('name') || 'upload.jar';
    const m = machineById(machineId);
    if (!m) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });

    if (RENDER_MODE) {
      // وضع Render: ما فيه قناة بيانات TCP خام — نرفع الملف عبر قناة التحكم (base64) بدل ذلك.
      const chunks = [];
      let total = 0;
      req.on('data', (c) => { total += c.length; if (total > 60 * 1024 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', async () => {
        try {
          const data = Buffer.concat(chunks).toString('base64');
          await agentRequest(machineId, 'addons.upload', { dir, name, data }, 60000);
          logEvent('addon', `رفع ${name} إلى «${m.name}»`, user.username);
          return sendJSON(res, 200, { ok: true });
        } catch (e) { return sendJSON(res, 502, { error: e.message }); }
      });
      return;
    }

    try {
      const chan = await openChannel(m, 'upload', { dir, name });
      req.pipe(chan);
      req.on('end', () => setTimeout(() => chan.end(), 100));
      logEvent('addon', `رفع ${name} إلى «${m.name}»`, user.username);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  /* ---- التحويل ---- */
  if (route === '/api/switch' && req.method === 'POST') {
    const { machineId, force } = await readBody(req);
    const target = machineById(machineId);
    if (!target) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });
    if (target.id === cfg.activeMachine) return sendJSON(res, 400, { error: 'مستضيف فعلًا' });
    if (!isOnline(target) && (!force || user.role !== 'owner')) {
      return sendJSON(res, 409, { error: `«${target.name}» ما رد. شغّل السيرفر عليه أول، بعدين حوّل` });
    }
    const previous = machineById(cfg.activeMachine);
    if (previous && isOnline(previous) && !force) {
      return sendJSON(res, 409, {
        needsConfirm: true,
        error: `«${previous.name}» شغّال حاليًا. أوقف السيرفر عليه وتأكد إن العالم تزامن، وإلا بتخسرون تقدم`,
      });
    }
    setActive(target.id);
    downStreak = 0;
    logEvent('switch', `تحوّلت الاستضافة إلى «${target.name}»`, user.username);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/release' && req.method === 'POST') {
    const previous = machineById(cfg.activeMachine);
    cfg.activeMachine = null;
    saveConfig();
    logEvent('switch', `أُوقفت الاستضافة${previous ? ` (كانت على «${previous.name}»)` : ''}`, user.username);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- إدارة (المالك) ---- */
  if (route === '/api/settings' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const { autoFailover } = await readBody(req);
    cfg.autoFailover = !!autoFailover;
    saveConfig();
    logEvent('settings', `التحويل التلقائي ${cfg.autoFailover ? 'مُفعّل' : 'مُعطّل'}`, user.username);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/machines' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const body = await readBody(req);
    const id = String(body.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!id || !body.name) return sendJSON(res, 400, { error: 'المعرّف والاسم مطلوبان' });
    const existing = machineById(id);
    const record = existing || { id, token: crypto.randomBytes(24).toString('base64url'), savedAddresses: [] };
    record.name = String(body.name).slice(0, 40);
    record.mode = body.mode === 'direct' ? 'direct' : 'agent';
    record.proxyProtocol = !!body.proxyProtocol;
    if (record.mode === 'direct') {
      record.host = String(body.host || '').trim();
      record.port = Number(body.port) || 25565;
      if (!record.host) return sendJSON(res, 400, { error: 'الآيبي مطلوب في الوضع المباشر' });
    } else record.localPort = Number(body.port) || 25565;
    if (!existing) cfg.machines.push(record);
    saveConfig();
    logEvent('machine', `${existing ? 'عدّل' : 'أضيف'} جهاز «${record.name}»`, user.username);
    return sendJSON(res, 200, { ok: true, machine: machineView(record), token: record.token });
  }

  if (route === '/api/machines/delete' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const { id } = await readBody(req);
    const m = machineById(id);
    if (!m) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });
    cfg.machines = cfg.machines.filter((x) => x.id !== id);
    if (cfg.activeMachine === id) cfg.activeMachine = null;
    agents.get(id)?.control.destroy();
    agents.delete(id);
    consoles.delete(id);
    saveConfig();
    logEvent('machine', `حذف جهاز «${m.name}»`, user.username);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/machines/token' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const { id, rotate } = await readBody(req);
    const m = machineById(id);
    if (!m) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });
    if (rotate) {
      m.token = crypto.randomBytes(24).toString('base64url');
      saveConfig();
      agents.get(id)?.control.destroy();
      logEvent('machine', `جدّد مفتاح «${m.name}»`, user.username);
    }
    return sendJSON(res, 200, RENDER_MODE
      ? { token: m.token, id: m.id, wsUrl: `wss://${cfg.publicAddress}/agent-ws` }
      : { token: m.token, id: m.id, host: cfg.publicAddress, port: cfg.ports.agents });
  }

  /* ---- دفتر العناوين المحفوظة ---- */
  if (route === '/api/machines/address' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const { id, op, label, host, port, index } = await readBody(req);
    const m = machineById(id);
    if (!m) return sendJSON(res, 404, { error: 'الجهاز غير موجود' });
    m.savedAddresses = m.savedAddresses || [];

    if (op === 'save') {
      const entry = {
        label: String(label || 'بدون اسم').slice(0, 30),
        host: String(host || m.host || m.lastIp || '').trim(),
        port: Number(port) || m.port || 25565,
        at: Date.now(),
      };
      if (!entry.host) return sendJSON(res, 400, { error: 'ما في عنوان للحفظ' });
      m.savedAddresses = [entry, ...m.savedAddresses.filter((a) => a.host !== entry.host)].slice(0, 10);
      logEvent('machine', `حفظ عنوان «${entry.label}» لـ «${m.name}»`, user.username);
    } else if (op === 'use') {
      const entry = m.savedAddresses[index];
      if (!entry) return sendJSON(res, 404, { error: 'العنوان غير موجود' });
      m.mode = 'direct';
      m.host = entry.host;
      m.port = entry.port;
      logEvent('machine', `«${m.name}» صار يستخدم ${entry.host}:${entry.port}`, user.username);
    } else if (op === 'delete') {
      m.savedAddresses.splice(index, 1);
    } else return sendJSON(res, 400, { error: 'عملية غير معروفة' });

    saveConfig();
    return sendJSON(res, 200, { ok: true, savedAddresses: m.savedAddresses });
  }

  if (route === '/api/users' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const { username, password } = await readBody(req);
    const name = String(username || '').trim();
    if (!name || String(password || '').length < 8) return sendJSON(res, 400, { error: 'الاسم وكلمة مرور ٨ أحرف فأكثر مطلوبان' });
    if (cfg.users.some((u) => u.username === name)) return sendJSON(res, 400, { error: 'الاسم مستخدم' });
    const salt = crypto.randomBytes(16).toString('hex');
    cfg.users.push({ username: name, role: 'admin', salt, hash: hashPassword(String(password), salt) });
    saveConfig();
    logEvent('user', `أضيف أدمن «${name}»`, user.username);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/users/delete' && req.method === 'POST') {
    if (user.role !== 'owner') return deny();
    const { username } = await readBody(req);
    const target = cfg.users.find((u) => u.username === username);
    if (!target) return sendJSON(res, 404, { error: 'المستخدم غير موجود' });
    if (target.role === 'owner') return sendJSON(res, 400, { error: 'ما ينحذف حساب المالك' });
    cfg.users = cfg.users.filter((u) => u.username !== username);
    for (const [sid, s] of sessions) if (s.username === username) sessions.delete(sid);
    saveConfig();
    logEvent('user', `حذف أدمن «${username}»`, user.username);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/password' && req.method === 'POST') {
    const { current, next } = await readBody(req);
    if (!verifyUser(user.username, String(current || ''))) return sendJSON(res, 401, { error: 'كلمة المرور الحالية غير صحيحة' });
    if (String(next || '').length < 8) return sendJSON(res, 400, { error: 'كلمة المرور الجديدة يلزم ٨ أحرف على الأقل' });
    const u = cfg.users.find((x) => x.username === user.username);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPassword(String(next), u.salt);
    saveConfig();
    logEvent('user', 'غُيّرت كلمة المرور', user.username);
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'مسار غير معروف' });
});

if (RENDER_MODE) {
  // وضع Render: قناة تحكم الوكلاء عبر WebSocket على نفس منفذ اللوحة (مسار /agent-ws).
  const wss = new WebSocketServer({ server: web, path: '/agent-ws' });
  wss.on('connection', (ws, req) => {
    let attached = null;
    let helloTimer = setTimeout(() => ws.close(), 15000);

    ws.on('message', (data) => {
      if (!attached) {
        clearTimeout(helloTimer);
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch (_) { return ws.close(); }
        const m = machineById(msg.machineId);
        if (!tokenMatches(m, msg.token) || msg.type !== 'control') {
          try { ws.send(JSON.stringify({ type: 'error', message: 'مفتاح غير صحيح' })); } catch (_) {}
          return ws.close();
        }
        const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ip = (forwarded || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const conn = {
          write: (str) => { try { ws.send(str); } catch (_) {} },
          destroy: () => { try { ws.close(); } catch (_) {} },
          remoteAddress: ip,
        };
        attached = attachAgentControl(conn, m);
        attached.agent.serverUp = !!msg.serverUp;
        return;
      }
      attached.onLine(data.toString('utf8'));
    });

    ws.on('close', () => { clearTimeout(helloTimer); if (attached) attached.onClose(); });
    ws.on('error', () => {});
  });
}

const PORT = process.env.PORT || cfg.ports.web;
web.listen(PORT, () => console.log(`اللوحة: http://localhost:${PORT}${RENDER_MODE ? ' (Render)' : ''}`));

process.on('uncaughtException', (e) => console.error('خطأ غير متوقع:', e.message));
