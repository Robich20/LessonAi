'use strict';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = $('#app');
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, { method = 'GET', json, body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (json !== undefined) { opts.body = JSON.stringify(json); opts.headers['Content-Type'] = 'application/json'; }
  else if (body !== undefined) opts.body = body;
  const r = await fetch('/api' + path, opts);
  if (r.status === 401 && path !== '/login') { renderLogin(); throw new HttpError(401, 'Потрібен вхід'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* not json */ }
    throw new HttpError(r.status, msg);
  }
  return r.json();
}

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const utc = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const fmtDate = (s) => utc(s).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (s) => utc(s).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0');
};
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

function mdLegacy(src) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of esc(src || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { flushPara(); closeList(); html += `<h3>${inline(m[2])}</h3>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flushPara();
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== type) { closeList(); html += `<${type}>`; list = type; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara(); closeList();
  return html;
}

// Markdown via marked + DOMPurify (vendored); falls back to the tiny renderer if they failed to load.
function md(src) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(String(src || ''), { gfm: true }));
  }
  return mdLegacy(src);
}

let mermaidLoad = null;
function loadMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.onload = () => {
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        window.mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral',
          // SVG text labels: page CSS can't change their size after mermaid measured them.
          htmlLabels: false, flowchart: { htmlLabels: false },
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
        });
        res(window.mermaid);
      };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return mermaidLoad;
}

const CALLOUTS = { 'zapamiętaj': 'remember', 'uwaga': 'warn', 'przykład': 'example', 'важливо': 'warn', 'приклад': 'example', 'запамʼятай': 'remember', "запам'ятай": 'remember' };

// Post-process rendered Markdown: callout boxes, scrollable tables, mermaid diagrams.
function enhance(root) {
  if (!root) return;
  $$('blockquote', root).forEach((bq) => {
    const first = bq.querySelector('strong');
    const key = first ? first.textContent.replace(/[:\s]+$/, '').toLowerCase() : '';
    bq.classList.add('callout', CALLOUTS[key] || 'note');
  });
  $$('table', root).forEach((t) => {
    if (t.parentElement.classList.contains('table-wrap')) return;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w); w.appendChild(t);
  });
  const blocks = $$('pre > code.language-mermaid', root);
  if (!blocks.length) return;
  loadMermaid().then(async (mermaid) => {
    for (const code of blocks) {
      const pre = code.parentElement;
      const src = code.textContent;
      const id = 'm' + Math.random().toString(36).slice(2);
      let svg = null;
      for (const candidate of [src, quoteMermaidLabels(src), quoteMermaidLabels(nameBareNodes(src))]) {
        try {
          await mermaid.parse(candidate);
          ({ svg } = await mermaid.render(id, candidate));
          break;
        } catch {
          // mermaid leaves its error graphic in <body> when rendering fails; clean it up.
          document.getElementById(id)?.remove();
          document.getElementById('d' + id)?.remove();
        }
      }
      if (svg) {
        const box = document.createElement('div');
        box.className = 'diagram';
        box.innerHTML = svg;
        pre.replaceWith(box);
      } else {
        // The AI wrote invalid diagram syntax: hide it behind a toggle instead of showing an error.
        const det = document.createElement('details');
        det.className = 'diagram-error';
        det.innerHTML = '<summary>Схему не вдалося намалювати</summary>';
        pre.replaceWith(det);
        det.appendChild(pre);
      }
    }
  }).catch(() => {});
}

// Another AI habit: edges pointing at plain text ("B1 -- Lider --> III Rzesza"). Give such targets generated ids.
function nameBareNodes(src) {
  const ids = new Map();
  const idFor = (text) => {
    if (!ids.has(text)) ids.set(text, 'n' + (ids.size + 1));
    return `${ids.get(text)}["${text.replace(/"/g, "'")}"]`;
  };
  const isRef = (t) => /^[A-Za-z_][\w-]*$/.test(t) || /[\[\(\{]/.test(t);
  return src.split('\n').map((line) => {
    const m = line.match(/^(\s*)(\S+?)\s*(?:--\s*(.+?)\s*-->|-->\s*\|(.+?)\|\s*|-->)\s*(.+?)\s*;?\s*$/);
    if (!m) return line;
    const [, indent, from, label1, label2, to] = m;
    const label = label1 || label2;
    const target = isRef(to) ? to : idFor(to);
    return `${indent}${from} -->${label ? `|${label}|` : ''} ${target}`;
  }).join('\n');
}

// Common AI mistake: parentheses, colons or quotes inside node/edge labels. Quoting the labels fixes most of them.
function quoteMermaidLabels(src) {
  const q = (t) => '"' + t.trim().replace(/"/g, "'") + '"';
  return src.split('\n').map((line) => line
    .replace(/(\b[\w-]+)\[\[([^\]]+)\]\]/g, (m, id, t) => `${id}[[${q(t)}]]`)
    .replace(/(\b[\w-]+)\[(?!\[)([^\]"]+)\]/g, (m, id, t) => `${id}[${q(t)}]`)
    .replace(/(\b[\w-]+)\(\(([^)]+)\)\)/g, (m, id, t) => `${id}((${q(t)}))`)
    .replace(/(\b[\w-]+)\((?!\()([^)"]+)\)(?=\s|$|-|;)/g, (m, id, t) => `${id}(${q(t)})`)
    .replace(/(\b[\w-]+)\{([^}"]+)\}/g, (m, id, t) => `${id}{${q(t)}}`)
    .replace(/\|([^|"]+)\|/g, (m, t) => `|${q(t)}|`)).join('\n');
}

const STATUS = {
  recording: ['recb', 'Не завершено'], queued: ['busy', 'В черзі'], processing: ['busy', 'Обробка…'],
  done: ['ok', 'Готово'], error: ['err', 'Помилка'],
};
const badge = (l) => {
  const [cls, label] = STATUS[l.status] || ['', l.status];
  return `<span class="badge ${cls}">${esc(l.status === 'processing' && l.progress ? l.progress : label)}</span>`;
};

// ---------- offline-safe chunk queue (IndexedDB) ----------
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lessonai', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('chunks', { keyPath: 'key' });
      r.result.createObjectStore('finish', { keyPath: 'lessonId' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const op = async (name, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode);
      const req = fn(t.objectStore(name));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    put: (n, v) => op(n, 'readwrite', (s) => s.put(v)),
    del: (n, k) => op(n, 'readwrite', (s) => s.delete(k)),
    all: (n) => op(n, 'readonly', (s) => s.getAll()),
  };
})();

const uploader = {
  running: false, mem: { chunks: new Map(), finish: new Map() }, uploaded: 0, lastError: null, onChange: null,
  async put(name, v) {
    try { await idb.put(name, v); } catch { this.mem[name].set(v.key || v.lessonId, v); }
  },
  async del(name, k) {
    this.mem[name].delete(k);
    try { await idb.del(name, k); } catch { /* memory only */ }
  },
  async list(name) {
    let rows = [];
    try { rows = await idb.all(name); } catch { /* memory only */ }
    return rows.concat([...this.mem[name].values()]);
  },
  async enqueue(chunk) { await this.put('chunks', chunk); this.changed(); this.run(); },
  async finish(lessonId, interruptions) { await this.put('finish', { lessonId, interruptions }); this.run(); },
  async pendingCount() { return (await this.list('chunks')).length; },
  changed() { if (this.onChange) this.onChange(); },
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const chunks = (await this.list('chunks')).sort((a, b) => a.lessonId - b.lessonId || a.seq - b.seq || a.idx - b.idx);
        if (!chunks.length) break;
        const c = chunks[0];
        try {
          const r = await fetch(`/api/lessons/${c.lessonId}/segments/${c.seq}/chunks/${c.idx}?mime=${encodeURIComponent(c.mime)}`,
            { method: 'PUT', body: c.data, credentials: 'same-origin' });
          if (r.status === 404) { await this.del('chunks', c.key); continue; } // lesson was deleted
          if (!r.ok) throw new Error('HTTP ' + r.status);
          await this.del('chunks', c.key);
          this.uploaded++; this.lastError = null; this.changed();
        } catch (e) {
          this.lastError = e.message; this.changed();
          setTimeout(() => this.run(), 5000);
          return;
        }
      }
      for (const f of await this.list('finish')) {
        try {
          await api(`/lessons/${f.lessonId}/finish`, { method: 'POST', json: { interruptions: f.interruptions || 0 } });
          await this.del('finish', f.lessonId);
        } catch (e) {
          if (e.status === 404) { await this.del('finish', f.lessonId); continue; }
          setTimeout(() => this.run(), 5000);
          return;
        }
      }
    } finally {
      this.running = false;
    }
  },
};
window.addEventListener('online', () => uploader.run());

// ---------- recorder ----------
class LessonRecorder {
  constructor({ lessonId, subjectName, seq = 0, startedAt = Date.now(), interruptions = 0 }) {
    Object.assign(this, { lessonId, subjectName, seq, startedAt, interruptions });
    this.stopped = false; this.writes = []; this.wakeLock = null; this.onUpdate = () => {};
  }

  static mime() {
    if (!window.MediaRecorder) return null;
    for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async start() {
    await this.openStream();
    this.startSegment();
    await this.lockScreen();
    this.onVis = () => {
      if (document.visibilityState === 'visible') { this.lockScreen(); setTimeout(() => this.check(), 800); }
    };
    document.addEventListener('visibilitychange', this.onVis);
    this.timer = setInterval(() => this.check(), 3000);
  }

  async openStream() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
    });
    this.track = this.stream.getAudioTracks()[0];
    this.track.onended = () => this.recover('track ended');
    this.meter();
  }

  startSegment() {
    const mime = LessonRecorder.mime();
    const mr = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    const seq = this.seq, lessonId = this.lessonId, type = mr.mimeType || mime || 'audio/mp4';
    let idx = 0;
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const i = idx++;
      this.writes.push(e.data.arrayBuffer().then((data) =>
        uploader.enqueue({ key: `${lessonId}:${seq}:${i}`, lessonId, seq, idx: i, mime: type, data })));
    };
    mr.onerror = () => this.recover('recorder error');
    mr.onstop = () => { if (this.stopResolve) this.stopResolve(); else this.recover('recorder stopped'); };
    mr.start(15000); // a chunk every 15s goes to the server, so almost nothing is lost if the phone dies
    this.mr = mr;
    this.persist();
  }

  persist() {
    store.set('activeRec', { lessonId: this.lessonId, subjectName: this.subjectName, seq: this.seq,
      startedAt: this.startedAt, interruptions: this.interruptions });
  }

  check() {
    if (this.stopped || this.recovering || document.visibilityState !== 'visible') return;
    // A muted track (e.g. Siri or a call grabbed the mic) usually comes back by itself; restart only if it stays muted.
    this.mutedSince = this.track?.muted ? (this.mutedSince || Date.now()) : 0;
    const stuckMuted = this.mutedSince && Date.now() - this.mutedSince > 6000;
    if (!this.mr || this.mr.state !== 'recording' || !this.track || this.track.readyState === 'ended' || stuckMuted) {
      this.mutedSince = 0;
      this.recover('health check');
    }
  }

  async recover(reason) {
    if (this.stopped || this.recovering) return;
    if (document.visibilityState !== 'visible') return; // resume when the page is visible again
    this.recovering = true;
    console.warn('recording interrupted:', reason);
    try {
      const old = this.mr; this.mr = null;
      if (old && old.state !== 'inactive') { old.onstop = null; try { old.stop(); } catch { /* already dead */ } }
      this.stream?.getTracks().forEach((t) => t.stop());
      this.interruptions++;
      this.seq++;
      await this.openStream();
      this.startSegment();
      this.onUpdate({ notice: 'Запис перервався і був автоматично відновлений' });
    } catch (e) {
      this.onUpdate({ error: 'Мікрофон недоступний: ' + e.message });
    } finally {
      this.recovering = false;
    }
  }

  meter() {
    try {
      this.ctx?.close();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.buf = new Uint8Array(this.analyser.fftSize);
    } catch { this.analyser = null; }
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 4);
  }

  async lockScreen() {
    if (!('wakeLock' in navigator) || this.stopped) return;
    try {
      if (!this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; this.onUpdate({}); });
      }
    } catch { this.wakeLock = null; }
    this.onUpdate({});
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVis);
    if (this.mr && this.mr.state !== 'inactive') {
      const done = new Promise((r) => { this.stopResolve = r; });
      this.mr.stop();
      await Promise.race([done, sleep(4000)]);
    }
    await Promise.allSettled(this.writes);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    try { await this.wakeLock?.release(); } catch { /* ignore */ }
    store.del('activeRec');
    await uploader.finish(this.lessonId, this.interruptions);
  }
}

let recorder = null;
let pollTimer = null;
let subjectsCache = [];

async function loadSubjects() {
  subjectsCache = await api('/subjects');
  return subjectsCache;
}

// ---------- views ----------
function renderLogin() {
  $('#tabs').hidden = true;
  app.innerHTML = `
    <div class="login">
      <div class="logo"></div>
      <h1>LessonAI</h1>
      <p class="muted">Записуй уроки, а AI зробить конспект, знайде домашнє і пояснить українською.</p>
      <form id="login" class="card row" style="margin-top:22px">
        <input type="password" id="pw" autocomplete="current-password" placeholder="Пароль" required>
        <button class="primary">Увійти</button>
      </form>
    </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', json: { password: $('#pw').value } }); route(); }
    catch (err) { toast(err.message); }
  };
}

const SUGGESTED = ['Математика', 'Польська мова', 'Англійська мова', 'Фізика', 'Хімія', 'Біологія', 'Історія', 'Географія', 'Інформатика'];
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316'];
const mark = (color) => `<span class="mark" style="--c:${esc(color || '#9ca3af')}"></span>`;
const fmtDue = (d) => new Date(d + 'T12:00').toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
const hours = (sec) => sec >= 3600 ? (sec / 3600).toFixed(1).replace('.0', '') + ' год' : Math.round(sec / 60) + ' хв';

function quickRecordCard(subjects, selected) {
  if (!subjects.length) {
    return `<section class="panel pad"><div class="label">Почніть з предметів</div>
      <p class="muted">Додайте предмети, які записуватимете. Натисніть, щоб додати:</p>
      <div class="chips">${SUGGESTED.map((n) => `<button data-add="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>
      <p class="muted small">Або <a href="#/subjects">створіть свої</a>.</p></section>`;
  }
  const noRec = LessonRecorder.mime() === null;
  return `<section class="panel pad"><div class="label">Новий урок</div>
    <div class="subjects">${subjects.map((s) => `
      <button class="subj ${s.id === selected ? 'sel' : ''}" data-id="${s.id}">${mark(s.color)}${esc(s.name)}</button>`).join('')}
    </div>
    <div class="rec-actions">
      <button class="bigrec" id="rec" ${noRec ? 'disabled' : ''}><span class="circle"></span>Почати запис</button>
      <label class="btn" for="file">Завантажити файл</label>
    </div>
    <input type="file" id="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.webm,.mp4,.qta" hidden>
    ${noRec ? '<p class="muted small">Цей браузер не підтримує запис. Можна завантажувати файли з диктофона.</p>' : ''}
  </section>`;
}

function hwRow(h, withDone = false) {
  const today = new Date().toISOString().slice(0, 10);
  const over = h.due && h.due < today && !h.done;
  return `<div class="item hw ${h.done ? 'done' : ''}">
    <input type="checkbox" data-hw="${h.id}" ${h.done ? 'checked' : ''} aria-label="Виконано">
    <div class="main">
      <div class="task">${esc(h.task)}</div>
      ${withDone && h.task_pl ? `<div class="muted small">PL: ${esc(h.task_pl)}</div>` : ''}
      <div class="meta">${mark(h.subject_color)}${esc(h.subject_name || 'Без предмета')}
        ${withDone && h.lesson_title ? ` · <a href="#/lesson/${h.lesson_id}">${esc(h.lesson_title)}</a>` : ''}
        ${withDone && h.due_text ? ` · «${esc(h.due_text)}»` : ''}</div>
    </div>
    <div class="due ${over ? 'over' : ''}">${h.due ? (over ? 'прострочено, ' : '') + fmtDue(h.due) : '<span class="muted">без терміну</span>'}</div>
  </div>`;
}

async function viewHome() {
  const d = await api('/dashboard');
  const subjects = subjectsCache = d.subjects;
  let selected = store.get('subjectId');
  if (!subjects.some((s) => s.id === selected)) selected = subjects[0]?.id ?? null;
  const active = store.get('activeRec');
  const pending = await uploader.pendingCount();
  const st = d.stats;
  const today = new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });

  app.innerHTML = `
    <header class="pagehead"><h1>Головна</h1><span class="muted">${today}</span></header>
    ${active ? `<div class="notice warn"><b>Запис уроку перервався.</b> Сторінку закрили під час запису «${esc(active.subjectName)}», записане збережено.
      <div class="row wrap" style="margin-top:10px"><button class="primary" id="resume">Продовжити запис</button><button id="finishActive">Завершити й обробити</button></div></div>` : ''}
    ${pending ? `<div class="notice warn">Ще не відправлено на сервер: ${pending} фрагм. запису. Відправиться автоматично, коли зʼявиться інтернет.</div>` : ''}
    <div class="dash-top">
      ${quickRecordCard(subjects, selected)}
      <section class="panel stats">
        <div class="stat"><div class="v">${st.lessons_week}</div><div class="l">уроків за 7 днів</div></div>
        <div class="stat"><div class="v">${hours(st.seconds_week)}</div><div class="l">записано за 7 днів</div></div>
        <div class="stat ${st.homework_overdue ? 'alert' : ''}"><div class="v">${st.homework_open}</div><div class="l">${st.homework_overdue ? `домашок, ${st.homework_overdue} прострочено` : 'відкритих домашок'}</div></div>
        <div class="stat"><div class="v">${st.processing || st.lessons_total}</div><div class="l">${st.processing ? 'в обробці' : 'уроків усього'}</div></div>
      </section>
    </div>
    <div class="dash-cols">
      <section>
        <div class="section-head"><h2>Домашнє завдання</h2><a href="#/homework">Усе</a></div>
        <div class="list" id="dash-hw">${d.homework.map((h) => hwRow(h)).join('') || '<div class="empty">Відкритих завдань немає.</div>'}</div>
        ${d.announcements.length ? `<div class="section-head"><h2>Оголошення</h2><span class="muted small">за 14 днів</span></div>
        <div class="list">${d.announcements.map((a) => `<a class="item" href="#/lesson/${a.lesson_id}">
          <div class="main"><div>${esc(a.text)}</div><div class="meta">${mark(a.subject_color)}${esc(a.subject_name || '')} · ${fmtDate(a.recorded_at)}</div></div></a>`).join('')}</div>` : ''}
      </section>
      <section>
        <div class="section-head"><h2>Останні уроки</h2><a href="#/lessons">Усі</a></div>
        <div class="list">${d.recent.map(lessonCard).join('') || '<div class="empty">Тут зʼявляться записані уроки.</div>'}</div>
        ${subjects.length ? `<div class="section-head"><h2>Предмети</h2><a href="#/subjects">Керувати</a></div>
        <div class="list">${subjects.map(subjectTile).join('')}</div>` : ''}
      </section>
    </div>`;

  $$('.subj').forEach((b) => b.onclick = () => {
    store.set('subjectId', +b.dataset.id);
    $$('.subj').forEach((x) => x.classList.toggle('sel', x === b));
  });
  $$('[data-add]').forEach((b) => b.onclick = async () => {
    await api('/subjects', { method: 'POST', json: { name: b.dataset.add, color: COLORS[subjectsCache.length % COLORS.length] } });
    viewHome();
  });
  if ($('#rec')) $('#rec').onclick = () => recordSelected();
  if ($('#file')) $('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadDialog(f); };
  $$('#dash-hw [data-hw]').forEach((c) => c.onchange = async () => {
    await api('/homework/' + c.dataset.hw, { method: 'PATCH', json: { done: c.checked } });
    c.closest('.hw').remove();
    toast('Позначено як виконане');
  });
  if (active) {
    $('#resume').onclick = () => startRecording({ name: active.subjectName }, active);
    $('#finishActive').onclick = async () => {
      store.del('activeRec');
      await uploader.finish(active.lessonId, active.interruptions + 1);
      toast('Урок відправлено на обробку');
      viewHome();
    };
  }
  if (st.processing || d.recent.some((l) => l.status === 'queued' || l.status === 'processing')) poll(viewHome, 6000, true);
}

async function recordSelected() {
  const subjects = subjectsCache.length ? subjectsCache : await loadSubjects();
  const s = subjects.find((x) => x.id === store.get('subjectId')) || subjects[0];
  if (!s) { location.hash = '#/'; return toast('Спочатку додайте предмет'); }
  startRecording(s);
}

function subjectTile(s) {
  return `<a class="item" href="#/subject/${s.id}">${mark(s.color)}<div class="main"><div class="t">${esc(s.name)}</div></div>
    <div class="meta">${s.lessons} урок.${s.open_homework ? ` · ${s.open_homework} дз` : ''}</div></a>`;
}

function lessonCard(l) {
  return `<a class="item lesson" href="#/lesson/${l.id}">
    ${mark(l.subject_color)}
    <div class="main">
      <div class="t">${esc(l.title || (l.status === 'done' ? 'Урок' : 'Новий запис'))}</div>
      <div class="meta">${esc(l.subject_name || 'Без предмета')} · ${fmtDate(l.recorded_at)}, ${fmtTime(l.recorded_at)}${l.duration_sec ? ' · ' + fmtDur(l.duration_sec) : ''}${l.homework_count ? ' · є домашнє' : ''}</div>
    </div>
    ${l.status === 'done' ? '' : badge(l)}
  </a>`;
}

function uploadDialog(file) {
  const d = new Date(file.lastModified || Date.now());
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const sel = store.get('subjectId');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h2 style="margin-top:0">Завантажити запис</h2>
    <p class="muted small">${esc(file.name)} · ${(file.size / 1048576).toFixed(1)} МБ</p>
    <label>Предмет</label>
    <select id="up-subj">${subjectsCache.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    <label>Коли був урок</label>
    <input type="datetime-local" id="up-date" value="${local}">
    <div class="progressbar" hidden><div></div></div>
    <div class="row" style="margin-top:16px"><button id="up-cancel">Скасувати</button><span class="spacer"></span><button class="primary" id="up-go">Завантажити</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  $('#up-cancel', bg).onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  $('#up-go', bg).onclick = () => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('subject_id', $('#up-subj', bg).value);
    const dt = $('#up-date', bg).value;
    if (dt) fd.append('recorded_at', new Date(dt).toISOString());
    const xhr = new XMLHttpRequest();
    const bar = $('.progressbar', bg);
    bar.hidden = false;
    $('#up-go', bg).disabled = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = (100 * e.loaded / e.total) + '%'; };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const { id } = JSON.parse(xhr.responseText);
        close(); toast('Завантажено, обробка почалась');
        location.hash = '#/lesson/' + id;
      } else { toast('Помилка завантаження: ' + xhr.status); $('#up-go', bg).disabled = false; }
    };
    xhr.onerror = () => { toast('Немає звʼязку з сервером'); $('#up-go', bg).disabled = false; };
    xhr.open('POST', '/api/lessons/upload');
    xhr.send(fd);
  };
}

async function startRecording(subject, resume = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('Запис працює тільки через HTTPS. Відкрийте сайт за https:// адресою.', 6000);
  }
  try {
    let opts;
    if (resume) {
      opts = { ...resume, seq: resume.seq + 1, interruptions: resume.interruptions + 1 };
    } else {
      const { id } = await api('/lessons', { method: 'POST', json: { subject_id: subject.id } });
      opts = { lessonId: id, subjectName: subject.name };
    }
    recorder = new LessonRecorder(opts);
    await recorder.start();
  } catch (e) {
    recorder = null;
    return toast('Не вдалося почати запис: ' + e.message, 6000);
  }
  renderRecording();
}

function renderRecording() {
  const r = recorder;
  $('#tabs').hidden = true;
  stopPoll();
  app.innerHTML = `
    <div class="recscreen">
      <div class="subjname">${esc(r.subjectName)}</div>
      <div class="row"><span class="pulse"></span><span class="muted">Іде запис</span></div>
      <div class="time" id="t">00:00:00</div>
      <div class="meter"><div id="lvl"></div></div>
      <div class="small" id="lock"></div>
      <div class="small muted" id="up"></div>
      <div class="small" id="notice" style="color:var(--warn)"></div>
      <button class="stop" id="stop"><span class="sq"></span></button>
      <div class="muted small">Stop</div>
      <button class="ghost" id="dim">Затемнити екран (економія батареї)</button>
      <p class="muted small" style="max-width:340px">Не закривайте Safari і не перемикайтесь на інші застосунки під час уроку.
        Телефон можна покласти екраном донизу. Якщо запис перерветься, він відновиться автоматично, коли ви повернетесь.</p>
    </div>`;

  const update = (ev = {}) => {
    if (!$('#lock')) return;
    $('#lock').innerHTML = r.wakeLock
      ? '<span style="color:var(--ok)">Екран не згасне</span>'
      : '<span style="color:var(--warn)">Увімкніть «Автоблокування: Ніколи» в Налаштуваннях → Екран, щоб екран не вимкнувся</span>';
    if (ev.notice) $('#notice').textContent = ev.notice;
    if (ev.error) $('#notice').innerHTML = esc(ev.error) + ' <button id="retryMic">Повторити</button>';
    if ($('#retryMic')) $('#retryMic').onclick = () => r.recover('manual');
  };
  r.onUpdate = update;
  uploader.onChange = async () => {
    if (!$('#up')) return;
    const n = await uploader.pendingCount();
    $('#up').textContent = uploader.lastError
      ? `Немає звʼязку з сервером, ${n} фрагм. чекають (запис іде далі)`
      : (n ? `Відправляю… (${n} в черзі)` : (uploader.uploaded ? 'Усе записане збережено на сервері' : ''));
  };
  update();

  let dimmed = false;
  const tick = () => {
    if (recorder !== r) return;
    const t = $('#t');
    if (t) t.textContent = clock(Date.now() - r.startedAt);
    const dt = $('#dimt');
    if (dt) dt.textContent = clock(Date.now() - r.startedAt);
    if (!dimmed && $('#lvl')) $('#lvl').style.width = (r.level() * 100) + '%';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  $('#stop').onclick = async () => {
    if (!confirm('Зупинити запис уроку?')) return;
    $('#stop').disabled = true;
    await r.stop();
    recorder = null;
    uploader.onChange = null;
    toast('Запис збережено. Обробка почнеться, щойно все відправиться на сервер.', 4000);
    location.hash = '#/lesson/' + r.lessonId;
    route();
  };
  $('#dim').onclick = () => {
    dimmed = true;
    const d = document.createElement('div');
    d.className = 'dim';
    d.innerHTML = '<div>● <span id="dimt"></span> · двічі торкніться, щоб повернутись</div>';
    let last = 0;
    d.onclick = () => {
      const now = Date.now();
      if (now - last < 400) { d.remove(); dimmed = false; }
      last = now;
    };
    document.body.appendChild(d);
  };
}

window.addEventListener('beforeunload', (e) => {
  if (recorder && !recorder.stopped) { e.preventDefault(); e.returnValue = ''; }
});

let lessonsQuery = '';

async function viewLessons() {
  const [subjects, lessons] = await Promise.all([loadSubjects(), api('/lessons?limit=300')]);
  let filter = store.get('lessonFilter', 0);
  app.innerHTML = `<h1>Уроки</h1>
    <div class="searchbar"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" id="q" placeholder="Пошук у конспектах і транскриптах" value="${esc(lessonsQuery)}" autocomplete="off" enterkeyhint="search"></div>
    <div class="seg" id="filters"></div>
    <div id="results"></div>`;
  const results = $('#results');
  let seq = 0;
  const draw = async () => {
    $('#filters').innerHTML = `<button data-f="0" class="${!filter ? 'on' : ''}">Усі</button>
      ${subjects.map((s) => `<button data-f="${s.id}" class="${filter === s.id ? 'on' : ''}">${esc(s.name)}</button>`).join('')}`;
    $$('[data-f]').forEach((b) => b.onclick = () => { filter = +b.dataset.f; store.set('lessonFilter', filter); draw(); });
    const q = lessonsQuery.trim();
    if (q.length < 2) {
      const list = filter ? lessons.filter((l) => l.subject_id === filter) : lessons;
      results.innerHTML = `<div class="list">${list.map(lessonCard).join('') || '<div class="empty">Поки що немає уроків.</div>'}</div>`;
      return;
    }
    const my = ++seq;
    const hits = await api(`/search?q=${encodeURIComponent(q)}${filter ? '&subject_id=' + filter : ''}`);
    if (my !== seq) return; // a newer query already answered
    results.innerHTML = `<p class="muted small">${hits.length ? `Знайдено в ${hits.length} урок.` : 'Нічого не знайдено.'}</p>
      <div class="list">${hits.map(searchHit).join('')}</div>`;
    $$('[data-open]', results).forEach((a) => a.onclick = () => {
      const [tab, lang] = a.dataset.open.split(':');
      store.set('lessonTab', tab);
      if (lang) store.set('trLang', lang);
    });
  };
  let timer;
  $('#q').oninput = (e) => { lessonsQuery = e.target.value; clearTimeout(timer); timer = setTimeout(draw, 250); };
  await draw();
  if (lessons.some((l) => l.status === 'queued' || l.status === 'processing')) poll(viewLessons, 6000);
}

const hl = (s) => esc(s).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>');

function searchHit(h) {
  const where = { summary: 'Конспект', pl: 'Транскрипт', uk: 'Транскрипт (UK)' };
  return `<div class="item hit">${mark(h.subject_color)}<div class="main">
      <a class="t" href="#/lesson/${h.lesson_id}" data-open="summary">${esc(h.title || 'Урок')}</a>
      <div class="meta">${esc(h.subject_name || 'Без предмета')} · ${fmtDate(h.recorded_at)}</div>
      ${h.snippets.map((x) => `<a class="snip" href="#/lesson/${h.lesson_id}" data-open="${x.where === 'summary' ? 'summary' : 'transcript:' + x.where}">
        <span class="where">${where[x.where] || ''}</span>${hl(x.text)}</a>`).join('')}
    </div></div>`;
}

async function viewLesson(id) {
  const l = await api('/lessons/' + id);
  await loadSubjects();
  const a = l.analysis || {};
  const tab = store.get('lessonTab', 'summary');
  const busy = l.status === 'queued' || l.status === 'processing';

  app.innerHTML = `
    <div class="row"><a href="#/lessons">← Уроки</a><span class="spacer"></span><button class="ghost" id="menu">•••</button></div>
    <div class="lesson-hero" style="--c:${esc(l.subject_color || '#666')}">${mark(l.subject_color)}
      <div><div class="small muted"><a href="#/subject/${l.subject_id}">${esc(l.subject_name || 'Без предмета')}</a> · ${fmtDate(l.recorded_at)} ${fmtTime(l.recorded_at)}
        ${l.duration_sec ? ' · ' + fmtDur(l.duration_sec) : ''}</div>
      <h1>${esc(l.title || a.title || 'Урок')}</h1>
      ${a.topic_pl ? `<div class="muted small">PL: ${esc(a.topic_pl)}</div>` : ''}</div></div>
    ${l.status === 'recording' ? `<div class="card warn">Запис не завершено (можливо, сторінку закрили під час уроку).
      <div class="row" style="margin-top:8px"><button class="primary" id="finishNow">Обробити те, що записано</button></div></div>` : ''}
    ${busy ? `<div class="card"><b>${l.status === 'queued' ? 'В черзі на обробку' : esc(l.progress || 'Обробка…')}</b>
      <p class="muted small">Можна закрити сторінку: обробка йде на сервері.</p></div>` : ''}
    ${l.status === 'error' ? `<div class="card err"><b>Помилка обробки</b><p class="small">${esc(l.error)}</p>
      <button id="retry">Спробувати ще раз</button></div>` : ''}
    ${l.interruptions ? `<p class="small" style="color:var(--warn)">Запис переривався ${l.interruptions} раз(и), частина уроку може бути відсутня.</p>` : ''}
    ${l.has_audio ? `<div class="sticky"><audio id="player" controls preload="metadata" src="/api/lessons/${l.id}/audio"></audio></div>` : ''}
    ${l.analysis || l.transcript ? `
      <div class="seg">
        ${[['summary', 'Konspekt'], ['homework', `Домашка${l.homework.length ? ' (' + l.homework.length + ')' : ''}`], ['terms', 'Слова'],
          ['transcript', 'Транскрипт'], ['chat', 'Запитати AI']].map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}
      </div>
      <div id="tabbody"></div>` : ''}`;

  const body = $('#tabbody');
  const drawTab = (t, question = null) => {
    store.set('lessonTab', t);
    $$('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'summary') {
      body.innerHTML = l.analysis ? `<div class="doc"><div class="doc-main">
        ${a.announcements?.length ? `<div class="card warn"><b>Важливо</b><ul>${a.announcements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${a.key_points?.length ? `<h2>Najważniejsze</h2><ul class="points">${a.key_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <h2>Konspekt</h2><div class="md konspekt">${md(a.summary)}</div>
        ${a.explanation ? `<h2>Пояснення українською</h2><div class="md">${md(a.explanation)}</div>` : ''}
        ${a.review_questions?.length ? `<h2>Sprawdź się</h2><ol class="points questions">${a.review_questions.map((x, i) => `<li>${esc(x)}
          <button class="ghost small" data-q="${i}">Відповідь</button></li>`).join('')}</ol>` : ''}
        </div><nav class="toc" aria-label="Зміст"></nav></div>` : '<p class="muted">Аналіз ще не готовий.</p>';
      enhance(body);
      buildToc(body);
      $$('[data-q]', body).forEach((b) => b.onclick = () =>
        drawTab('chat', `Дай коротку відповідь на питання з цього уроку: «${a.review_questions[+b.dataset.q]}»`));
    } else if (t === 'homework') {
      body.innerHTML = l.homework.length ? l.homework.map(hwItem).join('') : '<p class="muted">На цьому уроці домашнього не задавали (або AI його не почув).</p>';
      bindHomework(body);
    } else if (t === 'terms') {
      renderTerms(body, a.terms || []);
    } else if (t === 'transcript') {
      let lang = store.get('trLang', l.transcript_uk ? 'uk' : 'pl');
      const drawTr = () => {
        const text = lang === 'uk' ? l.transcript_uk : l.transcript;
        body.innerHTML = `<div class="seg" style="margin-top:0">
            <button data-lang="uk" class="${lang === 'uk' ? 'on' : ''}" ${l.transcript_uk ? '' : 'disabled'}>Українською</button>
            <button data-lang="pl" class="${lang === 'pl' ? 'on' : ''}">Оригінал (PL)</button></div>
          <div class="transcript">${transcriptHtml(text)}</div>`;
        $$('[data-lang]', body).forEach((b) => b.onclick = () => { lang = b.dataset.lang; store.set('trLang', lang); drawTr(); });
        $$('.ts', body).forEach((s) => s.onclick = () => {
          const p = $('#player');
          if (p) { p.currentTime = +s.dataset.t; p.play(); }
        });
        followAudio(body);
      };
      drawTr();
    } else if (t === 'chat') {
      if (!l.subject_id) { body.innerHTML = '<p class="muted">Призначте уроку предмет, щоб питати AI.</p>'; return; }
      renderChat(body, l.subject_id, l.id, 'Наприклад: «Поясни простіше, що таке…» або «Що треба вивчити до контрольної?»', question);
    }
  };
  if (body) {
    $$('[data-tab]').forEach((b) => b.onclick = () => drawTab(b.dataset.tab));
    drawTab(tab);
  }

  if ($('#retry')) $('#retry').onclick = async () => { await api(`/lessons/${id}/retry`, { method: 'POST' }); viewLesson(id); };
  if ($('#finishNow')) $('#finishNow').onclick = async () => {
    const a2 = store.get('activeRec');
    if (a2 && a2.lessonId === l.id) store.del('activeRec');
    await uploader.finish(l.id, l.interruptions);
    await sleep(800);
    viewLesson(id);
  };
  $('#menu').onclick = () => lessonMenu(l, () => {
    if (body && store.get('lessonTab') !== 'summary') drawTab('summary');
    // Give mermaid a moment to finish drawing before the print dialog snapshots the page.
    setTimeout(() => window.print(), 600);
  });
  if (busy || (l.status === 'recording' && store.get('activeRec')?.lessonId !== l.id)) poll(() => viewLesson(id), 5000, true);
}

function transcriptHtml(text) {
  if (!text) return '<p class="muted">Немає.</p>';
  return text.split(/\n{2,}/).map((p) => {
    const m = p.match(/^\s*\[(\d{1,3}):(\d{2})\]\s*/);
    if (!m) return `<p>${esc(p)}</p>`;
    const secs = +m[1] * 60 + +m[2];
    return `<p><span class="ts" data-t="${secs}">${m[1]}:${m[2]}</span>${esc(p.slice(m[0].length))}</p>`;
  }).join('');
}

// Side table of contents for the konspekt: sticky column on wide screens, a sheet behind a button on phones.
function buildToc(root) {
  const nav = $('.toc', root);
  const main = $('.doc-main', root);
  if (!nav || !main) return;
  const heads = $$(':scope > h2, .md h1, .md h2, .md h3', main).filter((h) => h.textContent.trim());
  if (heads.length < 3) { nav.remove(); return; }
  const level = (h) => (h.parentElement === main ? 1 : h.tagName === 'H3' ? 3 : 2);
  heads.forEach((h, i) => { h.id = 'sec-' + i; });
  const links = heads.map((h, i) => `<a href="#" data-sec="${i}" class="l${level(h)}">${esc(h.textContent.trim())}</a>`).join('');
  nav.innerHTML = `<div class="label">Зміст</div>${links}`;
  const fab = document.createElement('button');
  fab.className = 'toc-fab';
  fab.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M8 12h12M8 18h12"/></svg>Зміст';
  root.appendChild(fab);

  const jump = (i) => heads[+i].scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $$('[data-sec]', nav).forEach((a) => a.onclick = (e) => { e.preventDefault(); jump(a.dataset.sec); });
  fab.onclick = () => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal toc-sheet"><nav class="toc-list">${nav.innerHTML}</nav></div>`;
    $$('[data-sec]', bg).forEach((a) => {
      a.classList.toggle('on', a.dataset.sec === String(current));
      a.onclick = (e) => { e.preventDefault(); bg.remove(); jump(a.dataset.sec); };
    });
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    document.body.appendChild(bg);
  };

  // Scroll spy: highlight the section currently at the top of the screen.
  let current = -1, queued = false;
  const spy = () => {
    queued = false;
    if (!nav.isConnected) { removeEventListener('scroll', onScroll); fab.remove(); return; }
    const line = 110;
    let idx = 0;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top < line) idx = i; });
    if (idx === current) return;
    current = idx;
    $$('[data-sec]', nav).forEach((a) => a.classList.toggle('on', +a.dataset.sec === idx));
    const on = $('.on', nav);
    if (on && nav.scrollHeight > nav.clientHeight) on.scrollIntoView({ block: 'nearest' });
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(spy); } };
  addEventListener('scroll', onScroll, { passive: true });
  spy();
}

// Vocabulary: plain list or flip cards, with Polish pronunciation through the browser's speech engine.
function speak(text) {
  if (!window.speechSynthesis) return toast('Цей браузер не вміє озвучувати текст');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL';
  u.voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').startsWith('pl')) || null;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

const SPEAKER = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

function renderTerms(el, terms) {
  if (!terms.length) { el.innerHTML = '<p class="muted">Немає термінів.</p>'; return; }
  let mode = store.get('termsMode', 'list');
  let order = terms.map((_, i) => i), pos = 0, flipped = false, again = [];
  const draw = () => {
    store.set('termsMode', mode);
    const head = `<div class="seg" style="margin-top:0">
        <button data-m="list" class="${mode === 'list' ? 'on' : ''}">Список</button>
        <button data-m="cards" class="${mode === 'cards' ? 'on' : ''}">Картки</button></div>`;
    if (mode === 'list') {
      el.innerHTML = head + `<div class="list">${terms.map((x, i) => `<div class="item term-row">
        <div class="main"><div class="pl">${esc(x.pl)} <span class="muted">— ${esc(x.uk)}</span></div>
        ${x.explanation ? `<div class="muted small">${esc(x.explanation)}</div>` : ''}</div>
        <button class="ghost" data-say="${i}" aria-label="Озвучити">${SPEAKER}</button></div>`).join('')}</div>`;
    } else if (pos >= order.length) {
      el.innerHTML = head + `<div class="flash done"><div class="big">Готово</div>
        <p class="muted">${again.length ? `Повторити ще раз: ${again.length} з ${terms.length}` : 'Усі слова знаєш.'}</p>
        <div class="row wrap" style="justify-content:center">${again.length ? '<button class="primary" id="fc-again">Повторити складні</button>' : ''}
        <button id="fc-restart">Почати спочатку</button></div></div>`;
    } else {
      const x = terms[order[pos]];
      el.innerHTML = head + `<div class="fc-top"><span class="muted small">${pos + 1} / ${order.length}</span>
          <div class="progressbar"><div style="width:${100 * pos / order.length}%"></div></div>
          <button class="ghost small" id="fc-shuffle">Перемішати</button></div>
        <button class="flash ${flipped ? 'back' : ''}" id="fc-card" aria-live="polite">
          <span class="big">${esc(flipped ? x.uk : x.pl)}</span>
          ${flipped && x.explanation ? `<span class="muted">${esc(x.explanation)}</span>` : ''}
          ${flipped ? `<span class="muted small">PL: ${esc(x.pl)}</span>` : '<span class="muted small">Натисни, щоб побачити переклад</span>'}
        </button>
        <div class="fc-actions">
          <button data-say="${order[pos]}">${SPEAKER}Озвучити</button>
          <span class="spacer"></span>
          <button id="fc-no">Ще не знаю</button><button class="primary" id="fc-yes">Знаю</button>
        </div>
        <p class="muted small fc-hint">Клавіші: пробіл — перевернути, ← не знаю, → знаю.</p>`;
    }
    $$('[data-m]', el).forEach((b) => b.onclick = () => { mode = b.dataset.m; draw(); });
    $$('[data-say]', el).forEach((b) => b.onclick = () => speak(terms[+b.dataset.say].pl));
    const next = (known) => { if (!known) again.push(order[pos]); pos++; flipped = false; draw(); };
    if ($('#fc-card', el)) {
      $('#fc-card', el).onclick = () => { flipped = !flipped; draw(); };
      $('#fc-yes', el).onclick = () => next(true);
      $('#fc-no', el).onclick = () => next(false);
      $('#fc-shuffle', el).onclick = () => { order = order.slice(pos).sort(() => Math.random() - 0.5); pos = 0; flipped = false; draw(); };
    }
    if ($('#fc-again', el)) $('#fc-again', el).onclick = () => { order = again; again = []; pos = 0; draw(); };
    if ($('#fc-restart', el)) $('#fc-restart', el).onclick = () => { order = terms.map((_, i) => i); again = []; pos = 0; draw(); };
  };
  const onKey = (e) => {
    if (!el.isConnected) { removeEventListener('keydown', onKey); return; }
    if (mode !== 'cards' || pos >= order.length || e.target.matches('input, textarea, select')) return;
    if (e.key === ' ') { e.preventDefault(); flipped = !flipped; draw(); }
    else if (e.key === 'ArrowRight') $('#fc-yes', el)?.click();
    else if (e.key === 'ArrowLeft') $('#fc-no', el)?.click();
  };
  addEventListener('keydown', onKey);
  draw();
}

// Transcript follows the audio: the paragraph being played is highlighted and kept in view.
function followAudio(el) {
  const p = $('#player');
  const paras = $$('.transcript p', el).filter((x) => $('.ts', x));
  if (!p || !paras.length) return;
  const times = paras.map((x) => +$('.ts', x).dataset.t);
  let cur = -1;
  const sync = () => {
    if (!el.isConnected) { p.removeEventListener('timeupdate', sync); return; }
    let i = -1;
    times.forEach((t, k) => { if (t <= p.currentTime + 0.5) i = k; });
    if (i === cur) return;
    paras[cur]?.classList.remove('now');
    cur = i;
    if (i < 0) return;
    paras[i].classList.add('now');
    const r = paras[i].getBoundingClientRect();
    if (!p.paused && (r.top < 90 || r.bottom > innerHeight - 90)) paras[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  p.addEventListener('timeupdate', sync);
  sync();
}

function lessonMenu(l, onPrint) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <label>Назва</label><input id="m-title" value="${esc(l.title || '')}">
    <label>Предмет</label><select id="m-subj">${subjectsCache.map((s) => `<option value="${s.id}" ${s.id === l.subject_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    <div class="row" style="margin-top:14px"><button class="primary" id="m-save">Зберегти</button><span class="spacer"></span><button id="m-close">Закрити</button></div>
    <div class="row wrap" style="margin-top:20px">
      <button id="m-print">Друк / PDF</button>
      <button id="m-copy">Копіювати конспект</button>
      <button id="m-reanalyze">Переробити AI-аналіз</button>
      <button id="m-full">Розпізнати заново</button>
      <button class="danger" id="m-del">Видалити урок</button>
    </div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.onclick = (e) => { if (e.target === bg) close(); };
  $('#m-close', bg).onclick = close;
  $('#m-save', bg).onclick = async () => {
    await api('/lessons/' + l.id, { method: 'PATCH', json: { title: $('#m-title', bg).value, subject_id: +$('#m-subj', bg).value } });
    close(); viewLesson(l.id);
  };
  $('#m-print', bg).onclick = () => { close(); onPrint(); };
  $('#m-copy', bg).onclick = async () => {
    const a = l.analysis || {};
    const parts = [`# ${l.title || a.title || 'Урок'}`, a.summary || ''];
    if (a.terms?.length) parts.push('## Słowa\n\n' + a.terms.map((x) => `- **${x.pl}** — ${x.uk}`).join('\n'));
    try { await navigator.clipboard.writeText(parts.join('\n\n')); toast('Конспект скопійовано (Markdown)'); }
    catch { toast('Не вдалося скопіювати'); }
    close();
  };
  $('#m-reanalyze', bg).onclick = async () => {
    // Keep the transcript, redo summary/homework/translation.
    await api(`/lessons/${l.id}/retry?mode=analysis`, { method: 'POST' });
    close(); toast('Аналіз запущено'); viewLesson(l.id);
  };
  $('#m-full', bg).onclick = async () => {
    if (!confirm('Розпізнати аудіо заново? Поточний транскрипт і аналіз буде замінено.')) return;
    await api(`/lessons/${l.id}/retry?mode=full`, { method: 'POST' });
    close(); viewLesson(l.id);
  };
  $('#m-del', bg).onclick = async () => {
    if (!confirm('Видалити урок разом із записом?')) return;
    await api('/lessons/' + l.id, { method: 'DELETE' });
    close(); location.hash = '#/lessons';
  };
}

const hwItem = (h) => hwRow(h, true);

function bindHomework(el) {
  $$('[data-hw]', el).forEach((c) => c.onchange = async () => {
    await api('/homework/' + c.dataset.hw, { method: 'PATCH', json: { done: c.checked } });
    c.closest('.hw').classList.toggle('done', c.checked);
  });
}

async function viewHomework() {
  let showDone = store.get('hwDone', false);
  const draw = async () => {
    const list = await api('/homework?include_done=' + showDone);
    app.innerHTML = `<h1>Домашка</h1>
      <label class="row small muted"><input type="checkbox" id="showdone" ${showDone ? 'checked' : ''}> Показати виконані</label>
      <div class="list">${list.map(hwItem).join('') || '<div class="empty">Відкритих завдань немає.</div>'}</div>`;
    bindHomework(app);
    $('#showdone').onchange = (e) => { showDone = e.target.checked; store.set('hwDone', showDone); draw(); };
  };
  await draw();
}

async function viewSubjects() {
  const subjects = await loadSubjects();
  app.innerHTML = `<h1>Предмети</h1>
    <div class="list">${subjects.map((s) => `<div class="item">${mark(s.color)}
      <a class="main" href="#/subject/${s.id}"><div class="t">${esc(s.name)}</div>
        <div class="meta">${s.lessons} урок.${s.open_homework ? ` · ${s.open_homework} відкритих дз` : ''}</div></a>
      <button class="ghost" data-edit="${s.id}">Змінити</button></div>`).join('') || '<div class="empty">Предметів ще немає.</div>'}</div>
    <h2>Додати предмет</h2>
    <form id="add" class="row"><input id="name" placeholder="Назва, напр. Фізика" required>
      <input type="color" id="color" value="${COLORS[subjects.length % COLORS.length]}"><button class="primary">+</button></form>
    <div class="chips" style="margin-top:10px">${SUGGESTED.filter((n) => !subjects.some((s) => s.name === n)).map((n) => `<button data-add="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>`;
  $('#add').onsubmit = async (e) => {
    e.preventDefault();
    await api('/subjects', { method: 'POST', json: { name: $('#name').value, color: $('#color').value } });
    viewSubjects();
  };
  $$('[data-add]').forEach((b) => b.onclick = async () => {
    await api('/subjects', { method: 'POST', json: { name: b.dataset.add, color: COLORS[subjectsCache.length % COLORS.length] } });
    viewSubjects();
  });
  $$('[data-edit]').forEach((b) => b.onclick = () => {
    const s = subjects.find((x) => x.id === +b.dataset.edit);
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal"><label>Назва</label><input id="e-name" value="${esc(s.name)}">
      <label>Колір</label><input type="color" id="e-color" value="${esc(s.color)}">
      <div class="row" style="margin-top:16px"><button class="danger" id="e-del">Видалити</button><span class="spacer"></span>
      <button id="e-close">Скасувати</button><button class="primary" id="e-save">Зберегти</button></div></div>`;
    document.body.appendChild(bg);
    $('#e-close', bg).onclick = () => bg.remove();
    $('#e-save', bg).onclick = async () => {
      await api('/subjects/' + s.id, { method: 'PATCH', json: { name: $('#e-name', bg).value, color: $('#e-color', bg).value } });
      bg.remove(); viewSubjects();
    };
    $('#e-del', bg).onclick = async () => {
      if (!confirm(`Видалити предмет «${s.name}»? Уроки залишаться, але без предмета, а чат буде видалено.`)) return;
      await api('/subjects/' + s.id, { method: 'DELETE' });
      bg.remove(); viewSubjects();
    };
  });
}

async function viewSubject(id) {
  const [subjects, lessons] = await Promise.all([loadSubjects(), api('/lessons?subject_id=' + id)]);
  const s = subjects.find((x) => x.id === id);
  if (!s) { app.innerHTML = '<p>Предмет не знайдено.</p>'; return; }
  let tab = store.get('subjTab', 'chat');
  app.innerHTML = `<div class="row"><a href="#/subjects">← Предмети</a></div>
    <div class="lesson-hero" style="--c:${esc(s.color)}">${mark(s.color)}<div><div class="small muted">${s.lessons} урок(ів)${s.open_homework ? ` · ${s.open_homework} домашніх` : ''}</div><h1>${esc(s.name)}</h1></div></div>
    <div class="seg"><button data-t="chat">Запитати AI</button><button data-t="lessons">Уроки (${lessons.length})</button></div>
    <div id="sbody"></div>`;
  const body = $('#sbody');
  const draw = () => {
    store.set('subjTab', tab);
    $$('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    if (tab === 'lessons') body.innerHTML = `<div class="list">${lessons.map(lessonCard).join('') || '<div class="empty">Ще немає уроків з цього предмета.</div>'}</div>`;
    else renderChat(body, id, null, 'Питай будь-що по предмету: «Що ми проходили цього місяця?», «Поясни тему з останнього уроку», «Яке домашнє на завтра?»');
  };
  $$('[data-t]').forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(); });
  draw();
}

async function renderChat(el, subjectId, lessonId, placeholder, question = null) {
  const q = lessonId ? '?lesson_id=' + lessonId : '';
  const history = await api(`/subjects/${subjectId}/chat${q}`);
  el.innerHTML = `<div class="chat" id="msgs"></div>
    <div class="chatbox"><textarea id="ask" rows="1" placeholder="${esc(placeholder)}"></textarea><button class="primary" id="send">↑</button></div>
    ${history.length ? '<button class="ghost small" id="clear">Очистити чат</button>' : ''}`;
  const msgs = $('#msgs', el);
  const add = (role, content) => {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = role === 'assistant' ? `<div class="md">${md(content)}</div>` : esc(content);
    if (role === 'assistant') enhance(d);
    msgs.appendChild(d);
    return d;
  };
  if (!history.length) msgs.innerHTML = `<p class="muted small">${lessonId ? 'AI бачить повний текст цього уроку і всі інші уроки з предмета.' : 'AI шукає відповідь у ваших уроках з цього предмета.'}</p>`;
  history.forEach((m) => add(m.role, m.content));
  const ask = $('#ask', el);
  ask.oninput = () => { ask.style.height = 'auto'; ask.style.height = Math.min(140, ask.scrollHeight) + 'px'; };
  const send = async () => {
    const text = ask.value.trim();
    if (!text) return;
    ask.value = ''; ask.oninput();
    if (!history.length) msgs.innerHTML = '';
    history.push(1);
    add('user', text);
    const wait = add('assistant', '…');
    wait.scrollIntoView({ behavior: 'smooth', block: 'end' });
    $('#send', el).disabled = true;
    try {
      const { reply } = await api(`/subjects/${subjectId}/chat`, { method: 'POST', json: { message: text, lesson_id: lessonId } });
      wait.innerHTML = `<div class="md">${md(reply)}</div>`;
      enhance(wait);
    } catch (e) {
      wait.innerHTML = `<span style="color:var(--rec)">${esc(e.message)}</span>`;
    }
    $('#send', el).disabled = false;
    wait.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#send', el).onclick = send;
  ask.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover)').matches) { e.preventDefault(); send(); } };
  if (question) { ask.value = question; send(); }
  if ($('#clear', el)) $('#clear', el).onclick = async () => {
    if (!confirm('Очистити історію чату?')) return;
    await api(`/subjects/${subjectId}/chat${q}`, { method: 'DELETE' });
    renderChat(el, subjectId, lessonId, placeholder);
  };
}

// ---------- router ----------
function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }
function poll(fn, ms, keepScroll = false) {
  stopPoll();
  const hash = location.hash;
  pollTimer = setTimeout(async () => {
    if (location.hash !== hash || recorder || document.querySelector('.modal-bg')) return poll(fn, ms, keepScroll);
    // Do not redraw while the user is typing a question.
    if (document.activeElement?.matches('textarea, input[type=search]')) return poll(fn, ms, keepScroll);
    const y = scrollY;
    await fn();
    if (keepScroll) scrollTo(0, y);
  }, ms);
}

async function route() {
  if (recorder) return renderRecording();
  stopPoll();
  const h = location.hash.replace(/^#/, '') || '/';
  const [, page, arg] = h.split('/');
  $('#tabs').hidden = false;
  const tabName = { '': 'home', lessons: 'lessons', lesson: 'lessons', homework: 'homework', subjects: 'subjects', subject: 'subjects' }[page || ''];
  $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tabName));
  try {
    if (!page) await viewHome();
    else if (page === 'lessons') await viewLessons();
    else if (page === 'lesson') await viewLesson(+arg);
    else if (page === 'homework') await viewHomework();
    else if (page === 'subjects') await viewSubjects();
    else if (page === 'subject') await viewSubject(+arg);
    else await viewHome();
  } catch (e) {
    if (e.status !== 401) app.innerHTML = `<div class="card err">Помилка: ${esc(e.message)} <button onclick="location.reload()">Оновити</button></div>`;
  }
}

window.addEventListener('hashchange', () => { scrollTo(0, 0); route(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
$('#sideRec').onclick = () => recordSelected();
uploader.run();
route();
