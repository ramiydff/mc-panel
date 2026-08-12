import React from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);
const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ============ أدوات ============ */

const clock = (t) =>
  t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const fmt = (n, d = 0) => (n == null ? '—' : Number(n).toFixed(d));
const ago = (t) => {
  if (!t) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `قبل ${s}ث`;
  if (s < 3600) return `قبل ${Math.floor(s / 60)}د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)}س`;
  return `قبل ${Math.floor(s / 86400)}ي`;
};
const dur = (ms) => {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}س ${m}د` : `${m}د`;
};

async function api(path, opts) {
  const res = await fetch(path, {
    method: opts?.method || 'GET',
    headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error(data.error || `خطأ ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
// نتيجة /api/agent مغلّفة بشكل {ok, data: {...}} — نفكّها هون عشان كل الأماكن اللي تستخدم
// agentCall تاخذ حقول النتيجة مباشرة (زي .dirs أو .backups) بدل ما تلف بـ .data يدويًا.
const agentCall = async (machineId, action, payload) => {
  const r = await api('/api/agent', { method: 'POST', body: { machineId, action, payload } });
  return r.data || {};
};

/* ============ عناصر بيانية ============ */

function Spark({ data, color }) {
  if (!data || !data.length) return null;
  const max = Math.max(...data, 1);
  const pts = data
    .map((v, i) => `${(i / Math.max(data.length - 1, 1)) * 100},${34 - (v / max) * 30}`)
    .join(' ');
  return html`
    <svg viewBox="0 0 100 34" preserveAspectRatio="none">
      <polyline points=${pts} fill="none" stroke=${color} stroke-width="1.6" stroke-linejoin="round"
        vector-effect="non-scaling-stroke" opacity="0.9" />
    </svg>`;
}

function Gauge({ k, value, unit, pct, spark, color, warn }) {
  return html`
    <div className=${'gauge' + (warn ? ' warn' : '')}>
      <div className="k">${k}</div>
      <div className="v">${value}${unit && html`<span className="u">${unit}</span>`}</div>
      ${pct != null && html`<div className="bar"><i style=${{ width: Math.min(100, pct) + '%' }} /></div>`}
      ${spark && html`<${Spark} data=${spark} color=${color || 'var(--torch)'} />`}
    </div>`;
}

/* ============ تسجيل الدخول ============ */

function Login({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/api/login', { method: 'POST', body: { username, password } });
      onLoggedIn();
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  return html`
    <div className="login-wrap">
      <form className="login-card" onSubmit=${submit}>
        <div className="brand" style=${{ marginBottom: 18 }}>لوحة السيرفر</div>
        <div className="stack">
          <input className="inp" placeholder="اسم المستخدم" value=${username}
            onInput=${(e) => setUsername(e.target.value)} autoFocus />
          <input className="inp" type="password" placeholder="كلمة المرور" value=${password}
            onInput=${(e) => setPassword(e.target.value)} />
          ${err && html`<div className="note" style=${{ color: 'var(--rust)' }}>${err}</div>`}
          <button className="btn primary" disabled=${busy} type="submit">${busy ? 'جارٍ الدخول...' : 'دخول'}</button>
        </div>
      </form>
    </div>`;
}

/* ============ التطبيق الرئيسي ============ */

function App() {
  const [authed, setAuthed] = useState(null); // null = checking
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('overview');
  const [sel, setSel] = useState(null);
  const [toast, setToast] = useState(null);
  const say = useCallback((m) => { setToast(m); setTimeout(() => setToast(null), 2800); }, []);
  const esRef = useRef(null);

  useEffect(() => {
    api('/api/state').then((s) => { setState(s); setSel(s.activeMachine || s.machines[0]?.id || null); setAuthed(true); })
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    const es = new EventSource('/api/stream');
    esRef.current = es;
    es.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      setState(data);
      setSel((cur) => cur || data.activeMachine || data.machines[0]?.id || null);
    });
    es.onerror = () => {};
    return () => es.close();
  }, [authed]);

  if (authed === null) return html`<div className="mcp"><style>${CSS}</style></div>`;
  if (!authed) return html`<div className="mcp"><style>${CSS}</style><${Login} onLoggedIn=${() => location.reload()} /></div>`;
  if (!state) return html`<div className="mcp"><style>${CSS}</style></div>`;

  const logout = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

  return html`<${Panel} state=${state} tab=${tab} setTab=${setTab} sel=${sel} setSel=${setSel}
    say=${say} toast=${toast} logout=${logout} />`;
}

/* ============ الواجهة ============ */

const TABS = [
  ['overview', 'نظرة عامة'],
  ['console', 'الكونسول'],
  ['resources', 'الموارد'],
  ['addons', 'المودات'],
  ['server', 'إعدادات السيرفر'],
  ['admin', 'إدارة اللوحة'],
];

function Panel({ state, tab, setTab, sel, setSel, say, toast, logout }) {
  const machine = state.machines.find((m) => m.id === sel) || state.machines[0];
  const activeM = state.machines.find((m) => m.id === state.activeMachine);
  const live = !!(activeM && activeM.online);
  const isOwner = state.me.role === 'owner';
  const errCount = machine?.stats?.errors || 0;
  const picker = tab !== 'overview' && tab !== 'admin';

  return html`
    <div className="mcp">
      <style>${CSS}</style>
      <div className="wrap">
        <div className="top">
          <div className="brand">لوحة السيرفر</div>
          <span className="who">${state.me.username}</span>
          <span className=${'tag' + (isOwner ? ' owner' : '')}>${isOwner ? 'مالك' : 'أدمن'}</span>
          <button className="link-btn" onClick=${logout}>خروج</button>
        </div>

        <div className="tabs">
          ${TABS.map(([k, label]) => html`
            <button key=${k} className=${'tab' + (tab === k ? ' on' : '')} onClick=${() => setTab(k)}>
              ${k === 'console' && errCount > 0 && html`<span className="pip" />`}${label}
            </button>`)}
        </div>

        ${picker && html`
          <${MachinePicker} machines=${state.machines} sel=${sel} setSel=${setSel}
            active=${state.activeMachine} say=${say} />`}

        ${tab === 'overview' && html`<${Overview} state=${state} live=${live} activeM=${activeM} say=${say} setSel=${setSel} setTab=${setTab} />`}
        ${tab === 'console' && machine && html`<${Console} machine=${machine} say=${say} />`}
        ${tab === 'resources' && machine && html`<${Resources} machine=${machine} />`}
        ${tab === 'addons' && machine && html`<${Addons} machine=${machine} say=${say} />`}
        ${tab === 'server' && machine && html`<${ServerSettings} machine=${machine} isOwner=${isOwner} say=${say} />`}
        ${tab === 'admin' && isOwner && html`<${Admin} state=${state} say=${say} />`}

        ${toast && html`<div className="toast good">${toast}</div>`}
      </div>
    </div>`;
}

function MachinePicker({ machines, sel, setSel, active, say }) {
  const machine = machines.find((m) => m.id === sel) || machines[0];
  const [busy, setBusy] = useState(false);

  const run = async (action, force) => {
    setBusy(true);
    try {
      await agentCall(machine.id, action, { force });
      say(action === 'server.start' ? 'تم إرسال أمر التشغيل' : action === 'server.stop' ? 'أُرسل أمر الإيقاف' : 'جارٍ إعادة التشغيل');
    } catch (e) { say(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <div>
      <div className="picker">
        ${machines.map((m) => html`
          <button key=${m.id} className=${'chip' + (m.id === sel ? ' on' : '')} onClick=${() => setSel(m.id)}>
            <span className=${'dot ' + (m.online ? 'on' : m.linked ? 'busy' : 'off')} />${m.name}
          </button>`)}
      </div>
      <div className="card machine" style=${{ marginBottom: 14 }}>
        <div className="info">
          <div className="name">${machine.name}</div>
          <div className="meta">
            ${machine.online ? 'شغّال' : machine.linked ? 'متوقف' : 'غير مرتبط'}
            ${machine.online && machine.stats?.version ? ` · ${machine.stats.version} · ${dur(Date.now() - (machine.stats.startedAt || Date.now()))}` : ''}
          </div>
        </div>
        <button className="btn sm" disabled=${busy || machine.online} onClick=${() => run('server.start')}>تشغيل</button>
        <button className="btn sm" disabled=${busy || !machine.online} onClick=${() => run('server.restart')}>إعادة</button>
        <button className="btn sm danger" disabled=${busy || !machine.online} onClick=${() => run('server.stop')}>إيقاف</button>
      </div>
    </div>`;
}

function Overview({ state, live, activeM, say, setSel, setTab }) {
  const [switching, setSwitching] = useState(false);

  const takeOver = async (m) => {
    setSwitching(true);
    try {
      await api('/api/switch', { method: 'POST', body: { machineId: m.id } });
      say(`الاستضافة صارت على «${m.name}»`);
    } catch (e) {
      if (e.data?.needsConfirm && confirm(e.data.error + '\n\nتأكيد المتابعة؟')) {
        try {
          await api('/api/switch', { method: 'POST', body: { machineId: m.id, force: true } });
          say(`الاستضافة صارت على «${m.name}»`);
        } catch (e2) { say(e2.message); }
      } else say(e.message);
    } finally { setSwitching(false); }
  };

  return html`
    <div>
      <div className="address">
        <span className="lbl">الآيبي اللي يكتبه اللاعبون</span>
        <code>${state.address || '—'}</code>
        <button className="copy" onClick=${() => { navigator.clipboard?.writeText(state.address || ''); say('انتسخ العنوان'); }}>نسخ</button>
      </div>
      ${state.renderMode && html`
        <div className="note" style=${{ marginBottom: 14 }}>
          اللوحة مستضافة على Render — اللاعبون يتصلون مباشرة على عنوان الجهاز المضيف (فوق)، مو على عنوان اللوحة. تأكد إن منفذ ماين كرافت مفتوح على راوتر الجهاز.
        </div>`}

      <section className="rail">
        <div className="rail-title">مسار الاتصال</div>
        <div className="track">
          <div className="node live"><div className="disc">🎮</div><div className="cap">${live ? `${state.playersOnline} متصل` : 'اللاعبون'}</div></div>
          <div className="seg flow" />
          <div className="node live"><div className="disc">🛰️</div><div className="cap">الموزّع</div></div>
          <div className=${'seg ' + (live ? 'flow' : 'broken')} />
          <div className=${'node ' + (live ? 'live' : 'dead')}>
            <div className="disc">${live ? '🟢' : '🖥️'}</div>
            <div className="cap">${activeM ? activeM.name : 'لا يوجد'}</div>
          </div>
        </div>
        <div className=${'verdict ' + (live ? 'up' : 'down')}>
          <span className="big">${activeM ? (live ? `«${activeM.name}» يستضيف الآن` : `«${activeM.name}» لا يرد`) : 'ما في جهاز مستضيف'}</span>
          <span className="sub">${live ? 'اللاعبون يقدرون يدخلون' : 'شغّل السيرفر على جهاز، بعدين حوّل له'}</span>
        </div>
      </section>

      <div className="h2">الأجهزة</div>
      ${state.machines.map((m) => html`
        <div key=${m.id} className=${'card machine' + (m.id === state.activeMachine ? ' is-active' : '')}>
          <div className="info">
            <div className="name"><span className=${'dot ' + (m.online ? 'on' : m.linked ? 'busy' : 'off')} />${m.name}</div>
            <div className="meta">
              ${m.linked === false ? 'غير مرتبط' : 'مرتبط'} · :${m.port}${m.latencyMs ? ` · ${m.latencyMs}ms` : ''} ${m.lastIp ? `· ${m.lastIp}` : ''} · ${m.online ? 'الآن' : ago(m.lastSeen)}
            </div>
            <div className="meta">
              ${m.online ? `شغّال${m.stats ? ` · ${(m.stats.players || []).length} لاعبين · ${m.stats.errors || 0} خطأ` : ''}` : 'متوقف'}
            </div>
          </div>
          ${m.id === state.activeMachine
            ? html`<span className="badge">مستضيف الآن</span>`
            : html`<button className="btn primary" disabled=${switching} onClick=${() => takeOver(m)}>استلم الاستضافة</button>`}
          <button className="btn quiet" onClick=${() => { setSel(m.id); setTab('console'); }}>كونسول</button>
        </div>`)}

      <div className="h2">السجل</div>
      <div className="card">
        <ul className="log">
          ${state.activity.length === 0 && html`<li><span className="d">ما في أحداث بعد.</span></li>`}
          ${state.activity.map((e, i) => html`
            <li key=${i}><time>${clock(e.at)}</time><span>${e.text} <span className="actor">— ${e.actor}</span></span></li>`)}
        </ul>
      </div>
    </div>`;
}

function Console({ machine, say }) {
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [q, setQ] = useState('');
  const [cmd, setCmd] = useState('');
  const [stick, setStick] = useState(true);
  const [history, setHistory] = useState([]);
  const histIdx = useRef(-1);
  const boxRef = useRef(null);
  const esRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLines([]);
    api(`/api/console?machine=${encodeURIComponent(machine.id)}`).then((d) => { if (!cancelled) setLines(d.lines || []); });

    const es = new EventSource('/api/stream');
    esRef.current = es;
    es.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      if (data.machineId !== machine.id) return;
      setLines((p) => [...p, ...data.lines].slice(-1000));
    });
    return () => { cancelled = true; es.close(); };
  }, [machine.id]);

  useEffect(() => {
    if (stick && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, stick]);

  const counts = useMemo(() => {
    const c = { ALL: lines.length, ERROR: 0, WARN: 0, INFO: 0 };
    lines.forEach((l) => c[l.level] !== undefined && c[l.level]++);
    return c;
  }, [lines]);

  const shown = lines.filter(
    (l) => (filter === 'ALL' || l.level === filter) &&
      (!q.trim() || l.text.toLowerCase().includes(q.trim().toLowerCase()))
  );

  const send = async (text) => {
    const t = (text ?? cmd).trim();
    if (!t) return;
    setCmd('');
    setStick(true);
    setHistory((h) => [t, ...h].slice(0, 50));
    histIdx.current = -1;
    try { await agentCall(machine.id, 'server.command', { text: t }); }
    catch (e) { say(e.message); }
  };

  const onKey = (e) => {
    if (e.key === 'Enter') return send();
    if (e.key === 'ArrowUp') {
      if (histIdx.current < history.length - 1) { histIdx.current++; setCmd(history[histIdx.current] || ''); }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (histIdx.current > 0) { histIdx.current--; setCmd(history[histIdx.current] || ''); }
      else { histIdx.current = -1; setCmd(''); }
      e.preventDefault();
    }
  };

  const highlight = (text) => {
    if (!q.trim()) return text;
    const idx = text.toLowerCase().indexOf(q.trim().toLowerCase());
    if (idx === -1) return text;
    return html`${text.slice(0, idx)}<mark>${text.slice(idx, idx + q.trim().length)}</mark>${text.slice(idx + q.trim().length)}`;
  };

  return html`
    <div>
      <div className="console-shell">
        <div className="console-bar">
          ${[['ALL', 'الكل'], ['ERROR', 'أخطاء'], ['WARN', 'تحذيرات'], ['INFO', 'معلومات']].map(([k, l]) => html`
            <button key=${k} className=${'filter' + (filter === k ? ' on' : '')} onClick=${() => setFilter(k)}>
              ${l}<span className="n">${counts[k] || 0}</span>
            </button>`)}
          <input className="search" placeholder="بحث في الكونسول" value=${q} onInput=${(e) => setQ(e.target.value)} />
          <button className=${'filter' + (stick ? ' on' : '')} onClick=${() => setStick(!stick)}>تتبّع</button>
        </div>
        <div className="logbox" ref=${boxRef}
          onScroll=${(e) => { const el = e.target; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}>
          ${shown.map((l) => html`
            <div key=${l.i} className=${'ln ' + l.level}>
              <span className="ts">${clock(l.t)}</span><span className="tx">${highlight(l.text)}</span>
            </div>`)}
        </div>
        <div className="cmdbar">
          <input placeholder=${machine.online ? 'اكتب أمرًا…' : 'السيرفر متوقف'} value=${cmd}
            onInput=${(e) => setCmd(e.target.value)} onKeyDown=${onKey} disabled=${!machine.online} />
          <button className="btn primary" disabled=${!machine.online} onClick=${() => send()}>إرسال</button>
        </div>
      </div>
      <div className="quicks">
        ${['list', 'save-all', 'weather clear', 'time set day', 'difficulty normal'].map((c) => html`
          <button key=${c} className="btn quiet sm" disabled=${!machine.online} onClick=${() => send(c)}>${c}</button>`)}
      </div>
    </div>`;
}

function Resources({ machine }) {
  const [cpu, setCpu] = useState([]);
  const [ram, setRam] = useState([]);
  const s = machine.stats || {};

  useEffect(() => {
    setCpu((p) => [...p, s.cpu ?? 0].slice(-40));
    setRam((p) => [...p, s.ramMb ?? 0].slice(-40));
  }, [s.cpu, s.ramMb]);

  const cpuNow = s.cpu ?? 0;
  const ramNow = s.ramMb ?? 0;
  const host = s.host || {};

  return html`
    <div>
      <div className="gauges">
        <${Gauge} k="المعالج" value=${fmt(cpuNow, 1)} unit="%" pct=${cpuNow} spark=${cpu} color="var(--torch)" warn=${cpuNow > 85} />
        <${Gauge} k="الرام" value=${fmt(ramNow, 0)} unit="م.ب" pct=${(ramNow / (s.ramLimitMb || 4096)) * 100} spark=${ram} color="var(--sky)" />
        <${Gauge} k="اللاعبون" value=${(s.players || []).length} color="var(--moss)" />
        <${Gauge} k="الحالة" value=${machine.online ? 'شغّال' : 'متوقف'} />
      </div>

      <div className="h2">السيرفر</div>
      <div className="card">
        <div className="row">
          <div className="text"><div className="d">الإصدار</div><div className="t">${s.version || '—'}</div></div>
          <div className="text"><div className="d">مدة التشغيل</div><div className="t">${s.startedAt ? dur(Date.now() - s.startedAt) : '—'}</div></div>
        </div>
        <div className="row">
          <div className="text"><div className="d">أخطاء</div><div className="t" style=${{ color: 'var(--rust)' }}>${s.errors ?? 0}</div></div>
          <div className="text"><div className="d">تحذيرات</div><div className="t" style=${{ color: 'var(--torch)' }}>${s.warnings ?? 0}</div></div>
        </div>
        <div className="row">
          <div className="text"><div className="d">زمن الإقلاع</div><div className="t">${s.bootMs ? (s.bootMs / 1000).toFixed(1) + ' ث' : '—'}</div></div>
          <div className="text"><div className="d">حجم مجلد السيرفر</div><div className="t">${s.diskMb ? s.diskMb.toFixed(2) + ' ج.ب' : '—'}</div></div>
        </div>
      </div>

      <div className="h2">اللاعبون المتصلون</div>
      <div className="card">
        ${(s.players || []).length
          ? html`<div className="players">${s.players.map((p) => html`<span key=${p} className="player">${p}</span>`)}</div>`
          : html`<div className="note">ما في أحد داخل الحلم.</div>`}
      </div>

      <div className="h2">الجهاز نفسه</div>
      <div className="card">
        <div className="row"><div className="text"><div className="d">النظام</div><div className="t">${host.platform || '—'}</div></div></div>
        <div className="row"><div className="text"><div className="d">المعالج</div><div className="t" style=${{ fontSize: 13 }}>${host.cpuModel || '—'} × ${host.cpuCount || '—'}</div></div></div>
        <div className="row">
          <div className="text"><div className="d">رام الجهاز</div><div className="t">${host.totalMb ? `${((host.totalMb - host.freeMb) / 1024).toFixed(1)} / ${(host.totalMb / 1024).toFixed(1)} ج.ب` : '—'}</div></div>
          <div className="text"><div className="d">تشغيل الجهاز</div><div className="t">${host.uptimeS ? dur(host.uptimeS * 1000) : '—'}</div></div>
        </div>
      </div>
    </div>`;
}

function Addons({ machine, say }) {
  const [dirs, setDirs] = useState({});
  const [dir, setDir] = useState('mods');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try { const d = await agentCall(machine.id, 'addons.list', {}); setDirs(d.dirs || {}); }
    catch (e) { say(e.message); }
  }, [machine.id]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (d, file) => {
    try { await agentCall(machine.id, 'addons.toggle', { dir: d, file }); load(); }
    catch (e) { say(e.message); }
  };
  const del = async (d, file) => {
    if (!confirm(`حذف ${file}؟`)) return;
    try { await agentCall(machine.id, 'addons.delete', { dir: d, file }); load(); say('انحذف'); }
    catch (e) { say(e.message); }
  };

  const upload = async (file) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/upload?machine=${encodeURIComponent(machine.id)}&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST', body: file,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'فشل الرفع');
      say('رُفع ' + file.name);
      setTimeout(load, 800);
    } catch (e) { say(e.message); }
    finally { setBusy(false); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) upload(f);
  };

  const dirList = (d) => dirs[d] || [];
  const dirLabel = { mods: 'مودات', plugins: 'إضافات', datapacks: 'حزم بيانات' };

  return html`
    <div>
      <div className="card stack">
        <div className="row">
          <div className="text"><div className="t">رفع ملف</div><div className="d">jar للمودات والإضافات، zip لحزم البيانات</div></div>
          <select className="inp" style=${{ width: 'auto' }} value=${dir} onChange=${(e) => setDir(e.target.value)}>
            <option value="mods">mods</option><option value="plugins">plugins</option><option value="datapacks">datapacks</option>
          </select>
        </div>
        <div className="drop" onDragOver=${(e) => e.preventDefault()} onDrop=${onDrop}
          onClick=${() => fileRef.current?.click()}>
          ${busy ? 'جارٍ الرفع…' : 'اسحب الملفات هنا أو اضغط للاختيار'}
        </div>
        <input ref=${fileRef} type="file" style=${{ display: 'none' }}
          onChange=${(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      </div>

      ${['mods', 'plugins', 'datapacks'].map((d) => html`
        <div key=${d}>
          <div className="h2">${dirLabel[d]} — ${dirList(d).length}</div>
          <div className="card">
            ${dirList(d).length === 0 && html`<div className="note">لا يوجد شي هنا.</div>`}
            ${dirList(d).map((a) => html`
              <div key=${a.file} className=${'addon' + (a.enabled ? '' : ' off')}>
                <span className=${'dot ' + (a.enabled ? 'on' : 'off')} />
                <span className="nm">${a.name}</span>
                <span className="note" style=${{ whiteSpace: 'nowrap' }}>${a.sizeMb.toFixed(1)} م.ب</span>
                <button className="btn quiet sm" onClick=${() => toggle(d, a.file)}>${a.enabled ? 'تعطيل' : 'تفعيل'}</button>
                <button className="btn quiet sm" onClick=${() => del(d, a.file)}>حذف</button>
              </div>`)}
          </div>
        </div>`)}
    </div>`;
}

function ServerSettings({ machine, isOwner, say }) {
  const [backups, setBackups] = useState([]);
  const [props, setProps] = useState({});
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, p] = await Promise.all([
        agentCall(machine.id, 'backup.list', {}),
        agentCall(machine.id, 'props.read', {}),
      ]);
      setBackups(b.backups || []);
      setProps(p.values || {});
    } catch (e) { say(e.message); }
  }, [machine.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isOwner) return;
    agentCall(machine.id, 'config.read', {}).then(setCfg).catch(() => {});
  }, [machine.id, isOwner]);

  const doBackup = async () => {
    setBusy(true);
    try { await agentCall(machine.id, 'backup.create', {}); say('بدأت النسخة — تابع الكونسول'); setTimeout(load, 1500); }
    catch (e) { say(e.message); }
    finally { setBusy(false); }
  };
  const delBackup = async (file) => {
    if (!confirm(`حذف ${file}؟`)) return;
    try { await agentCall(machine.id, 'backup.delete', { file }); load(); }
    catch (e) { say(e.message); }
  };

  const PROP_FIELDS = [
    ['motd', 'رسالة السيرفر'], ['max-players', 'أقصى عدد لاعبين'],
    ['difficulty', 'الصعوبة'], ['view-distance', 'مدى الرؤية'], ['pvp', 'قتال اللاعبين'],
  ];
  const [edited, setEdited] = useState({});
  const saveProps = async () => {
    if (!Object.keys(edited).length) return;
    try { await agentCall(machine.id, 'props.write', { patch: edited }); say('انحفظ — تحتاج إعادة تشغيل'); setEdited({}); load(); }
    catch (e) { say(e.message); }
  };

  const [cfgEdit, setCfgEdit] = useState({});
  const saveCfg = async () => {
    try { await agentCall(machine.id, 'config.write', cfgEdit); say('انحفظت إعدادات التشغيل'); setCfgEdit({}); }
    catch (e) { say(e.message); }
  };

  if (!isOwner) {
    return html`
      <div>
        <div className="h2">النسخ الاحتياطية</div>
        <div className="card stack">
          <div className="row">
            <div className="text"><div className="t">نسخة الآن</div><div className="d">تُحفظ في backups داخل مجلد السيرفر</div></div>
            <button className="btn primary" disabled=${busy} onClick=${doBackup}>إنشاء نسخة</button>
          </div>
          ${backups.map((b) => html`
            <div key=${b.file} className="row">
              <div className="text"><div className="t" style=${{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>${b.file}</div>
                <div className="d">${b.sizeMb.toFixed(1)} م.ب · ${ago(b.at)}</div></div>
            </div>`)}
        </div>
      </div>`;
  }

  return html`
    <div>
      <div className="h2">النسخ الاحتياطية</div>
      <div className="card stack">
        <div className="row">
          <div className="text"><div className="t">نسخة الآن</div><div className="d">تُحفظ في backups داخل مجلد السيرفر</div></div>
          <button className="btn primary" disabled=${busy} onClick=${doBackup}>إنشاء نسخة</button>
        </div>
        ${backups.length === 0 && html`<div className="note">ما في نسخ بعد.</div>`}
        ${backups.map((b) => html`
          <div key=${b.file} className="row">
            <div className="text"><div className="t" style=${{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>${b.file}</div>
              <div className="d">${b.sizeMb.toFixed(1)} م.ب · ${ago(b.at)}</div></div>
            <button className="btn quiet sm" onClick=${() => delBackup(b.file)}>حذف</button>
          </div>`)}
      </div>

      <div className="h2">إعدادات اللعبة</div>
      <div className="card stack">
        ${PROP_FIELDS.map(([k, label]) => html`
          <div key=${k} className="row">
            <div className="text"><div className="t">${label}</div><div className="d" style=${{ fontFamily: 'var(--mono)', fontSize: 11 }}>${k}</div></div>
            <input className="inp" style=${{ width: 170 }} defaultValue=${props[k] ?? ''}
              onInput=${(e) => setEdited((p) => ({ ...p, [k]: e.target.value }))} />
          </div>`)}
        <button className="btn primary" style=${{ justifySelf: 'start' }} onClick=${saveProps}>حفظ</button>
      </div>

      <div className="h2">تشغيل السيرفر</div>
      <div className="card stack">
        ${cfg ? html`
          <div className="two">
            <div><div className="note">مجلد السيرفر</div><input className="inp" defaultValue=${cfg.serverDir}
              onInput=${(e) => setCfgEdit((p) => ({ ...p, serverDir: e.target.value }))} /></div>
            <div><div className="note">ملف الجار</div><input className="inp" defaultValue=${cfg.jarFile}
              onInput=${(e) => setCfgEdit((p) => ({ ...p, jarFile: e.target.value }))} /></div>
          </div>
          <div className="three">
            <div><div className="note">مسار جافا</div><input className="inp" defaultValue=${cfg.javaPath}
              onInput=${(e) => setCfgEdit((p) => ({ ...p, javaPath: e.target.value }))} /></div>
            <div><div className="note">الرام (م.ب)</div><input className="inp" defaultValue=${cfg.memoryMb}
              onInput=${(e) => setCfgEdit((p) => ({ ...p, memoryMb: Number(e.target.value) }))} /></div>
            <div><div className="note">منفذ اللعبة</div><input className="inp" defaultValue=${cfg.localPort}
              onInput=${(e) => setCfgEdit((p) => ({ ...p, localPort: Number(e.target.value) }))} /></div>
          </div>
          <div className="row">
            <div className="text"><div className="t">تشغيل تلقائي</div><div className="d">يشغّل السيرفر أول ما يرتبط الجهاز باللوحة</div></div>
            <button className=${'switch' + (cfg.autoStart ? ' on' : '')}
              onClick=${() => setCfgEdit((p) => ({ ...p, autoStart: !(p.autoStart ?? cfg.autoStart) }))} />
          </div>
          <button className="btn primary" style=${{ justifySelf: 'start' }} onClick=${saveCfg}>حفظ إعدادات التشغيل</button>
        ` : html`<div className="note">جارٍ التحميل…</div>`}
      </div>
    </div>`;
}

function Admin({ state, say }) {
  const [auto, setAuto] = useState(state.autoFailover);
  const [newUser, setNewUser] = useState({ username: '', password: '' });
  const [newMachine, setNewMachine] = useState({ id: '', name: '', mode: 'agent', host: '', port: 25565 });
  const [tokenView, setTokenView] = useState(null);

  const toggleAuto = async () => {
    const next = !auto;
    setAuto(next);
    try { await api('/api/settings', { method: 'POST', body: { autoFailover: next } }); }
    catch (e) { say(e.message); setAuto(!next); }
  };

  const addUser = async () => {
    try {
      await api('/api/users', { method: 'POST', body: newUser });
      say('انضاف الأدمن'); setNewUser({ username: '', password: '' });
    } catch (e) { say(e.message); }
  };
  const delUser = async (username) => {
    if (!confirm(`حذف ${username}؟`)) return;
    try { await api('/api/users/delete', { method: 'POST', body: { username } }); say('انحذف'); }
    catch (e) { say(e.message); }
  };

  const addMachine = async () => {
    try {
      const r = await api('/api/machines', { method: 'POST', body: newMachine });
      say('انحفظ الجهاز');
      if (newMachine.mode === 'agent') setTokenView({ ...r.machine, token: r.token });
      setNewMachine({ id: '', name: '', mode: 'agent', host: '', port: 25565 });
    } catch (e) { say(e.message); }
  };
  const delMachine = async (id) => {
    if (!confirm('حذف هذا الجهاز نهائيًا؟')) return;
    try { await api('/api/machines/delete', { method: 'POST', body: { id } }); say('انحذف الجهاز'); }
    catch (e) { say(e.message); }
  };
  const rotateToken = async (id) => {
    try { const r = await api('/api/machines/token', { method: 'POST', body: { id, rotate: true } }); setTokenView({ id, token: r.token }); say('تجدّد المفتاح'); }
    catch (e) { say(e.message); }
  };
  const showToken = async (id) => {
    try { const r = await api('/api/machines/token', { method: 'POST', body: { id, rotate: false } }); setTokenView({ id, token: r.token }); }
    catch (e) { say(e.message); }
  };

  return html`
    <div>
      <div className="h2">التحويل التلقائي</div>
      <div className="card">
        <div className="row">
          <div className="text"><div className="t">تحويل عند الانقطاع</div>
            <div className="d">إذا وقف الجهاز المستضيف، تتحول الاستضافة لجهاز متصل ثاني.</div></div>
          <button className=${'switch' + (auto ? ' on' : '')} onClick=${toggleAuto} />
        </div>
      </div>

      <div className="h2">الأجهزة</div>
      ${state.machines.map((m) => html`
        <div key=${m.id} className="card machine">
          <div className="info"><div className="name">${m.name}</div><div className="meta">${m.id} · ${m.mode === 'agent' ? 'وكيل' : 'مباشر'}</div></div>
          ${m.mode === 'agent' && html`
            <button className="btn quiet sm" onClick=${() => showToken(m.id)}>المفتاح</button>
            <button className="btn quiet sm" onClick=${() => rotateToken(m.id)}>تجديد</button>`}
          <button className="btn quiet sm" onClick=${() => delMachine(m.id)}>حذف</button>
        </div>`)}

      ${tokenView && html`
        <div className="card" style=${{ marginTop: 12 }}>
          <div className="note" style=${{ marginBottom: 8 }}>أدخل هذي القيم في agent.js على الجهاز:</div>
          <div className="mono-out">machineId : ${tokenView.id}
token     : ${tokenView.token}
relayHost : ${location.hostname}
relayPort : ${state.ports?.agents ?? 7000}</div>
        </div>`}

      <div className="card stack" style=${{ marginTop: 12 }}>
        <div className="t">إضافة جهاز</div>
        <div className="two">
          <input className="inp" placeholder="معرّف (main-pc)" value=${newMachine.id}
            onInput=${(e) => setNewMachine((p) => ({ ...p, id: e.target.value }))} />
          <input className="inp" placeholder="اسم العرض" value=${newMachine.name}
            onInput=${(e) => setNewMachine((p) => ({ ...p, name: e.target.value }))} />
        </div>
        <select className="inp" value=${newMachine.mode} onChange=${(e) => setNewMachine((p) => ({ ...p, mode: e.target.value }))}>
          <option value="agent">وكيل (agent.js على الجهاز)</option>
          <option value="direct">مباشر (آيبي:منفذ)</option>
        </select>
        ${newMachine.mode === 'direct' && html`
          <div className="two">
            <input className="inp" placeholder="آيبي" value=${newMachine.host}
              onInput=${(e) => setNewMachine((p) => ({ ...p, host: e.target.value }))} />
            <input className="inp" placeholder="منفذ" value=${newMachine.port}
              onInput=${(e) => setNewMachine((p) => ({ ...p, port: Number(e.target.value) }))} />
          </div>`}
        <button className="btn primary" style=${{ justifySelf: 'start' }} onClick=${addMachine}>إضافة</button>
      </div>

      <div className="h2">المستخدمون</div>
      <div className="card stack">
        ${state.users.map((u) => html`
          <div key=${u.username} className="row">
            <div className="text"><div className="t">${u.username}</div><div className="d">${u.role === 'owner' ? 'مالك — صلاحيات كاملة' : 'أدمن — تشغيل، تحويل، كونسول'}</div></div>
            ${u.role !== 'owner' && html`<button className="btn quiet sm" onClick=${() => delUser(u.username)}>حذف</button>`}
          </div>`)}
        <div className="two">
          <input className="inp" placeholder="اسم المستخدم" value=${newUser.username}
            onInput=${(e) => setNewUser((p) => ({ ...p, username: e.target.value }))} />
          <input className="inp" type="password" placeholder="كلمة المرور (٨+)" value=${newUser.password}
            onInput=${(e) => setNewUser((p) => ({ ...p, password: e.target.value }))} />
        </div>
        <button className="btn primary" style=${{ justifySelf: 'start' }} onClick=${addUser}>إضافة أدمن</button>
      </div>
    </div>`;
}

/* ============ التنسيق ============ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Kufi+Arabic:wght@500;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
.mcp{
  --night:#0F1626; --stone:#182135; --raised:#212C46; --edge:#2C3A5A; --edge-soft:rgba(44,58,90,.55);
  --chalk:#E7ECF7; --dim:#8494B5; --torch:#F2A93B; --moss:#63C08A; --rust:#D2695C; --sky:#6FA8DC;
  --kufi:"Noto Kufi Arabic",system-ui,sans-serif; --sans:"IBM Plex Sans Arabic",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
  direction:rtl; text-align:right;
  background:radial-gradient(1100px 500px at 80% -10%,#1B2740 0%,transparent 60%),var(--night);
  color:var(--chalk); font-family:var(--sans); font-size:15px; line-height:1.6; min-height:100vh;
}
.mcp *{box-sizing:border-box}
.mcp button{font:inherit;cursor:pointer;border:none;background:none;color:inherit}
.mcp input,.mcp select{font:inherit;color:inherit}
.mcp ::-webkit-scrollbar{width:9px;height:9px}
.mcp ::-webkit-scrollbar-thumb{background:var(--edge);border-radius:9px}
.mcp ::-webkit-scrollbar-track{background:transparent}
.wrap{max-width:920px;margin:0 auto;padding:18px 16px 60px}
.top{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin-bottom:18px}
.brand{font-family:var(--kufi);font-weight:700;font-size:17px;margin-left:auto}
.who{font-size:12px;color:var(--dim);font-family:var(--mono)}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;font-family:var(--mono);border:1px solid var(--edge);color:var(--dim)}
.tag.owner{color:var(--torch);border-color:rgba(242,169,59,.4)}
.link-btn{color:var(--dim);font-size:13px;text-decoration:underline;text-underline-offset:3px}
.tabs{display:flex;gap:4px;overflow-x:auto;padding-bottom:4px;margin-bottom:20px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:8px 15px;border-radius:9px;font-size:13.5px;color:var(--dim);white-space:nowrap;border:1px solid transparent;transition:.15s}
.tab:hover{color:var(--chalk);background:var(--stone)}
.tab.on{color:var(--chalk);background:var(--stone);border-color:var(--edge)}
.pip{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--rust);margin-left:6px;vertical-align:1px}
.card{background:var(--stone);border:1px solid var(--edge);border-radius:14px;padding:16px}
.card+.card{margin-top:12px}
.h2{font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:var(--dim);font-weight:400;margin:26px 0 11px}
.address{display:flex;align-items:center;gap:10px;padding:11px 15px;margin-bottom:18px;background:var(--stone);border:1px solid var(--edge);border-radius:12px}
.address .lbl{font-size:12px;color:var(--dim);white-space:nowrap}
.address code{font-family:var(--mono);font-size:15px;direction:ltr;flex:1;overflow:auto}
.copy{font-size:12px;color:var(--torch);white-space:nowrap}
.rail{background:var(--stone);border:1px solid var(--edge);border-radius:16px;padding:24px 18px 18px;margin-bottom:14px;overflow:hidden}
.rail-title{font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:var(--dim);margin-bottom:20px}
.track{display:flex;align-items:center}
.node{display:flex;flex-direction:column;align-items:center;gap:7px;min-width:70px;z-index:2}
.disc{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:var(--raised);border:1px solid var(--edge);font-size:18px}
.node .cap{font-size:11.5px;color:var(--dim);text-align:center;max-width:96px;line-height:1.35}
.node.live .disc{border-color:rgba(242,169,59,.55);background:rgba(242,169,59,.12);box-shadow:0 0 0 6px rgba(242,169,59,.06)}
.node.live .cap{color:var(--chalk)}
.node.dead .disc{border-style:dashed;opacity:.55}
.seg{flex:1;height:2px;background:var(--edge);border-radius:2px}
.seg.flow{background-image:linear-gradient(90deg,var(--torch) 0 34%,transparent 34%);background-size:16px 2px;background-repeat:repeat-x;animation:drift 1.1s linear infinite}
.seg.broken{background-color:transparent;background-image:linear-gradient(90deg,var(--edge) 0 46%,transparent 46%);background-size:10px 2px}
@keyframes drift{to{background-position-x:16px}}
.verdict{margin-top:20px;padding-top:16px;border-top:1px solid var(--edge);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.verdict .big{font-family:var(--kufi);font-size:18px;font-weight:700}
.verdict .sub{font-size:13px;color:var(--dim)}
.verdict.up .big{color:var(--torch)}
.verdict.down .big{color:var(--rust)}
.machine{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
.machine.is-active{border-color:rgba(242,169,59,.45);background:rgba(242,169,59,.05)}
.machine .info{flex:1;min-width:150px}
.machine .name{font-family:var(--kufi);font-size:15.5px;font-weight:500}
.machine .meta{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-top:3px;direction:ltr;text-align:right}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:7px;vertical-align:1px}
.dot.on{background:var(--moss);box-shadow:0 0 8px rgba(99,192,138,.7)}
.dot.off{background:#4A5772}
.dot.busy{background:var(--torch);animation:blink 1s ease-in-out infinite}
@keyframes blink{50%{opacity:.25}}
.btn{padding:8px 15px;border-radius:9px;font-size:13.5px;font-weight:500;background:var(--raised);border:1px solid var(--edge);transition:.15s}
.btn:hover:not(:disabled){background:var(--edge)}
.btn.primary{background:var(--torch);color:#221703;border-color:var(--torch)}
.btn.primary:hover:not(:disabled){background:#FFBB4D}
.btn.danger{color:var(--rust);border-color:rgba(210,105,92,.4)}
.btn.quiet{background:transparent;color:var(--dim);font-size:12.5px;padding:7px 11px}
.btn.quiet:hover{color:var(--chalk)}
.btn:disabled{opacity:.38;cursor:default}
.btn.sm{padding:5px 11px;font-size:12.5px}
.badge{font-family:var(--mono);font-size:11px;color:var(--torch);padding:6px 0}
.row{display:flex;align-items:center;gap:11px}
.row+.row{margin-top:13px;padding-top:13px;border-top:1px solid var(--edge-soft)}
.row .text{flex:1;min-width:0}
.row .t{font-size:14px}
.row .d{font-size:12.5px;color:var(--dim)}
.switch{width:44px;height:25px;border-radius:999px;background:var(--edge);position:relative;transition:.18s;flex:none}
.switch::after{content:"";position:absolute;top:3px;right:3px;width:19px;height:19px;border-radius:50%;background:var(--dim);transition:.18s}
.switch.on{background:rgba(242,169,59,.3)}
.switch.on::after{transform:translateX(-19px);background:var(--torch)}
.inp{width:100%;padding:9px 12px;background:var(--night);border:1px solid var(--edge);border-radius:9px}
.stack{display:grid;gap:10px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.note{font-size:12.5px;color:var(--dim)}
.mono-out{font-family:var(--mono);font-size:12px;background:var(--night);border:1px solid var(--edge);border-radius:9px;padding:12px;direction:ltr;text-align:left;white-space:pre-wrap;word-break:break-all}
.picker{display:flex;gap:7px;overflow-x:auto;margin-bottom:14px;scrollbar-width:none}
.picker::-webkit-scrollbar{display:none}
.chip{padding:7px 13px;border-radius:999px;font-size:13px;border:1px solid var(--edge);color:var(--dim);white-space:nowrap;transition:.15s}
.chip.on{color:var(--chalk);border-color:var(--torch);background:rgba(242,169,59,.1)}
.console-shell{background:#0B111E;border:1px solid var(--edge);border-radius:14px;overflow:hidden}
.console-bar{display:flex;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid var(--edge);flex-wrap:wrap;background:var(--stone)}
.filter{font-family:var(--mono);font-size:11px;padding:4px 10px;border-radius:7px;border:1px solid var(--edge);color:var(--dim)}
.filter.on{color:var(--chalk);border-color:var(--torch);background:rgba(242,169,59,.12)}
.filter .n{opacity:.7;margin-right:5px}
.search{flex:1;min-width:110px;background:var(--night);border:1px solid var(--edge);border-radius:7px;padding:5px 10px;font-size:12.5px}
.logbox{height:340px;overflow:auto;padding:11px 13px;font-family:var(--mono);font-size:12.2px;line-height:1.75;direction:ltr;text-align:left}
.ln{display:flex;gap:9px;white-space:pre-wrap;word-break:break-word;padding:1px 0}
.ln .ts{color:#5A6B8C;flex:none;font-size:11px;padding-top:1px}
.ln .tx{flex:1}
.ln.INFO .tx{color:#C6D2E8}
.ln.WARN .tx{color:var(--torch)}
.ln.ERROR .tx{color:var(--rust)}
.ln.PANEL .tx{color:var(--sky)}
.ln mark{background:rgba(242,169,59,.3);color:inherit;border-radius:2px}
.cmdbar{display:flex;gap:8px;padding:10px;border-top:1px solid var(--edge);background:var(--stone)}
.cmdbar input{flex:1;background:var(--night);border:1px solid var(--edge);border-radius:9px;padding:9px 12px;font-family:var(--mono);font-size:13px;direction:ltr;text-align:left}
.quicks{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:11px}
.gauge{background:var(--stone);border:1px solid var(--edge);border-radius:13px;padding:14px}
.gauge .k{font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;color:var(--dim)}
.gauge .v{font-family:var(--kufi);font-size:24px;font-weight:700;margin-top:5px;line-height:1.1}
.gauge .u{font-size:12px;color:var(--dim);font-family:var(--sans);font-weight:400;margin-right:4px}
.gauge .bar{height:4px;background:var(--edge);border-radius:4px;margin-top:10px;overflow:hidden}
.gauge .bar i{display:block;height:100%;background:var(--torch);border-radius:4px;transition:width .5s}
.gauge.warn .bar i{background:var(--rust)}
.gauge svg{display:block;margin-top:8px;width:100%;height:34px}
.players{display:flex;flex-wrap:wrap;gap:7px}
.player{font-family:var(--mono);font-size:12px;padding:5px 11px;border-radius:8px;background:var(--raised);border:1px solid var(--edge)}
.addon{display:flex;align-items:center;gap:11px;padding:10px 0;border-bottom:1px solid var(--edge-soft)}
.addon:last-child{border-bottom:none}
.addon .nm{flex:1;min-width:0;font-family:var(--mono);font-size:12.5px;direction:ltr;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.addon.off .nm{color:var(--dim);text-decoration:line-through}
.drop{border:1.5px dashed var(--edge);border-radius:12px;padding:20px;text-align:center;color:var(--dim);font-size:13px;cursor:pointer}
.log{list-style:none;margin:0;padding:0}
.log li{display:flex;gap:11px;padding:8px 0;border-bottom:1px solid var(--edge-soft);font-size:13.5px}
.log li:last-child{border-bottom:none}
.log time{font-family:var(--mono);font-size:11.5px;color:var(--dim);white-space:nowrap;padding-top:2px}
.log .actor{color:var(--dim);font-size:12px}
.toast{position:fixed;bottom:18px;right:50%;transform:translateX(50%);background:var(--raised);border:1px solid var(--edge);border-radius:11px;padding:11px 17px;font-size:13.5px;z-index:50;box-shadow:0 12px 32px rgba(0,0,0,.5)}
.toast.good{border-color:rgba(99,192,138,.5)}
.login-wrap{min-height:100vh;display:grid;place-items:center;padding:20px}
.login-card{width:100%;max-width:320px;background:var(--stone);border:1px solid var(--edge);border-radius:16px;padding:24px}
@media (max-width:540px){.two,.three{grid-template-columns:1fr}.node{min-width:56px}.disc{width:39px;height:39px}}
`;

createRoot(document.getElementById('root')).render(React.createElement(App));
