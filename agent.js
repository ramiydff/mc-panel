#!/usr/bin/env node
'use strict';
/*
 * MC Panel Agent — يشتغل على كل جهاز يستضيف السيرفر.
 * يدير عملية ماين كرافت، يبث الكونسول والموارد، ويمرّر اللاعبين عبر السيرفر الوسيط.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { spawn, exec } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'agent.json');

/* الإعداد ============================================================== */

async function firstRun() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, d) =>
    new Promise((r) => rl.question(d ? `${q} [${d}]: ` : `${q}: `, (a) => r(a.trim() || d || '')));

  console.log('\n— إعداد الوكيل لأول مرة —\n');
  const conf = {
    relayHost: await ask('عنوان السيرفر الوسيط'),
    relayPort: Number(await ask('منفذ الأجهزة', '7000')),
    machineId: await ask('معرّف الجهاز (نفس اللي في اللوحة)'),
    token: await ask('المفتاح'),
    localHost: '127.0.0.1',
    localPort: Number(await ask('منفذ ماين كرافت', '25565')),
    serverDir: path.resolve(await ask('مجلد السيرفر', path.join(__dirname, 'server'))),
    javaPath: await ask('مسار جافا', 'java'),
    jarFile: await ask('ملف الجار', 'server.jar'),
    memoryMb: Number(await ask('الرام بالميجا', '4096')),
    extraFlags: [],
    autoStart: (await ask('يشتغل السيرفر تلقائيًا مع الوكيل؟ (y/n)', 'n')).toLowerCase() === 'y',
  };
  rl.close();

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2));
  console.log(`\nحفظت الإعدادات في ${CONFIG_PATH}\n`);
  return conf;
}

let conf;
const saveConf = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2));

/* أدوات ============================================================== */

const ensureDir = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} };

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch (_) {} }
    }
  };
  walk(dir);
  return total;
}

// CRC32 لأرشفة النسخ الاحتياطية
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// كاتب ZIP بسيط (deflate) — بدون مكتبات خارجية
function createZip(outPath, entries, onProgress) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    const central = [];
    let offset = 0;
    let index = 0;
    const write = (buf) => new Promise((r) => { offset += buf.length; out.write(buf, r); });

    (async () => {
      for (const e of entries) {
        let data;
        try { data = fs.readFileSync(e.abs); } catch (_) { continue; }
        const crc = crc32(data);
        const comp = zlib.deflateRawSync(data, { level: 6 });
        const nameBuf = Buffer.from(e.rel.replace(/\\/g, '/'), 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        const headerOffset = offset;
        await write(local); await write(nameBuf); await write(comp);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(0, 12);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(comp.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(headerOffset, 42);
        central.push(Buffer.concat([cd, nameBuf]));

        if (onProgress && ++index % 40 === 0) onProgress(index, entries.length);
      }

      const cdStart = offset;
      for (const c of central) await write(c);

      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(offset - cdStart, 12);
      end.writeUInt32LE(cdStart, 16);
      await write(end);

      out.end(() => resolve());
    })().catch(reject);

    out.on('error', reject);
  });
}

/* حالة السيرفر ============================================================== */

const server = {
  proc: null,
  phase: 'stopped', // stopped | starting | running | stopping
  startedAt: null,
  players: new Set(),
  maxPlayers: null,
  version: null,
  errors: 0,
  warnings: 0,
  lastDoneMs: null,
};

const LOG_KEEP = 800;
const logBuffer = [];
let logSeq = 0;
let pendingLines = [];

const LEVEL_RE = /\/(INFO|WARN|ERROR|FATAL|DEBUG)\]/i;
const JOIN_RE = /:\s+([A-Za-z0-9_]{1,16}) joined the game/;
const LEAVE_RE = /:\s+([A-Za-z0-9_]{1,16}) left the game/;
const DONE_RE = /Done \(([\d.]+)s\)/;
const VER_RE = /Starting minecraft server version ([^\s,]+)/;
const MAX_RE = /max(?:imum)? players.*?(\d+)/i;

function pushLog(text, stream) {
  const clean = String(text).replace(/\r/g, '').trimEnd();
  if (!clean) return;

  let level = stream === 'stderr' ? 'ERROR' : 'INFO';
  const m = clean.match(LEVEL_RE);
  if (m) level = m[1].toUpperCase();
  if (/exception|error|failed|caused by/i.test(clean) && level === 'INFO') level = 'ERROR';

  if (level === 'ERROR' || level === 'FATAL') server.errors++;
  if (level === 'WARN') server.warnings++;

  const join = clean.match(JOIN_RE);
  if (join) server.players.add(join[1]);
  const leave = clean.match(LEAVE_RE);
  if (leave) server.players.delete(leave[1]);
  const ver = clean.match(VER_RE);
  if (ver) server.version = ver[1];
  const max = clean.match(MAX_RE);
  if (max) server.maxPlayers = Number(max[1]);
  const done = clean.match(DONE_RE);
  if (done) {
    server.phase = 'running';
    server.lastDoneMs = Math.round(parseFloat(done[1]) * 1000);
  }

  const entry = { i: ++logSeq, t: Date.now(), level, text: clean };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_KEEP) logBuffer.shift();
  pendingLines.push(entry);
}

function startServer() {
  if (server.proc) return { ok: false, error: 'السيرفر شغّال بالفعل' };
  ensureDir(conf.serverDir);
  const jar = path.join(conf.serverDir, conf.jarFile);
  if (!fs.existsSync(jar)) return { ok: false, error: `ما لقيت ${conf.jarFile} في ${conf.serverDir}` };

  const args = [
    `-Xms${Math.min(1024, conf.memoryMb)}M`,
    `-Xmx${conf.memoryMb}M`,
    ...(conf.extraFlags || []),
    '-jar', conf.jarFile, 'nogui',
  ];

  server.errors = 0;
  server.warnings = 0;
  server.players.clear();
  server.phase = 'starting';
  server.startedAt = Date.now();
  pushLog(`>> تشغيل: ${conf.javaPath} ${args.join(' ')}`, 'panel');

  const proc = spawn(conf.javaPath, args, { cwd: conf.serverDir });
  server.proc = proc;

  const attach = (stream, name) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        pushLog(buf.slice(0, i), name);
        buf = buf.slice(i + 1);
      }
      if (buf.length > 8192) { pushLog(buf, name); buf = ''; }
    });
  };
  attach(proc.stdout, 'stdout');
  attach(proc.stderr, 'stderr');

  proc.on('exit', (code, signal) => {
    pushLog(`>> توقّف السيرفر (كود ${signal ?? code})`, 'panel');
    server.proc = null;
    server.phase = 'stopped';
    server.players.clear();
    server.startedAt = null;
  });
  proc.on('error', (e) => {
    pushLog(`>> فشل التشغيل: ${e.message}`, 'panel');
    server.proc = null;
    server.phase = 'stopped';
  });

  return { ok: true };
}

function stopServer(force) {
  if (!server.proc) return { ok: false, error: 'السيرفر متوقف أصلًا' };
  if (force) {
    pushLog('>> إيقاف قسري', 'panel');
    server.proc.kill('SIGKILL');
    return { ok: true };
  }
  server.phase = 'stopping';
  pushLog('>> إرسال أمر stop — بانتظار الحفظ', 'panel');
  try { server.proc.stdin.write('stop\n'); } catch (_) {}
  const proc = server.proc;
  setTimeout(() => {
    if (server.proc === proc) {
      pushLog('>> ما استجاب خلال ٤٥ ثانية — إنهاء قسري', 'panel');
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  }, 45000);
  return { ok: true };
}

function sendCommand(text) {
  if (!server.proc) return { ok: false, error: 'السيرفر متوقف' };
  const line = String(text).replace(/^\//, '').trim();
  if (!line) return { ok: false, error: 'أمر فارغ' };
  pushLog(`> ${line}`, 'panel');
  try { server.proc.stdin.write(line + '\n'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

/* الموارد ============================================================== */

let cpuCache = { pct: 0, at: 0, prev: null };
let diskCache = { bytes: 0, at: 0 };

function procStats(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    if (process.platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        const utime = Number(fields[11]);
        const stime = Number(fields[12]);
        const ticks = utime + stime;
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const rssKb = Number((status.match(/VmRSS:\s+(\d+)/) || [])[1] || 0);
        const now = Date.now();
        let pct = cpuCache.pct;
        if (cpuCache.prev) {
          const dt = (now - cpuCache.prev.at) / 1000;
          const dTicks = ticks - cpuCache.prev.ticks;
          if (dt > 0) pct = Math.max(0, Math.min(100, (dTicks / 100 / dt) * 100 / os.cpus().length));
        }
        cpuCache.prev = { ticks, at: now };
        cpuCache.pct = pct;
        return resolve({ cpu: pct, rssMb: rssKb / 1024 });
      } catch (_) { return resolve(null); }
    }
    const cmd = process.platform === 'win32'
      ? `wmic process where ProcessId=${pid} get WorkingSetSize /value`
      : `ps -o %cpu=,rss= -p ${pid}`;
    exec(cmd, { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      if (process.platform === 'win32') {
        const bytes = Number((stdout.match(/WorkingSetSize=(\d+)/) || [])[1] || 0);
        return resolve({ cpu: null, rssMb: bytes / 1048576 });
      }
      const parts = stdout.trim().split(/\s+/);
      resolve({ cpu: Number(parts[0]) / os.cpus().length, rssMb: Number(parts[1]) / 1024 });
    });
  });
}

async function collectStats() {
  const p = server.proc ? await procStats(server.proc.pid) : null;
  if (Date.now() - diskCache.at > 60000) {
    diskCache = { bytes: dirSize(conf.serverDir), at: Date.now() };
  }
  return {
    phase: server.phase,
    version: server.version,
    startedAt: server.startedAt,
    players: [...server.players],
    maxPlayers: server.maxPlayers,
    errors: server.errors,
    warnings: server.warnings,
    bootMs: server.lastDoneMs,
    cpu: p?.cpu ?? null,
    ramMb: p?.rssMb ?? null,
    ramLimitMb: conf.memoryMb,
    host: {
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      load1: os.loadavg()[0],
      totalMb: os.totalmem() / 1048576,
      freeMb: os.freemem() / 1048576,
      platform: `${os.type()} ${os.release()}`,
      uptimeS: os.uptime(),
    },
    diskMb: diskCache.bytes / 1048576,
  };
}

/* الملفات والمودات ============================================================== */

const ADDON_DIRS = ['mods', 'plugins', 'datapacks'];

function safeJoin(base, rel) {
  const full = path.resolve(base, rel || '.');
  if (!full.startsWith(path.resolve(base))) throw new Error('مسار غير مسموح');
  return full;
}

function listAddons() {
  const out = {};
  for (const d of ADDON_DIRS) {
    const dir = path.join(conf.serverDir, d);
    if (!fs.existsSync(dir)) continue;
    out[d] = fs.readdirSync(dir)
      .filter((f) => /\.jar(\.disabled)?$|\.zip$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          file: f,
          name: f.replace(/\.disabled$/, ''),
          enabled: !f.endsWith('.disabled'),
          sizeMb: st.size / 1048576,
          at: st.mtimeMs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

function toggleAddon(dir, file) {
  if (!ADDON_DIRS.includes(dir)) throw new Error('مجلد غير مسموح');
  const base = path.join(conf.serverDir, dir);
  const from = safeJoin(base, file);
  const to = file.endsWith('.disabled')
    ? from.replace(/\.disabled$/, '')
    : from + '.disabled';
  fs.renameSync(from, to);
  return { file: path.basename(to) };
}

function deleteAddon(dir, file) {
  if (!ADDON_DIRS.includes(dir)) throw new Error('مجلد غير مسموح');
  fs.unlinkSync(safeJoin(path.join(conf.serverDir, dir), file));
  return { ok: true };
}

function readProperties() {
  const f = path.join(conf.serverDir, 'server.properties');
  if (!fs.existsSync(f)) return { values: {} };
  const raw = fs.readFileSync(f, 'utf8').split('\n');
  const values = {};
  for (const line of raw) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) values[m[1].trim()] = m[2];
  }
  return { values };
}

function writeProperties(patch) {
  const f = path.join(conf.serverDir, 'server.properties');
  const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : [];
  const seen = new Set();
  const next = raw.map((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) return line;
    const key = m[1].trim();
    if (key in patch) { seen.add(key); return `${key}=${patch[key]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(patch)) if (!seen.has(k)) next.push(`${k}=${v}`);
  fs.writeFileSync(f, next.join('\n'));
  return { ok: true };
}

function listBackups() {
  const dir = path.join(conf.serverDir, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, sizeMb: st.size / 1048576, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

let backupRunning = false;
async function makeBackup() {
  if (backupRunning) return { ok: false, error: 'في نسخة قيد التنفيذ' };
  backupRunning = true;
  const dir = path.join(conf.serverDir, 'backups');
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(dir, `backup-${stamp}.zip`);

  const entries = [];
  const worlds = fs.readdirSync(conf.serverDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^world/i.test(d.name))
    .map((d) => d.name);

  const walk = (abs, rel) => {
    for (const it of fs.readdirSync(abs, { withFileTypes: true })) {
      if (it.isDirectory()) walk(path.join(abs, it.name), rel + '/' + it.name);
      else entries.push({ abs: path.join(abs, it.name), rel: rel + '/' + it.name });
    }
  };
  for (const w of worlds) walk(path.join(conf.serverDir, w), w);
  for (const f of ['server.properties', 'ops.json', 'whitelist.json']) {
    const abs = path.join(conf.serverDir, f);
    if (fs.existsSync(abs)) entries.push({ abs, rel: f });
  }

  if (!entries.length) { backupRunning = false; return { ok: false, error: 'ما لقيت عالم للنسخ' }; }

  if (server.proc) sendCommand('save-all flush');
  pushLog(`>> بدأت نسخة احتياطية (${entries.length} ملف)`, 'panel');

  try {
    await createZip(out, entries, (i, n) => {
      if (i % 200 === 0) pushLog(`>> النسخ: ${i}/${n}`, 'panel');
    });
    const size = fs.statSync(out).size / 1048576;
    pushLog(`>> النسخة خلصت: ${path.basename(out)} (${size.toFixed(1)} م.ب)`, 'panel');
    backupRunning = false;
    return { ok: true, file: path.basename(out), sizeMb: size };
  } catch (e) {
    backupRunning = false;
    pushLog(`>> النسخة فشلت: ${e.message}`, 'panel');
    return { ok: false, error: e.message };
  }
}

/* الاتصال باللوحة ============================================================== */

let control = null;
let backoff = 1000;

function send(obj) {
  if (!control || control.destroyed) return;
  try { control.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

function probeLocal() {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.createConnection({ host: conf.localHost, port: conf.localPort });
    const done = (ok) => { s.destroy(); resolve(ok ? Date.now() - started : null); };
    s.setTimeout(3000);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

async function handleRequest(msg) {
  const { id, action, payload = {} } = msg;
  const reply = (ok, data) => send({ type: 'res', id, ok, ...(ok ? { data } : { error: data }) });

  try {
    switch (action) {
      case 'server.start': { const r = startServer(); return reply(r.ok, r.ok ? {} : r.error); }
      case 'server.stop': { const r = stopServer(payload.force); return reply(r.ok, r.ok ? {} : r.error); }
      case 'server.restart': {
        if (server.proc) {
          stopServer(false);
          const wait = setInterval(() => {
            if (!server.proc) { clearInterval(wait); startServer(); }
          }, 1000);
          setTimeout(() => clearInterval(wait), 60000);
        } else startServer();
        return reply(true, {});
      }
      case 'server.command': { const r = sendCommand(payload.text); return reply(r.ok, r.ok ? {} : r.error); }
      case 'log.history': return reply(true, { lines: logBuffer.slice(-Number(payload.limit || 400)) });
      case 'stats': return reply(true, await collectStats());
      case 'addons.list': return reply(true, { dirs: listAddons() });
      case 'addons.toggle': return reply(true, toggleAddon(payload.dir, payload.file));
      case 'addons.delete': return reply(true, deleteAddon(payload.dir, payload.file));
      case 'addons.upload': {
        const dir = ADDON_DIRS.includes(payload.dir) ? payload.dir : 'mods';
        const target = path.join(conf.serverDir, dir);
        ensureDir(target);
        const name = path.basename(String(payload.name || 'upload.jar')).replace(/[^\w.\- ]/g, '_');
        fs.writeFileSync(path.join(target, name), Buffer.from(String(payload.data || ''), 'base64'));
        pushLog(`>> رُفع ${dir}/${name}`, 'panel');
        return reply(true, { ok: true });
      }
      case 'props.read': return reply(true, readProperties());
      case 'props.write': return reply(true, writeProperties(payload.patch || {}));
      case 'backup.list': return reply(true, { backups: listBackups() });
      case 'backup.create': { const r = await makeBackup(); return reply(r.ok, r.ok ? r : r.error); }
      case 'backup.delete': {
        fs.unlinkSync(safeJoin(path.join(conf.serverDir, 'backups'), payload.file));
        return reply(true, { ok: true });
      }
      case 'config.read':
        return reply(true, {
          serverDir: conf.serverDir, javaPath: conf.javaPath, jarFile: conf.jarFile,
          memoryMb: conf.memoryMb, extraFlags: conf.extraFlags || [],
          autoStart: !!conf.autoStart, localPort: conf.localPort,
        });
      case 'config.write': {
        for (const k of ['serverDir', 'javaPath', 'jarFile', 'memoryMb', 'autoStart', 'localPort']) {
          if (payload[k] !== undefined) conf[k] = payload[k];
        }
        if (Array.isArray(payload.extraFlags)) conf.extraFlags = payload.extraFlags;
        saveConf();
        return reply(true, { ok: true });
      }
      default: return reply(false, 'إجراء غير معروف: ' + action);
    }
  } catch (e) {
    reply(false, e.message);
  }
}

function openDataChannel(connId, purpose, meta) {
  // على وضع WebSocket (Render) ما فيه قناة بيانات TCP خام — الرفع يمر عبر قناة التحكم بدلها.
  if (conf.relayWsUrl) return;
  let up;
  try {
    up = net.createConnection({ host: conf.relayHost, port: conf.relayPort });
  } catch (e) {
    console.error('فشل فتح قناة البيانات:', e.message);
    return;
  }
  up.on('error', () => up.destroy());
  up.once('connect', () => {
    up.write(JSON.stringify({ type: 'data', machineId: conf.machineId, token: conf.token, connId }) + '\n');

    if (purpose === 'upload') {
      const dir = ADDON_DIRS.includes(meta.dir) ? meta.dir : 'mods';
      const target = path.join(conf.serverDir, dir);
      ensureDir(target);
      const name = path.basename(String(meta.name || 'upload.jar')).replace(/[^\w.\- ]/g, '_');
      const file = fs.createWriteStream(path.join(target, name));
      up.pipe(file);
      up.on('close', () => pushLog(`>> رُفع ${dir}/${name}`, 'panel'));
      return;
    }

    const local = net.createConnection({ host: conf.localHost, port: conf.localPort });
    local.on('error', () => { up.destroy(); local.destroy(); });
    local.once('connect', () => { up.pipe(local); local.pipe(up); });
    up.on('close', () => local.destroy());
    local.on('close', () => up.destroy());
  });
}

function connectTcp() {
  const sock = net.createConnection({ host: conf.relayHost, port: conf.relayPort });
  let beat = null, flush = null, alive = false;
  control = sock;

  sock.on('connect', async () => {
    alive = true; backoff = 1000;
    const latencyMs = await probeLocal();
    send({
      type: 'control', machineId: conf.machineId, token: conf.token,
      serverUp: latencyMs !== null, agentVersion: 2, phase: server.phase,
    });
    console.log('متصل باللوحة —', conf.relayHost);

    beat = setInterval(async () => {
      const ms = await probeLocal();
      send({ type: 'beat', serverUp: ms !== null, latencyMs: ms, stats: await collectStats() });
    }, 3000);

    flush = setInterval(() => {
      if (!pendingLines.length) return;
      const lines = pendingLines.splice(0, 120);
      send({ type: 'log', lines });
    }, 300);
  });

  let buffer = '';
  sock.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      handleControlMessage(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
    if (buffer.length > 1e6) buffer = '';
  });

  const retry = () => {
    clearInterval(beat); clearInterval(flush);
    if (alive) console.log('انقطع الاتصال — إعادة المحاولة...');
    alive = false; control = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };

  sock.on('error', (e) => { if (!alive) console.error('تعذّر الاتصال:', e.code || e.message); });
  sock.once('close', retry);
}

function handleControlMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (msg.type === 'open') openDataChannel(msg.connId, msg.purpose, msg.meta || {});
  else if (msg.type === 'req') handleRequest(msg);
  else if (msg.type === 'hello') {
    console.log(`مسجّل باسم «${msg.name}»`);
    if (conf.autoStart && !server.proc) startServer();
  } else if (msg.type === 'error') console.error('خطأ من اللوحة:', msg.message);
}

function connectWs() {
  const { WebSocket } = require('ws');
  const ws = new WebSocket(conf.relayWsUrl);
  let beat = null, flush = null, alive = false;
  control = {
    destroyed: false,
    write: (str) => ws.send(str),
  };

  ws.on('open', async () => {
    alive = true; backoff = 1000;
    const latencyMs = await probeLocal();
    send({
      type: 'control', machineId: conf.machineId, token: conf.token,
      serverUp: latencyMs !== null, agentVersion: 2, phase: server.phase,
    });
    console.log('متصل باللوحة (WebSocket) —', conf.relayWsUrl);

    beat = setInterval(async () => {
      const ms = await probeLocal();
      send({ type: 'beat', serverUp: ms !== null, latencyMs: ms, stats: await collectStats() });
    }, 3000);

    flush = setInterval(() => {
      if (!pendingLines.length) return;
      const lines = pendingLines.splice(0, 120);
      send({ type: 'log', lines });
    }, 300);
  });

  ws.on('message', (data) => handleControlMessage(data.toString('utf8')));

  const retry = () => {
    clearInterval(beat); clearInterval(flush);
    if (alive) console.log('انقطع الاتصال — إعادة المحاولة...');
    alive = false; control.destroyed = true; control = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };

  ws.on('error', (e) => { if (!alive) console.error('تعذّر الاتصال:', e.message); });
  ws.once('close', retry);
}

function connect() {
  // ملاحظة: على Render ما فيه منفذ TCP خام للاعبين — قناة اللاعبين المباشرة (openDataChannel)
  // ما تنستخدم بوضع WebSocket، لأنه اللاعبون يتصلون مباشرة على هالجهاز.
  if (conf.relayWsUrl) connectWs();
  else connectTcp();
}

process.on('SIGINT', () => {
  if (server.proc) { console.log('\nإيقاف سيرفر ماين كرافت...'); stopServer(false); setTimeout(() => process.exit(0), 500); }
  else process.exit(0);
});

(async () => {
  conf = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : await firstRun();
  conf.serverDir = path.resolve(conf.serverDir || path.join(__dirname, 'server'));
  ensureDir(conf.serverDir);
  connect();
})();
