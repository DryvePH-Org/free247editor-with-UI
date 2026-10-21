// free247editor app. Plain JS, no build step. Each view renders a layout once, then named
// regions re-render only when their HTML changes, so typing and video playback are never interrupted.
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;

const S = {
  renaming: null,   // slug whose title is being edited
  state: null,
  job: null,
  setupLog: null,
  sel: {},          // selected version per project
  noteTarget: {},   // 'vertical' | 'horizontal' per project
  pick: [],         // inbox clips picked for the next video, in the order they were picked
  dialog: null,     // { files, keep } while the new-video dialog is open
  brandPick: null,  // { slot, category } for the brand file picker
  extraCats: [],    // B-roll groups added this session that have no clips yet
  styleMode: 'read',
  rulesMode: 'read',
  wizard: { step: 0, answers: {} },
  docs: { style: undefined, rules: undefined, brandRules: undefined, styleReply: null },
};

// ---------- icons (Phosphor, see icons.js) ----------
const icon = (name) => `<svg class="ico" viewBox="0 0 256 256" aria-hidden="true">${window.ICONS?.[name] || ''}</svg>`;
const I = {
  check: icon('check'), play: icon('play'), up: icon('upload-simple'), folder: icon('folder-simple'), down: icon('download-simple'),
  stop: icon('stop'), send: icon('paper-plane-tilt'), star: icon('star-four'), wide: icon('monitor-play'), film: icon('film-strip'),
  image: icon('image'), text: icon('file-text'), music: icon('music-notes'), x: icon('x'), warn: icon('warning-circle'),
  edit: icon('pencil-simple-line'), style: icon('pencil-simple'), brand: icon('storefront'), pack: icon('package'),
  lock: icon('lock-simple'), clock: icon('clock'), retry: icon('arrow-clockwise'), wrench: icon('wrench'), plus: icon('plus'),
  trash: icon('trash'), left: icon('arrow-left'), right: icon('arrow-right'), id: icon('identification-card'), share: icon('export'),
  importIco: icon('tray-arrow-down'), queue: icon('queue'), soundOn: icon('speaker-high'), soundOff: icon('speaker-slash'),
};
for (const el of document.querySelectorAll('i[data-icon]')) el.outerHTML = icon(el.dataset.icon);
const kindIcon = (k) => ({ video: I.film, image: I.image, text: I.text, audio: I.music })[k] || I.text;

// ---------- formatting ----------
const fmtDur = (s) => { if (!s) return ''; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} day${s < 172800 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const elapsed = (since) => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const tapeLabel = (l) => l === 'final' ? 'Final' : l === 'horizontal-final' ? 'YouTube final' : l.startsWith('horizontal-') ? `YouTube ${l.slice(11)}` : l;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const prettyCat = (c) => c.replace(/-/g, ' ').replace(/^\w/, (x) => x.toUpperCase());
const JOB_LABEL = { edit: 'New video', notes: 'Notes', final: 'Final version', horizontal: 'YouTube version', style: 'Style update', setup: 'Setup' };

// Small markdown: headings, lists, tables, quotes, code, bold, italics, links.
const inline = (t) => esc(t)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { const n = Math.min(h[1].length, 3); html += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }
    if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l); i += 2;
      let body = '';
      while (i < lines.length && /^\s*\|/.test(lines[i])) body += `<tr>${cells(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      let items = '';
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items))) {
        const t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items += `<li>${inline(t)}`; else items += ` ${inline(t.trim())}`;
        i++;
      }
      html += `<${ordered ? 'ol' : 'ul'}>${items.split('<li>').filter(Boolean).map((x) => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(buf.join(' '))}</blockquote>`; continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*+]|\d+[.)])\s|>|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    html += `<p>${inline(buf.join(' '))}</p>`;
  }
  return html;
}

// ---------- network ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function toast(text, { bad = false, link = null, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.innerHTML = `<span>${esc(text)}</span>${link ? `<a href="${esc(link.href)}">${esc(link.label)}</a>` : ''}`;
  $('.toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
const fail = (e) => toast(e.message || String(e), { bad: true, ms: 7000 });

// ---------- live updates ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { S.state = JSON.parse(e.data); S.job = S.state.job; refresh(); });
  es.addEventListener('job', (e) => { S.job = JSON.parse(e.data); refresh(); });
  es.addEventListener('setup', (e) => { S.setupLog = JSON.parse(e.data); refresh(); });
  es.addEventListener('done', (e) => onDone(JSON.parse(e.data)));
  es.onerror = () => { document.title = 'free247editor (reconnecting…)'; };
}

function onDone(d) {
  if (d.kind === 'style') {
    S.docs.style = undefined; S.docs.styleReply = { text: d.text, error: d.error };
    if (route().name === 'style') loadDoc('style');
  }
  const proj = S.state?.projects.find((p) => p.slug === d.slug);
  const name = proj?.title || 'Your video';
  if (d.kind === 'setup') toast(d.error ? 'Setup ran into a problem. Open Setup to read why.' : 'Setup check finished.', { bad: d.error, link: { href: '#/setup', label: 'Open' }, ms: 9000 });
  else if (d.error) toast(`${name}: the editor ran into a problem. Open it to see what happened.`, { bad: true, link: d.slug ? { href: `#/p/${d.slug}`, label: 'Open' } : null, ms: 10000 });
  else if (d.text?.startsWith('Stopped')) toast('Stopped.');
  else if (d.kind !== 'style' && !d.newVersion) toast(`The editor replied about ${name}.`, { link: d.slug ? { href: `#/p/${d.slug}`, label: 'Read' } : null, ms: 9000 });
  else if (d.kind !== 'style') toast(`${name} is ready to watch.`, { link: d.slug ? { href: `#/p/${d.slug}`, label: 'Watch' } : null, ms: 9000 });
  else toast('Your style was updated.');
  if (d.ruleSaved) { S.docs.rules = undefined; toast('A note was saved as a lasting rule.', { link: { href: '#/rules', label: 'See rules' }, ms: 9000 }); }
  if (d.slug) delete S.sel[d.slug]; // jump to the newest version
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(d.error ? 'The editor needs you' : `${name} is ready`, { body: d.error ? 'Something went wrong. Open the app to see.' : 'Open free247editor to watch it.', icon: '/icon.svg' });
  }
}

// ---------- routing & regions ----------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  return { name: name === 'p' ? 'project' : name === 'f' ? 'folder' : name || 'studio', arg: arg ? decodeURIComponent(arg) : null };
}
let current = { key: null, view: null };
const regionCache = new Map();

function refresh() {
  if (!S.state) return;
  // The page files update on disk right away, but a server started before an update sends older data.
  if (!S.state.brand || !S.state.queue) {
    current = { key: 'outdated', view: null };
    $('#main').innerHTML = `<div class="banner alert">${I.warn}<div><strong>The app was updated. Restart it to finish.</strong>
      <span class="muted">Close the black app window (or press Ctrl+C in it), then double-click Open Editor again.</span></div></div>`;
    return;
  }
  const r = route();
  const key = `${r.name}:${r.arg || ''}`;
  if (key !== current.key) {
    current = { key, view: VIEWS[r.name] || VIEWS.studio };
    regionCache.clear();
    $('#main').innerHTML = current.view.layout(r.arg);
    for (const a of $$('.nav')) if (a.dataset.nav === ({ project: 'videos', folder: 'studio' }[r.name] || r.name)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    window.scrollTo(0, 0);
    current.view.enter?.(r.arg);
  }
  const regions = { ...current.view.regions, ...GLOBAL };
  for (const el of $$('[data-region], [data-region-global]')) {
    const name = el.dataset.region || el.dataset.regionGlobal;
    const fn = regions[name];
    if (!fn) continue;
    const html = fn(r.arg);
    if (regionCache.get(el) !== html) { regionCache.set(el, html); el.innerHTML = html; }
  }
  current.view.after?.(r.arg);
  reattachPreview();
  const s = S.state.setup;
  $('[data-setup-flag]').hidden = setupReady(s);
  document.title = S.job ? `● Editing: ${S.job.title || ''}` : 'free247editor';
}
window.addEventListener('hashchange', () => { for (const d of $$('dialog[open]')) d.close(); S.renaming = null; refresh(); });
setInterval(() => { for (const el of $$('[data-since]')) el.textContent = elapsed(Number(el.dataset.since)); }, 1000);

const rendererOk = (s) => s.chrome || s.testVideo;
const setupReady = (s) => s.node && s.git && s.ffmpeg && s.claude && s.kit && rendererOk(s) && (s.groq || s.localWhisper);
const busy = () => Boolean(S.job);
const win = () => S.state?.setup.platform === 'win32';
const jobHref = (j) => (j.slug ? `#/p/${enc(j.slug)}` : j.kind === 'style' ? '#/style' : '#/setup');
const queueOf = (slug) => S.state.queue.findIndex((q) => q.slug === slug);

const GLOBAL = {
  sideStatus: () => {
    if (!S.job) return '';
    const last = S.job.steps.at(-1);
    const waiting = S.state.queue.length;
    return `<a class="mini" href="${jobHref(S.job)}">
      <b><i class="live"></i> Editing now <time data-since="${S.job.startedAt}">${elapsed(S.job.startedAt)}</time></b>
      <span>${esc(last?.label || 'Starting…')}</span>${waiting ? `<em>${plural(waiting, 'more')} in line</em>` : ''}</a>`;
  },
};

// ---------- shared pieces ----------
function nowCard() {
  const j = S.job;
  if (!j) return '';
  const last = j.steps.at(-1);
  return `<section class="now">
    <div>
      <div class="label"><span class="tape rec sm">Editing now</span><time class="small" data-since="${j.startedAt}">${elapsed(j.startedAt)}</time></div>
      <h2>${esc(j.title || 'Your video')}</h2>
      <p class="step">${esc(last?.label || 'Starting…')}</p>
    </div>
    <a class="btn" href="${jobHref(j)}">Watch progress</a>
  </section>`;
}

function lineCard() {
  const q = S.state.queue;
  if (!q.length) return '';
  return `<section class="upnext" aria-label="Waiting in line">
    <h2 class="sub">${I.queue} Up next</h2>
    <ol>${q.map((x, i) => `<li><span class="pos num">${i + 1}</span>
      <span class="what">${x.slug ? `<a href="#/p/${enc(x.slug)}">${esc(x.title || 'Video')}</a>` : `<b>${esc(x.title || JOB_LABEL[x.type])}</b>`}<small>${esc(JOB_LABEL[x.type] || '')}</small></span>
      <button class="btn quiet sm" data-action="unqueue" data-id="${esc(x.id)}">Remove</button></li>`).join('')}</ol>
    <p class="muted small">They start one after another. You can close this page.</p>
  </section>`;
}

function setupBanners() {
  const s = S.state.setup;
  let out = '';
  if (!setupReady(s)) {
    const missing = [
      [!(s.node && s.git && s.ffmpeg), 'video tools'], [!s.claude, 'Claude Code'], [!s.kit, 'the editing engine'],
      [!rendererOk(s), 'the video renderer'], [!(s.groq || s.localWhisper), 'transcription'],
    ].filter(([bad]) => bad).map(([, label]) => label);
    const list = missing.join(', ').replace(/, ([^,]*)$/, ' and $1');
    out += `<div class="banner alert">${I.warn}<div><strong>Finish setting up first</strong><span class="muted">${esc(list.charAt(0).toUpperCase() + list.slice(1))} ${missing.length > 1 ? 'are' : 'is'} not set up yet.</span></div><a class="btn primary" href="#/setup">Go to setup</a></div>`;
  } else if (!s.style) {
    out += `<div class="banner">${I.style}<div><strong>Pick your style</strong><span class="muted">Import your team's brand pack, or answer a few quick questions. About 2 minutes.</span></div><a class="btn primary" href="#/style">Set my style</a></div>`;
  }
  return out;
}

function projectMedia(p, kind) {
  const v = [...p.versions].reverse().find((x) => !x.label.startsWith('horizontal')) || p.versions.at(-1);
  return v ? `/${kind}/outbox/${enc(v.file)}?t=${Math.round(v.mtime)}` : (p.source ? `/${kind}/inbox/${p.source.split('/').map(enc).join('/')}` : '');
}
const projectThumb = (p) => projectMedia(p, 'thumb');

function projectCard(p) {
  const working = S.job?.slug === p.slug;
  const latest = p.versions.at(-1);
  const final = p.versions.some((v) => v.label.endsWith('final'));
  const tape = working ? '<span class="tape rec sm">Editing…</span>' : p.status === 'queued' ? '<span class="tape pale sm">In line</span>'
    : final ? '<span class="tape sm">Final</span>' : latest ? `<span class="tape pale sm">${esc(tapeLabel(latest.label))}</span>` : '';
  const thumb = projectThumb(p);
  return `<article class="card">
    <a class="cover" href="#/p/${enc(p.slug)}" aria-label="Open ${esc(p.title)}"><span class="thumb"${thumb ? ` data-preview="${projectMedia(p, 'preview')}"` : ''}>${thumb ? `<img src="${thumb}" alt="" loading="lazy" decoding="async">` : ''}${tape}</span></a>
    <div class="body">
      <div><div class="name">${esc(p.title)}</div><div class="meta">${p.versions.length ? `${plural(p.versions.length, 'version')} · ` : ''}${ago(p.updatedAt)}</div></div>
      <a class="btn sm" href="#/p/${enc(p.slug)}">Open</a>
    </div>${S.job?.slug === p.slug || p.status === 'queued' ? '' : delBtn([{ area: 'project', path: p.slug }], `the video “${p.title}” and all its versions`, { cls: 'card-del' })}</article>`;
}

function progressPanel(j, heading, { stop = true } = {}) {
  const steps = j.steps;
  const shown = steps.slice(-8);
  return `<section class="panel">
    <div class="panel-head">
      <h2 class="sub"><span class="live"></span> ${esc(heading)}</h2>
      <div class="row"><time class="muted small" data-since="${j.startedAt}">${elapsed(j.startedAt)}</time>
      ${stop ? `<button class="btn quiet sm danger" data-action="stop" ${j.stopping ? 'disabled' : ''}>${I.stop} Stop</button>` : ''}</div>
    </div>
    ${steps.length > shown.length ? `<p class="muted small" style="margin-top:8px">${steps.length - shown.length} earlier steps done</p>` : ''}
    <ol class="steps">${shown.map((s, i) => {
      const isNow = i === shown.length - 1;
      return `<li class="${isNow ? 'cur' : ''} ${s.kind === 'say' ? 'say' : ''}">${isNow ? '<span class="live"></span>' : I.check}<span>${esc(s.label)}</span><time>${new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></li>`;
    }).join('')}</ol>
    ${j.todos?.length ? `<ul class="todos">${j.todos.map((t) => `<li class="${esc(t.status)}">${esc(t.text)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

// ---------- views ----------
const VIEWS = {};

// ---------- clips (shared by Studio and folders) ----------
const encPath = (p) => p.split('/').map(enc).join('/');
const clipThumb = (f) => `/thumb/inbox/${encPath(f.path)}?t=${Math.round(f.mtime)}`;
const clipPreview = (f) => `/preview/inbox/${encPath(f.path)}?t=${Math.round(f.mtime)}`;
const videosIn = (folder) => S.state.inbox.filter((f) => f.kind === 'video' && f.folder === folder);
// A delete button. Items are what /api/delete takes; "what" names them in the confirmation.
const delBtn = (items, what, { cls = 'btn quiet sm danger', label = 'Delete', icon = true } = {}) =>
  `<button class="${cls}" data-action="delete" data-items="${esc(JSON.stringify(items))}" data-what="${esc(what)}"${cls.includes('icon') || cls.includes('card-del') ? ` aria-label="Delete ${esc(what)}" title="Delete"` : ''}>${icon ? I.trash : ''}${cls.includes('icon') || cls.includes('card-del') ? '' : ` ${label}`}</button>`;

function clipCard(f) {
  const vertical = !f.width || f.height >= f.width;
  const n = S.pick.indexOf(f.path) + 1;
  return `<article class="card pickable${n ? ' on' : ''}">
    <label class="cover">
      <input type="checkbox" class="sr" data-action="pick-clip" data-file="${esc(f.path)}" ${n ? 'checked' : ''}>
      <span class="thumb${vertical ? '' : ' wide'}" data-preview="${clipPreview(f)}"><img src="${clipThumb(f)}" alt="" loading="lazy" decoding="async">
        ${f.edited ? '<span class="tape pale sm">Used</span>' : ''}${f.duration ? `<span class="len">${fmtDur(f.duration)}</span>` : ''}
        <span class="pickmark" aria-hidden="true">${n ? (S.pick.length > 1 ? n : I.check) : ''}</span>
      </span>
      <span class="body"><span><span class="name" title="${esc(f.name)}">${esc(f.name)}</span><span class="meta">${ago(f.mtime)} · ${fmtSize(f.size)}</span></span></span>
    </label>
    ${delBtn([{ area: 'inbox', path: f.path }], f.name, { cls: 'card-del' })}</article>`;
}
const clipGrid = (files, empty) => (files.length ? `<div class="grid">${files.map(clipCard).join('')}</div>` : `<div class="empty">${empty}</div>`);

function selbarHtml() {
  const n = S.pick.length;
  if (!n) return '';
  const total = S.pick.reduce((s, p) => s + (S.state.inbox.find((f) => f.path === p)?.duration || 0), 0);
  return `<div class="selbar" role="region" aria-label="Picked clips">
    <div><b>${plural(n, 'clip')}<span class="wide-only"> picked</span></b><span class="muted small">${total ? `${fmtDur(total)} of footage` : ''}</span></div>
    <div class="row"><button class="btn quiet" data-action="pick-clear" aria-label="Clear picked clips">${I.x}<span class="wide-only">Clear</span></button>
    <button class="btn quiet" data-action="delete-picked" aria-label="Delete picked clips">${I.trash}<span class="wide-only">Delete</span></button>
    <button class="btn primary big" data-action="new-video">${I.play} ${n > 1 ? 'Make one video' : 'Edit this clip'}</button></div></div>`;
}

function extrasHtml(folder) {
  const other = S.state.inbox.filter((f) => f.kind !== 'video' && f.folder === folder);
  if (!other.length) return '';
  return `<div class="section-head"><div><h2>Extras${folder ? '' : ' in your inbox'}</h2><p class="muted small">Logos and contact details work best in <a href="#/brand">My brand</a>, so every video uses them.</p></div>
      ${other.length > 1 ? delBtn(other.map((f) => ({ area: 'inbox', path: f.path })), `${plural(other.length, 'extra file')}`, { label: 'Delete all' }) : ''}</div>
    <div class="extras">${other.map((f) => `<span class="chip-del"><button class="chip" data-action="reveal" data-area="inbox" data-name="${esc(f.name)}" data-folder="${esc(f.folder)}">${kindIcon(f.kind)}${esc(f.name)}</button>${delBtn([{ area: 'inbox', path: f.path }], f.name, { cls: 'btn quiet icon sm' , icon: true })}</span>`).join('')}</div>`;
}

const DROP_HINT = 'All the clips for one video at once, retakes too. MOV and MP4 from your phone are fine.';

VIEWS.studio = {
  layout: () => `
    <div class="page-head"><div><h1>What are we editing today?</h1><p>Drop in the clips for one video. The editor puts them in order, cuts the mistakes, adds captions and graphics in your style, and shows you a draft.</p></div></div>
    <div data-region="banners"></div>
    <div data-region="now"></div>
    <div data-region="line"></div>
    <div class="drop" data-action="pick" role="button" tabindex="0" aria-label="Add clips">
      <div class="slate">${I.up}</div>
      <div><h2><span class="mouse-only">Drop your clips here</span><span class="touch-only">Add your clips</span></h2><p>${DROP_HINT}</p></div>
      <span class="btn primary">Choose clips</span>
    </div>
    <section class="section" data-region="folders"></section>
    <section class="section"><div class="section-head" data-region="inboxHead"></div><div data-region="inbox"></div></section>
    <div class="selbar-slot" data-region="selbar"></div>
    <section class="section" data-region="extras"></section>
    <section class="section" data-region="recent"></section>`,
  enter: () => { S.uploadFolder = ''; S.pick = S.pick.filter((p) => S.state.inbox.some((f) => f.path === p)); },
  regions: {
    banners: setupBanners,
    now: nowCard,
    line: lineCard,
    folders: () => {
      const fs = S.state.folders;
      const tile = (fo) => {
        const clips = videosIn(fo.name);
        const covers = clips.slice(0, 3);
        return `<a class="folder" href="#/f/${enc(fo.name)}" data-drop-folder="${esc(fo.name)}">
          <span class="covers">${covers.length ? covers.map((c) => `<img src="${clipThumb(c)}" alt="" loading="lazy" decoding="async">`).join('') : `<span class="nofile">${I.folder}</span>`}</span>
          <span class="fname">${esc(fo.name)}</span><span class="meta">${clips.length ? plural(clips.length, 'clip') : 'Empty'} · ${ago(fo.mtime)}</span></a>`;
      };
      const form = S.newFolder ? `<form class="folder new" data-form="new-folder"><label class="sr" for="new-folder">Folder name</label>
          <input type="text" id="new-folder" maxlength="60" placeholder="e.g. Promo for October" autocomplete="off">
          <div class="row"><button class="btn primary sm" type="submit">Create</button><button class="btn quiet sm" type="button" data-action="new-folder-cancel">Cancel</button></div></form>`
        : `<button class="folder add" data-action="new-folder">${I.plus}<span>New folder</span></button>`;
      return `<div class="section-head"><div><h2>Folders</h2><p class="muted small">Keep each video's clips together. Drop clips onto a folder to put them in it.</p></div></div>
        <div class="folders">${fs.map(tile).join('')}${form}</div>`;
    },
    inboxHead: () => {
      const vids = videosIn('');
      const fresh = vids.filter((f) => !f.edited);
      return `<div><h2>${S.state.folders.length ? 'Clips not in a folder' : 'Your clips'}</h2>${vids.length ? '<p class="muted small">Tap the clips that belong in one video. Retakes are fine; the editor keeps the best one.</p>' : ''}</div>
        <div class="row">${fresh.length > 1 ? `<button class="btn quiet sm" data-action="pick-new">${I.check} Pick all ${fresh.length} new clips</button>` : ''}
        ${vids.length > 1 ? delBtn(vids.map((f) => ({ area: 'inbox', path: f.path })), plural(vids.length, 'clip'), { label: 'Delete all' }) : ''}
        <button class="btn quiet sm" data-action="reveal" data-area="inbox">${I.folder} Open inbox folder</button></div>`;
    },
    inbox: () => clipGrid(videosIn(''), S.state.folders.length ? 'No loose clips. Your clips are in the folders above.' : 'No clips yet. Drop all the clips for one video above to get started.'),
    selbar: selbarHtml,
    extras: () => extrasHtml(''),
    recent: () => {
      const ps = S.state.projects.slice(0, 4);
      if (!ps.length) return '';
      return `<div class="section-head"><h2>Recent edits</h2><a class="btn quiet sm" href="#/videos">See all</a></div><div class="grid">${ps.map(projectCard).join('')}</div>`;
    },
  },
  after: () => { const i = $('#new-folder'); if (i && S.focusNewFolder) { S.focusNewFolder = false; i.focus(); } },
};

const folderOf = (name) => S.state.folders.find((f) => f.name === name);
VIEWS.folder = {
  layout: (name) => `
    <a class="back" href="#/">${I.left} Studio</a>
    <div data-region="fhead"></div>
    <div class="drop compact" data-action="pick" role="button" tabindex="0" aria-label="Add clips to this folder">
      <div class="slate">${I.up}</div>
      <div><h2><span class="mouse-only">Drop clips into this folder</span><span class="touch-only">Add clips to this folder</span></h2><p>${DROP_HINT}</p></div>
      <span class="btn">Choose clips</span>
    </div>
    <section class="section"><div class="section-head" data-region="fclipsHead"></div><div data-region="fclips"></div></section>
    <div class="selbar-slot" data-region="selbar"></div>
    <section class="section" data-region="fextras"></section>`,
  enter: (name) => { S.uploadFolder = name; S.renamingFolder = false; S.pick = S.pick.filter((p) => S.state.inbox.some((f) => f.path === p)); },
  regions: {
    fhead: (name) => {
      const fo = folderOf(name);
      if (!fo) return '<div class="page-head"><div><h1>Not found</h1><p>This folder is not here anymore. <a href="#/">Back to Studio</a></p></div></div>';
      const clips = videosIn(name);
      const files = S.state.inbox.filter((f) => f.folder === name);
      const title = S.renamingFolder
        ? `<form class="rename" data-form="rename-folder" data-name="${esc(name)}"><label class="sr" for="rename-folder">Folder name</label>
            <input type="text" id="rename-folder" value="${esc(name)}" maxlength="60" autocomplete="off">
            <button class="btn primary" type="submit">Save name</button><button class="btn quiet" type="button" data-action="rename-folder-cancel">Cancel</button></form>`
        : `<div class="title"><h1>${I.folder} ${esc(name)}</h1><button class="btn quiet sm icon" data-action="rename-folder" aria-label="Rename this folder" title="Rename">${I.edit}</button></div>`;
      return `<div class="page-head folder-head"><div>${title}<p>${clips.length ? `${plural(clips.length, 'clip')} · ${fmtDur(clips.reduce((s, c) => s + (c.duration || 0), 0))} of footage` : 'No clips yet.'}</p></div>
        <div class="row">
          ${clips.length ? `<button class="btn primary" data-action="folder-video" data-name="${esc(name)}">${I.play} Make one video from ${clips.length > 1 ? `all ${clips.length}` : 'it'}</button>` : ''}
          <button class="btn" data-action="import-clips" data-name="${esc(name)}">${I.importIco} Add clips from other folders</button>
          ${delBtn([{ area: 'inbox', path: name }], files.length ? `the folder “${name}” and its ${plural(files.length, 'file')}` : `the folder “${name}”`, { label: 'Delete folder' })}
        </div></div>`;
    },
    fclipsHead: (name) => {
      const vids = videosIn(name);
      if (!vids.length) return '';
      return `<div><h2>Clips</h2><p class="muted small">Tap clips to pick some, or make one video from all of them.</p></div>
        <div class="row">${vids.length > 1 ? `<button class="btn quiet sm" data-action="pick-folder" data-name="${esc(name)}">${I.check} Pick all</button>` : ''}
        ${vids.length > 1 ? delBtn(vids.map((f) => ({ area: 'inbox', path: f.path })), `all ${plural(vids.length, 'clip')} in this folder`, { label: 'Delete all clips' }) : ''}
        <button class="btn quiet sm" data-action="reveal" data-area="inbox" data-name="${esc(name)}">${I.folder} Show in folder</button></div>`;
    },
    fclips: (name) => (folderOf(name) ? clipGrid(videosIn(name), `This folder is empty. Drop clips above, or <button class="linkish" data-action="import-clips" data-name="${esc(name)}">add clips from other folders</button>.`) : ''),
    selbar: selbarHtml,
    fextras: (name) => extrasHtml(name),
  },
  after: () => { const i = $('#rename-folder'); if (i && S.focusRenameFolder) { S.focusRenameFolder = false; i.focus(); i.select(); } },
};

function openImportDialog(folder) {
  const others = S.state.inbox.filter((f) => f.kind === 'video' && f.folder !== folder);
  const groups = [['', 'Not in a folder'], ...S.state.folders.filter((fo) => fo.name !== folder).map((fo) => [fo.name, fo.name])]
    .map(([key, label]) => ({ label, files: others.filter((f) => f.folder === key) })).filter((g) => g.files.length);
  const m = $('#modal');
  m.innerHTML = `<form class="inner" method="dialog" data-form="import-clips" data-folder="${esc(folder)}">
    <div class="top"><div><h2 id="modal-title">Add clips to “${esc(folder)}”</h2>
      <p class="muted" style="margin-top:4px">They move here from where they are now.</p></div>
      <button class="btn quiet icon" type="button" data-action="close-modal" aria-label="Close">${I.x}</button></div>
    ${groups.length ? groups.map((g) => `<fieldset class="import-group"><legend><b>${esc(g.label)}</b> <span class="muted small">${plural(g.files.length, 'clip')}</span></legend>
      <div class="import-grid">${g.files.map((f) => `<label class="import-clip"><input type="checkbox" name="clip" value="${esc(f.path)}"><span class="ic-thumb" data-preview="${clipPreview(f)}"><img src="${clipThumb(f)}" alt="" loading="lazy" decoding="async"></span>
        <span class="nm" title="${esc(f.name)}">${esc(f.name)}</span>${f.duration ? `<span class="len">${fmtDur(f.duration)}</span>` : ''}${f.edited ? '<span class="tape pale sm">Used</span>' : ''}</label>`).join('')}</div></fieldset>`).join('')
      : '<div class="empty">There are no clips in other folders.</div>'}
    <div class="row spread foot"><span class="muted small" data-import-count>Pick the clips to move here.</span>
      <button class="btn primary big" type="submit" ${groups.length ? '' : 'disabled'}>${I.importIco} Move here</button></div>
  </form>`;
  m.showModal();
}

VIEWS.videos = {
  layout: () => `
    <div class="page-head"><div><h1>My videos</h1><p>Every edit, with all its versions. Open one to watch, give notes, or make the final.</p></div>
      <div class="row" data-region="vactions"></div></div>
    <div data-region="line"></div>
    <div data-region="list"></div>`,
  regions: {
    vactions: () => {
      const free = S.state.projects.filter((p) => S.job?.slug !== p.slug && p.status !== 'queued');
      return `${free.length > 1 ? delBtn(free.map((p) => ({ area: 'project', path: p.slug })), `all ${plural(free.length, 'video')} and their versions`, { label: 'Delete all' }) : ''}
        <button class="btn" data-action="reveal" data-area="outbox">${I.folder} Open outbox folder</button>`;
    },
    line: lineCard,
    list: () => S.state.projects.length
      ? `<div class="grid">${S.state.projects.map(projectCard).join('')}</div>`
      : '<div class="empty">No edits yet. Go to <a href="#/">Studio</a> and drop in your clips.</div>',
  },
};

VIEWS.project = {
  layout: (slug) => `
    <div class="project-head" data-region="head"></div>
    <div class="project">
      <div class="stage">
        <div class="tapes" data-region="tapes" role="group" aria-label="Versions"></div>
        <div class="monitor" data-region="player"></div>
        <div class="under-player" data-region="under"></div>
        <div data-region="notdone"></div>
      </div>
      <div class="col">
        <p class="sr" aria-live="polite" data-region="liveStep"></p>
        <div data-region="progress" hidden></div>
        <section class="panel"><h2 class="sub">Notes and replies</h2><div class="talk" data-region="talk"></div></section>
        <section class="panel">
          <div class="composer">
            <div class="panel-head"><h2 class="sub"><label for="note">What should change?</label></h2><div data-region="target"></div></div>
            <textarea id="note" placeholder="Write like you would to a human editor. English, Tagalog or Taglish all work.&#10;Example: At 0:04 mas mabilis yung cut, and make the captions bigger."></textarea>
            <div class="ideas" aria-label="Quick ideas">
              <button type="button" class="stamp" data-action="stamp" title="Adds the time where the video is paused">${I.clock} At <span class="num" data-stamp>0:00</span></button>
              ${['Faster cuts', 'Bigger captions', 'Less text on screen', 'Add more zoom-ins', 'Lower the music', 'Remove the part where…'].map((t) => `<button type="button" data-action="idea" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
            <div class="row"><button class="btn primary big" data-action="send-note" data-slug="${esc(slug)}">${I.send} Send notes</button><span class="muted small" data-region="sendhint"></span></div>
            <div class="finish">
              <button class="btn" data-action="final" data-slug="${esc(slug)}">${I.star} Approve and make final</button>
              <button class="btn" data-action="horizontal" data-slug="${esc(slug)}">${I.wide} Make a YouTube (horizontal) version</button>
            </div>
          </div>
        </section>
      </div>
    </div>`,
  regions: {
    head: (slug) => {
      const p = proj(slug);
      if (!p) return '<h1>Not found</h1><p class="muted">This edit is not here anymore. <a href="#/videos">Back to My videos</a></p>';
      const title = S.renaming === slug
        ? `<form class="rename" data-form="rename" data-slug="${esc(slug)}"><label class="sr" for="rename-input">Video name</label>
            <input type="text" id="rename-input" value="${esc(p.title)}" maxlength="80" autocomplete="off">
            <button class="btn primary" type="submit">Save name</button><button class="btn quiet" type="button" data-action="rename-cancel">Cancel</button></form>`
        : `<div class="title"><h1>${esc(p.title)}</h1><button class="btn quiet sm icon" data-action="rename" data-slug="${esc(slug)}" aria-label="Rename this video" title="Rename">${I.edit}</button></div>`;
      const src = p.sources.length > 1 ? `From ${plural(p.sources.length, 'clip')} · ` : p.sources.length ? `From ${esc(p.sources[0].split('/').pop())} · ` : '';
      const forWho = p.contactLabel ? `${esc(p.contactLabel)} · ` : '';
      const del = S.job?.slug === slug || p.status === 'queued' ? '' : delBtn([{ area: 'project', path: slug }], `the video “${p.title}” and all its versions`, { label: 'Delete video' });
      return `${title}<div class="row spread"><p class="muted">${forWho}${src}${p.fromTerminal ? 'Edited in Claude · ' : ''}updated ${ago(p.updatedAt)}</p>${del}</div>`;
    },
    tapes: (slug) => {
      const p = proj(slug);
      if (!p?.versions.length) return '';
      const sel = selected(p);
      return p.versions.map((v) => `<button data-action="pick-version" data-slug="${esc(slug)}" data-file="${esc(v.file)}" aria-pressed="${v.file === sel?.file}"><span class="tape">${esc(tapeLabel(v.label))}</span></button>`).join('');
    },
    player: (slug) => {
      const p = proj(slug);
      const v = p && selected(p);
      if (v) return `<video controls playsinline preload="metadata" src="/media/outbox/${enc(v.file)}?t=${Math.round(v.mtime)}" poster="/thumb/outbox/${enc(v.file)}?t=${Math.round(v.mtime)}"></video>`;
      if (S.job?.slug === slug) return `<div class="waiting"><span class="live"></span><b>Your first draft is on its way.</b><span>Most videos take 10 to 30 minutes. You can leave this page; you'll get a notice when it's ready.</span></div>`;
      if (p?.status === 'queued') return `<div class="waiting"><b>Waiting in line.</b><span>The editor starts this as soon as it finishes what it's doing.</span></div>`;
      return `<div class="waiting"><b>No video yet.</b><span>${p?.status === 'error' || p?.status === 'interrupted' ? 'The last run did not finish. See the reply on the right.' : ''}</span></div>`;
    },
    under: (slug) => {
      const p = proj(slug);
      const v = p && selected(p);
      return `${v ? `<a class="btn quiet sm" href="/media/outbox/${enc(v.file)}" download="${esc(v.file)}">${I.down} Download</a>
        <button class="btn quiet sm" data-action="reveal" data-area="outbox" data-name="${esc(v.file)}">${I.folder} Show in folder</button>` : ''}
        <button class="btn quiet sm" data-action="reveal" data-area="kit" data-name="${esc(slug)}" title="The editable project files">${I.folder} Project files</button>`;
    },
    notdone: (slug) => {
      const p = proj(slug);
      if (!p?.notDone?.length) return '';
      const brandish = /b-?roll|music|screenshot|logo/i;
      return `<section class="notdone">
        <h2 class="sub">${I.warn} What the editor couldn't do yet</h2>
        <ul>${p.notDone.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>
        <div class="row">${p.notDone.some((t) => brandish.test(t)) ? `<a class="btn sm" href="#/brand">${I.brand} Add it in My brand</a>` : ''}
        ${p.notDone.some((t) => brandish.test(t)) ? '<span class="muted small">Then send a note like “use the new B-roll”.</span>' : ''}</div>
      </section>`;
    },
    progress: (slug) => {
      const p = proj(slug);
      const j = S.job;
      if (j && j.slug === slug) {
        return progressPanel(j, { edit: 'Editing your video', final: 'Making the final version', horizontal: 'Making the YouTube version' }[j.kind] || 'Working on your notes');
      }
      const q = S.state.queue.filter((x) => x.slug === slug);
      if (!q.length) return '';
      const pos = queueOf(slug) + 1;
      return `<section class="panel waitline">
        <div class="panel-head"><h2 class="sub">${I.queue} Waiting in line</h2><span class="muted small">${pos === 1 ? 'Next up' : `Number ${pos} in line`}</span></div>
        <p class="muted small">${S.job ? `Starts when the editor finishes “${esc(S.job.title || 'the current video')}”.` : 'Starting…'}</p>
        <ul class="plain">${q.map((x) => `<li><span>${esc(JOB_LABEL[x.type])}</span><button class="btn quiet sm" data-action="unqueue" data-id="${esc(x.id)}">Remove</button></li>`).join('')}</ul>
      </section>`;
    },
    talk: (slug) => {
      const p = proj(slug);
      if (!p) return '';
      const items = (p.history || []).map((m) => `<div class="msg ${m.role === 'you' ? 'you' : 'editor'}${m.error ? ' error' : ''}">
        <div class="who">${m.role === 'you' ? 'You' : 'Editor'} · ${ago(m.at)}${m.queuedId && S.state.queue.some((q) => q.id === m.queuedId) ? ' · waiting in line' : ''}</div><div>${m.role === 'you' ? `<p>${esc(m.text)}</p>` : md(m.text)}</div>
        ${m.error ? '<p class="small" style="margin-top:8px">If this keeps happening, check <a href="#/setup">Setup</a>.</p>' : ''}</div>`);
      if (p.status === 'interrupted') items.push('<div class="msg editor error"><p>This run was cut off because the app was closed.</p></div>');
      const failed = (p.status === 'error' || p.status === 'interrupted') && p.canRetry && S.job?.slug !== slug && queueOf(slug) < 0;
      if (failed) items.push(`<div class="retry"><button class="btn" data-action="retry" data-slug="${esc(slug)}">${I.retry} Try again</button><span class="muted small">Runs the same request again.</span></div>`);
      if (!items.length) return `<p class="muted">${p.fromTerminal ? 'This edit was made in the Claude chat. Notes you send here continue it.' : 'Nothing yet.'}</p>`;
      return items.join('');
    },
    liveStep: (slug) => (S.job?.slug === slug ? esc(S.job.steps.at(-1)?.label || '') : ''),
    target: (slug) => {
      const p = proj(slug);
      if (!p?.versions.some((v) => v.label.startsWith('horizontal'))) return '';
      const t = S.noteTarget[slug] || 'vertical';
      return `<div class="seg" role="group" aria-label="Notes are for"><button data-action="target" data-slug="${esc(slug)}" data-t="vertical" aria-pressed="${t === 'vertical'}">Vertical</button><button data-action="target" data-slug="${esc(slug)}" data-t="horizontal" aria-pressed="${t === 'horizontal'}">YouTube</button></div>`;
    },
    sendhint: (slug) => {
      if (S.job && S.job.slug !== slug) return `The editor is busy with “${esc(S.job.title)}”. Your notes wait in line.`;
      if (S.job) return 'The editor is on this video now. New notes start right after.';
      const p = proj(slug);
      const n = p ? p.versions.filter((v) => /^v\d+$/.test(v.label)).length : 0;
      return n ? `Makes version ${n + 1}.` : '';
    },
  },
  after: (slug) => {
    const p = proj(slug);
    for (const b of $$('[data-action="send-note"], [data-action="final"], [data-action="horizontal"]')) b.disabled = !p;
    for (const b of $$('[data-action="final"], [data-action="horizontal"]')) if (p && !p.versions.length) b.disabled = true;
    const stamp = $('[data-action="stamp"]');
    const v = $('.monitor video');
    if (stamp) stamp.hidden = !v;
    if (v && !v.dataset.bound) {
      v.dataset.bound = '1';
      v.addEventListener('timeupdate', () => { const s = $('[data-stamp]'); if (s) s.textContent = fmtDur(v.currentTime) || '0:00'; });
    }
    const prog = $('[data-region="progress"]');
    if (prog) prog.hidden = !prog.innerHTML;
    const ren = $('#rename-input');
    if (ren && S.focusRename) { S.focusRename = false; ren.focus(); ren.select(); }
  },
};
const proj = (slug) => S.state.projects.find((p) => p.slug === slug);
function selected(p) {
  const file = S.sel[p.slug];
  return p.versions.find((v) => v.file === file) || [...p.versions].sort((a, b) => b.mtime - a.mtime)[0];
}

const SKELETON = `<div class="skeleton" role="status" aria-label="Loading">${'<i></i>'.repeat(8)}</div>`;

// ---------- brand ----------
const NEEDS = [
  ['logo', 'Logo'], ['details', 'Contact part'], ['broll', 'B-roll clips'], ['social', 'Social page screenshot'], ['music', 'Music'],
];

function brandSlot(kind) {
  const b = S.state.brand;
  const f = b[kind];
  const label = kind === 'logo' ? 'Logo' : 'Social page screenshot';
  const help = kind === 'logo'
    ? 'Shown on every video. A PNG with a see-through background looks best.'
    : 'A screenshot of your Facebook or Instagram page, for when you say “follow us” or “visit us”.';
  const shotLike = (n) => /screen|shot|social|page|facebook|instagram|\bfb\b|\big\b/i.test(n);
  const found = S.state.inbox.filter((x) => x.kind === 'image' && (kind === 'social' ? shotLike(x.name) : !shotLike(x.name)));
  const what = kind === 'logo' ? 'your logo' : 'the social page screenshot';
  const tag = b.needs[kind] && !f ? '<span class="muted small">Your style uses this. Not added yet.</span>' : '';
  return `<div class="slot-head" id="brand-${kind}"><h2 class="sub">${label}</h2>${tag}</div>
    <p class="muted small">${help}</p>
    <div class="slot ${kind}">${f
      ? `<img src="/media/brand/${enc(f.name)}?t=${Math.round(f.mtime)}" alt="Your ${label.toLowerCase()}">`
      : `<button class="slot-empty" data-action="brand-pick" data-slot="${kind}">${I.plus}<span>Add ${kind === 'logo' ? 'your logo' : 'a screenshot'}</span></button>`}</div>
    ${f ? `<div class="row"><button class="btn sm" data-action="brand-pick" data-slot="${kind}">Replace</button>${delBtn([{ area: kind }], what)}</div>` : ''}
    ${!f && found.length ? `<div class="found"><span class="muted small">In your inbox:</span>${found.map((x) => `<button class="chip" data-action="use-inbox" data-slot="${kind}" data-name="${esc(x.path)}">${I.image} Use ${esc(x.name)}</button>`).join('')}</div>` : ''}`;
}

const lineRow = (l = { label: '', value: '' }) => `<div class="line">
  <input type="text" name="label" value="${esc(l.label)}" placeholder="e.g. GLOBE" aria-label="Label">
  <input type="text" name="value" value="${esc(l.value)}" placeholder="e.g. 0945-684-1899" aria-label="Number or text">
  <button type="button" class="btn quiet icon" data-action="remove-line" aria-label="Remove this line">${I.x}</button></div>`;

VIEWS.brand = {
  layout: () => `
    <div class="page-head"><div><h1>My brand</h1><p>The things every video for your brand uses. Add them once and the editor picks them up on every edit.</p></div><div data-region="packTag"></div></div>
    <div data-region="needs"></div>
    <div class="slots"><section class="panel" data-region="logo"></section><section class="panel" data-region="social"></section></div>
    <section class="section" id="brand-details">
      <div class="section-head"><div><h2>Contact part</h2><p class="muted small">The end of each video shows either the brand contact (for all sales) or one sales person. You choose when you start a video.</p></div></div>
      <div class="contact-grid"><section class="panel" data-region="bcontact"></section><section class="panel" data-region="people" id="brand-people"></section></div>
    </section>
    <section class="section" data-region="broll"></section>
    <section class="section" data-region="music"></section>
    <div class="section team"><section class="panel" data-region="share" id="brand-share"></section><section class="panel" data-region="import"></section></div>`,
  regions: {
    packTag: () => {
      const p = S.state.brand.pack;
      return p ? `<span class="tape">From ${esc(p.name)}</span>` : '';
    },
    needs: () => {
      const b = S.state.brand;
      const used = NEEDS.filter(([k]) => b.needs[k]);
      if (!S.state.setup.style || !used.length) return '';
      const missing = used.filter(([k]) => !b.has[k]);
      return `<section class="needs" aria-label="What your style uses">
        <h2 class="sub">${missing.length ? `Your style uses ${plural(used.length, 'thing')} from here. ${missing.length} still missing.` : 'Everything your style uses is here.'}</h2>
        <ul>${used.map(([k, label]) => `<li class="${b.has[k] ? 'good' : 'bad'}"><button data-action="jump" data-to="brand-${k}"><span class="state">${b.has[k] ? I.check : ''}</span>${label}<span class="sr">${b.has[k] ? ', ready' : ', missing'}</span></button></li>`).join('')}</ul>
      </section>`;
    },
    logo: () => brandSlot('logo'),
    social: () => brandSlot('social'),
    bcontact: () => {
      const c = S.state.brand.contact || { name: '', lines: [] };
      const lines = c.lines?.length ? c.lines : [{ label: '', value: '' }];
      return `<h2 class="sub">${I.brand} For all sales</h2>
        <p class="muted small">Used when a video isn't for one person: the showroom's number or page. Shared with your team in the brand pack. Leave it empty and those videos end with the logo.</p>
        <form class="details" data-form="bcontact" autocomplete="off">
          <label class="field"><span>Name on screen</span><input type="text" name="name" value="${esc(c.name)}" placeholder="e.g. GOLD ACES CAR DISPLAY CENTER" maxlength="80"></label>
          <div class="field"><span>Numbers and other lines</span><div class="lines" data-lines>${lines.map(lineRow).join('')}</div></div>
          <div class="row spread"><button type="button" class="btn quiet sm" data-action="add-line">${I.plus} Add a line</button>
            <button class="btn primary" type="submit">Save brand contact</button></div>
        </form>`;
    },
    people: () => {
      const people = S.state.brand.people;
      const editing = S.personEdit;
      const txts = S.state.inbox.filter((x) => x.kind === 'text');
      const pron = { she: 'she', he: 'he', they: 'they' };
      const form = (p) => `<form class="details person-form" data-form="person" data-id="${esc(p.id || '')}" autocomplete="off">
          <div class="person-name">
            <label class="field"><span>Title</span><select name="title">${[['MISS', 'Miss'], ['MS.', 'Ms.'], ["MA'AM", "Ma'am"], ['SIR', 'Sir'], ['MR.', 'Mr.'], ['', 'No title']].map(([v, l]) => `<option value="${esc(v)}" ${p.title === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field"><span>Name</span><input type="text" name="name" value="${esc(p.name || '')}" placeholder="e.g. JHAY" maxlength="60" required></label>
          </div>
          <fieldset class="field pron"><legend>The editor calls them</legend><div class="seg" role="group">${['she', 'he'].map((v) => `<label><input type="radio" name="pronoun" value="${v}" ${(p.pronoun || 'she') === v ? 'checked' : ''}><span>${v === 'she' ? 'She / her' : 'He / him'}</span></label>`).join('')}</div></fieldset>
          <div class="field"><span>Numbers and other lines</span><div class="lines" data-lines>${(p.lines?.length ? p.lines : [{ label: '', value: '' }, { label: '', value: '' }]).map(lineRow).join('')}</div></div>
          <div class="row spread"><button type="button" class="btn quiet sm" data-action="add-line">${I.plus} Add a line</button>
            <div class="row"><button type="button" class="btn quiet" data-action="person-cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></div>
        </form>`;
      return `<div class="slot-head"><h2 class="sub">${I.id} Sales people</h2><span class="muted small private">${I.lock} On this computer</span></div>
        <p class="muted small">For a video about one person: “Look for MISS JHAY” and their own numbers.</p>
        ${people.length ? `<ul class="people">${people.map((p) => editing === p.id ? `<li class="editing">${form(p)}</li>` : `<li>
            <span class="avatar" aria-hidden="true">${esc((p.name || '?').charAt(0))}</span>
            <span class="who"><b>${esc(p.onScreen)}</b><small>${esc(pron[p.pronoun])}${p.lines.length ? ` · ${p.lines.map((l) => esc(l.label)).join(' · ')}` : ' · no numbers'}</small></span>
            <button class="btn quiet sm" data-action="person-edit" data-id="${esc(p.id)}">Edit</button>
            ${delBtn([{ area: 'person', path: p.id }], p.onScreen, { cls: 'btn quiet icon sm danger' })}</li>`).join('')}</ul>` : ''}
        ${editing === 'new' ? form({ pronoun: 'she', title: 'MISS' }) : `<div class="row">
          <button class="btn sm" data-action="person-edit" data-id="new">${I.plus} Add a sales person</button>
          ${txts.map((x) => `<button type="button" class="chip" data-action="use-inbox" data-slot="person" data-name="${esc(x.path)}">${I.text} Add from ${esc(x.name)}</button>`).join('')}</div>`}`;
    },
    broll: () => {
      const b = S.state.brand;
      const cats = [...new Set([...b.categories, ...S.extraCats])];
      const filled = cats.filter((c) => b.broll.some((x) => x.category === c));
      const empty = cats.filter((c) => !filled.includes(c));
      const tile = (x) => `<figure class="reel-tile" data-preview="/preview/brand/broll/${enc(x.name)}?t=${Math.round(x.mtime)}"><img src="/thumb/brand/broll/${enc(x.name)}?t=${Math.round(x.mtime)}" alt="" loading="lazy" decoding="async">
        ${x.duration ? `<span class="len">${fmtDur(x.duration)}</span>` : ''}
        ${delBtn([{ area: 'broll', path: x.name }], `this ${prettyCat(x.category).toLowerCase()} clip`, { cls: 'del' })}</figure>`;
      return `<div class="section-head" id="brand-broll"><div><h2>B-roll library</h2><p class="muted small">Short clips of your place, products and people. The editor cuts to them while you talk.</p></div>
          <div class="row"><span class="muted small">${b.broll.length ? `${plural(b.broll.length, 'clip')} · ${fmtSize(b.sizes.broll)}` : 'No clips yet'}</span>
          ${b.broll.length > 1 ? delBtn(b.broll.map((x) => ({ area: 'broll', path: x.name })), `all ${plural(b.broll.length, 'B-roll clip')}`, { label: 'Delete all' }) : ''}</div></div>
        <div class="cats">${filled.map((c) => {
          const items = b.broll.filter((x) => x.category === c);
          return `<section class="cat"><div class="cat-head"><h3>${esc(prettyCat(c))}</h3><div class="row"><span class="muted small">${plural(items.length, 'clip')}</span>
            ${items.length > 1 ? delBtn(items.map((x) => ({ area: 'broll', path: x.name })), `all ${items.length} ${prettyCat(c).toLowerCase()} clips`, { label: 'Delete group' }) : ''}</div></div>
            <div class="reel">${items.map(tile).join('')}<button class="reel-add" data-action="brand-pick" data-slot="broll" data-category="${esc(c)}" aria-label="Add ${esc(prettyCat(c))} clips">${I.plus}<span>Add</span></button></div></section>`;
        }).join('')}
        ${empty.length ? `<div class="cats-empty">${filled.length ? '<h3 class="small muted">Still empty</h3>' : ''}<div>${empty.map((c) => `<button class="cat-add" data-action="brand-pick" data-slot="broll" data-category="${esc(c)}">${I.plus}<span>${esc(prettyCat(c))}</span></button>`).join('')}</div></div>` : ''}</div>
        <form class="row newcat" data-form="newcat"><label class="sr" for="newcat">New group name</label><input type="text" id="newcat" placeholder="New group, e.g. drone shots" maxlength="30"><button class="btn sm" type="submit">${I.plus} Add group</button></form>`;
    },
    music: () => {
      const sounds = S.state.sounds;
      return `<div class="section-head" id="brand-music"><div><h2>Music and sound effects</h2><p class="muted small">Only add sounds you have the right to use. Without any, the editor makes simple effects itself.</p></div>
          <div class="row">${sounds.length > 1 ? delBtn(sounds.map((f) => ({ area: 'sounds', path: f.folder ? `${f.folder}/${f.name}` : f.name })), `all ${plural(sounds.length, 'sound')}`, { label: 'Delete all' }) : ''}
          <button class="btn sm" data-action="pick-sound">${I.up} Add music or sounds</button></div></div>
        ${sounds.length ? `<div class="extras">${sounds.map((f) => `<span class="chip-del"><button class="chip" data-action="reveal" data-area="sounds" data-name="${esc(f.name)}" data-folder="${esc(f.folder || '')}">${I.music}${esc(f.folder ? `${f.folder} / ` : '')}${esc(f.name)}</button>${delBtn([{ area: 'sounds', path: f.folder ? `${f.folder}/${f.name}` : f.name }], f.name, { cls: 'btn quiet icon sm' })}</span>`).join('')}</div>` : '<div class="empty">No music yet.</div>'}`;
    },
    share: () => {
      const b = S.state.brand;
      const music = S.state.sounds.filter((f) => f.kind === 'audio').length;
      if (!S.state.setup.style) return `<h2 class="sub">${I.share} Share with your team</h2><p class="muted small">Set your style first. Then you can send it to teammates as one file.</p>`;
      return `<h2 class="sub">${I.share} Share with your team</h2>
        <p class="muted small">Makes one file with your style, rules, logo, screenshot and brand contact. Teammates import it, and their videos look like yours.</p>
        <form class="pack-form" data-form="export">
          <label class="field"><span>Brand name</span><input type="text" name="name" value="${esc(b.pack?.name || '')}" placeholder="e.g. Gold Aces" maxlength="60" required></label>
          <label class="tick"><input type="checkbox" name="broll" ${b.broll.length ? 'checked' : 'disabled'}>Include B-roll<small>${b.broll.length ? fmtSize(b.sizes.broll) : 'none yet'}</small></label>
          <label class="tick"><input type="checkbox" name="music" ${music ? '' : 'disabled'}>Include music<small>${music ? fmtSize(b.sizes.music) : 'none yet'}</small></label>
          <label class="tick"><input type="checkbox" name="people" ${b.people.length ? '' : 'disabled'}>Include sales people<small>${b.people.length ? `${b.people.length} with their numbers` : 'none yet'}</small></label>
          <button class="btn primary" type="submit">${I.pack} Make brand pack</button>
        </form>`;
    },
    import: () => {
      const p = S.state.brand.pack;
      return `<h2 class="sub">${I.importIco} ${p ? 'Your brand pack' : 'Got a brand pack?'}</h2>
        <p class="muted small">${p
          ? `Using “${esc(p.name)}” since ${new Date(p.importedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. When your team sends a newer one, import it here.`
          : 'Import the .brandpack file from your team. It sets your style, logo, screenshot, brand contact and B-roll. Your own rules and sales people stay.'}</p>
        <div class="row"><button class="btn" data-action="import-pack">${I.importIco} Import brand pack</button>
        ${p ? '<button class="btn quiet sm" data-action="unlock">Stop using the brand pack</button>' : ''}</div>`;
    },
  },
};

// ---------- style ----------
const WIZARD = [
  { title: 'The basics', qs: [
    { key: 'format', q: 'What shape are your videos?', opts: [['Vertical 9:16', 'Reels, TikTok, Shorts'], ['Horizontal 16:9', 'YouTube'], ['Both', 'Vertical first, then a YouTube version']] },
    { key: 'hook', q: 'Big text in the first 3 seconds?', p: 'A short title that hooks people before they scroll.', opts: [['Big hook text', 'Bold title at the start'], ['No hook text', 'Start straight away']] },
    { key: 'pace', q: 'How fast should it feel?', opts: [['Tight', 'Cut every breath and pause'], ['Natural', 'Keep short pauses']] },
  ] },
  { title: 'Captions', qs: [
    { key: 'captions', q: 'How should captions look?', opts: [['Word by word', 'One word at a time'], ['Bold key words', 'Big caps key words, small filler words'], ['Key-word pills', 'Key words in a colored bubble'], ['Full sentences', 'Classic subtitles'], ['No captions', '']] },
    { key: 'position', q: 'Where on screen?', opts: [['Upper third', 'Clear of app buttons (recommended)'], ['Middle', ''], ['Lower third', '']] },
    { key: 'colors', q: 'Caption colors?', opts: [['White with shadow', 'Works on anything'], ['My brand color', 'Tell us the color below'], ['Highlight key words', 'White, key words in a color']], brand: true },
  ] },
  { title: 'Look and sound', qs: [
    { key: 'graphics', q: 'How much motion graphics?', opts: [['Minimal', 'Just captions'], ['Some motion cards', 'A few animated cards'], ['Heavy motion graphics', 'Lots of movement']] },
    { key: 'color', q: 'Color look?', opts: [['Natural', ''], ['Warm', ''], ['Cool', ''], ['Black and white', ''], ['Orange and teal', 'Cinematic']] },
    { key: 'sound', q: 'Sound?', opts: [['Voice only', ''], ['Light sound effects', 'Whooshes and pops'], ['Effects plus quiet music', 'Uses music from My brand']] },
  ] },
];

async function loadDoc(which) {
  try {
    const d = await api(`/api/doc/${which}`);
    S.docs[which === 'brand-rules' ? 'brandRules' : which] = d.text;
    if (which === 'style' && d.reply && !S.docs.styleReply) S.docs.styleReply = d.reply;
    regionCache.clear(); refresh();
  } catch (e) { fail(e); }
}

VIEWS.style = {
  enter: () => { S.styleMode = 'read'; S.docs.style = undefined; loadDoc('style'); },
  layout: () => `<div data-region="body"></div>`,
  regions: {
    body: () => {
      const text = S.docs.style;
      const pack = S.state.brand.pack;
      if (text === undefined) return SKELETON;
      if (pack && text !== null) {
        return `<div class="page-head"><div><h1>My style</h1><p>Your team's brand style. Every ${esc(pack.name)} video follows it, whoever films.</p></div><span class="tape">From ${esc(pack.name)}</span></div>
          <div class="split"><article class="panel doc">${md(text)}</article>
          <aside>
            <section class="panel locked"><h2 class="sub">${I.lock} Set by your brand pack</h2>
              <p class="muted small">To change the brand style, ask whoever made the pack for a new one. Notes on your own videos still work, and lasting ones are saved as your rules.</p>
              <div class="radios"><button class="btn" data-action="import-pack">${I.importIco} Import a newer pack</button><a class="btn quiet" href="#/rules">See my rules</a></div></section>
          </aside></div>`;
      }
      if (text === null || S.styleMode === 'wizard') return wizardHtml(text !== null);
      if (S.styleMode === 'edit') return `<div class="page-head"><div><h1>Edit my style</h1><p>Change anything you like. A backup of the old version is kept as my-style.md.bak.</p></div>
        <div class="row"><button class="btn" data-action="style-mode" data-mode="read">Cancel</button><button class="btn primary" data-action="save-doc" data-doc="style">Save</button></div></div>
        <textarea class="editor-area" id="doc-text" aria-label="Style text">${esc(text)}</textarea>`;
      const reply = S.docs.styleReply;
      const styleBusy = S.job?.kind === 'style' || S.state.queue.some((q) => q.type === 'style');
      return `<div class="page-head"><div><h1>My style</h1><p>How every video is edited. Notes you give on videos can also become <a href="#/rules">rules</a>, which win over this.</p></div></div>
        <div class="split"><article class="panel doc">${md(text)}</article>
        <aside>
          <section class="panel composer"><h2 class="sub"><label for="style-ask">Change something</label></h2><p class="muted small">Describe it in your own words. The editor updates your style for you.</p>
            <textarea id="style-ask" placeholder="e.g. Use yellow for key words instead of gold"></textarea>
            <button class="btn primary" data-action="style-ask" ${styleBusy ? 'disabled' : ''}>${styleBusy ? 'Updating…' : busy() ? 'Update my style (waits in line)' : 'Update my style'}</button>
            ${reply ? `<div class="msg editor${reply.error ? ' error' : ''}" style="max-width:none"><div class="who">Editor</div>${md(reply.text)}</div>` : ''}
          </section>
          <section class="panel"><h2 class="sub">Other options</h2><div class="radios">
            <a class="btn" href="#/brand" data-jump="brand-share">${I.share} Share with my team</a>
            <button class="btn" data-action="style-mode" data-mode="edit">Edit the text myself</button>
            <button class="btn quiet" data-action="style-mode" data-mode="wizard">Start over with quick questions</button></div></section>
        </aside></div>`;
    },
  },
};

function wizardHtml(hasExisting) {
  const w = S.wizard;
  const round = WIZARD[w.step];
  return `<div class="wizard">
    <div class="page-head"><div><h1>${hasExisting ? 'Start over with your style' : 'Pick your style'}</h1>
    <p>${hasExisting ? 'Your current style will be replaced. A backup is kept as my-style.md.bak.' : 'Three quick rounds. You can change anything later.'}</p></div>
    ${hasExisting ? '<button class="btn quiet" data-action="style-mode" data-mode="read">Cancel</button>' : ''}</div>
    ${!hasExisting && w.step === 0 ? `<div class="banner">${I.pack}<div><strong>Does your team already have a brand style?</strong><span class="muted">Import the brand pack they sent you instead, so your videos match theirs.</span></div><button class="btn primary" data-action="import-pack">Import brand pack</button></div>` : ''}
    <div class="stepper" aria-hidden="true">${WIZARD.map((_, i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div>
    <h2 style="margin-bottom:20px">${w.step + 1} of ${WIZARD.length}: ${esc(round.title)}</h2>
    ${round.qs.map((q) => `<fieldset class="q"><legend><h3>${esc(q.q)}</h3></legend>${q.p ? `<p>${esc(q.p)}</p>` : '<p></p>'}
      <div class="opts">${q.opts.map(([label, sub], i) => `<label class="opt"><input type="radio" name="${q.key}" value="${esc(label)}" ${w.answers[q.key] === label || (!w.answers[q.key] && i === 0) ? 'checked' : ''}><span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`).join('')}</div>
      ${q.brand ? `<label class="field" style="margin-top:12px"><span>Brand color <span class="hint">(only if you picked brand color; a name or a code like #F3C543)</span></span><input type="text" id="brandColor" value="${esc(w.answers.brandColor || '')}"></label>` : ''}
    </fieldset>`).join('')}
    ${w.step === WIZARD.length - 1 ? `<label class="field" style="margin-bottom:24px"><span>Anything else? <span class="hint">(optional) Fonts, brand, things you always or never want.</span></span><textarea id="extra">${esc(w.answers.extra || '')}</textarea></label>` : ''}
    <div class="row">${w.step ? '<button class="btn" data-action="wiz-back">Back</button>' : ''}
      <button class="btn primary big" data-action="wiz-next">${w.step === WIZARD.length - 1 ? 'Save my style' : 'Next'}</button></div>
  </div>`;
}
function collectWizard() {
  for (const q of WIZARD[S.wizard.step].qs) {
    const v = $(`input[name="${q.key}"]:checked`)?.value;
    if (v) S.wizard.answers[q.key] = v;
  }
  if ($('#brandColor')) S.wizard.answers.brandColor = $('#brandColor').value.trim();
  if ($('#extra')) S.wizard.answers.extra = $('#extra').value.trim();
}

// ---------- rules ----------
VIEWS.rules = {
  enter: () => {
    S.rulesMode = 'read'; S.docs.rules = undefined; loadDoc('rules');
    if (S.state.brand.brandRules) { S.docs.brandRules = undefined; loadDoc('brand-rules'); } else S.docs.brandRules = null;
  },
  layout: () => `<div data-region="body"></div>`,
  regions: {
    body: () => {
      const text = S.docs.rules;
      if (text === undefined) return SKELETON;
      if (S.rulesMode === 'edit') return `<div class="page-head"><div><h1>Edit my rules</h1><p>Delete a line to remove that rule. A backup is kept as my-rules.md.bak.</p></div>
        <div class="row"><button class="btn" data-action="rules-mode" data-mode="read">Cancel</button><button class="btn primary" data-action="save-doc" data-doc="rules">Save</button></div></div>
        <textarea class="editor-area" id="doc-text" aria-label="Rules text">${esc(text || '# My rules\n\n')}</textarea>`;
      const pack = S.state.brand.pack;
      const brandRules = S.docs.brandRules;
      return `<div class="page-head"><div><h1>My rules</h1><p>Lasting preferences the editor learned from your notes. They apply to every video and win over your style.</p></div></div>
        <div class="split">
          <div class="stack">
            <article class="panel doc">${text?.trim() ? md(text) : '<p class="muted">No rules yet. When you give a note like “always…” or “never…”, the editor saves it here.</p>'}</article>
            ${brandRules?.trim() ? `<article class="panel doc brand-rules"><div class="slot-head"><h2 class="sub">${I.lock} Brand rules</h2>${pack ? `<span class="tape pale sm">From ${esc(pack.name)}</span>` : ''}</div>${md(brandRules)}</article>` : ''}
          </div>
          <aside>
            <section class="panel composer"><h2 class="sub"><label for="new-rule">Add a rule</label></h2><p class="muted small">Something the editor should always or never do.</p>
              <textarea id="new-rule" placeholder="e.g. Never put captions over my face"></textarea>
              <button class="btn primary" data-action="add-rule">Add rule</button></section>
            <section class="panel"><button class="btn" data-action="rules-mode" data-mode="edit" style="width:100%">Edit or remove rules</button></section>
          </aside></div>`;
    },
  },
};

// ---------- setup ----------
const INSTALL = {
  darwin: { node: 'brew install node', git: 'brew install git', ffmpeg: 'brew install ffmpeg', claude: 'curl -fsSL https://claude.ai/install.sh | bash', chrome: 'brew install --cask google-chrome', whisper: 'pip3 install faster-whisper' },
  win32: { node: 'winget install OpenJS.NodeJS.LTS', git: 'winget install Git.Git', ffmpeg: 'winget install Gyan.FFmpeg', claude: 'irm https://claude.ai/install.ps1 | iex', chrome: 'winget install Google.Chrome', whisper: 'pip install faster-whisper' },
  linux: { node: 'Install Node.js 22 or newer with your package manager', git: 'sudo apt install git', ffmpeg: 'sudo apt install ffmpeg', claude: 'curl -fsSL https://claude.ai/install.sh | bash', chrome: 'Install Google Chrome or Chromium', whisper: 'pip install faster-whisper' },
};
VIEWS.setup = {
  layout: () => `<div class="page-head"><div><h1>Setup</h1><p>Everything the editor needs on this computer. Green means ready.</p></div>
    <div class="row"><button class="btn" data-action="recheck">Check again</button></div></div>
    <div data-region="fix"></div>
    <div data-region="checks"></div>
    <section class="section"><h2 style="margin-bottom:12px">Transcription</h2><div data-region="transcribe"></div></section>
    <section class="section" data-region="test"></section>
    <section class="section"><details class="advanced"><summary>${I.right}<span><b>Advanced</b><span class="muted small">How much freedom the editor gets, and which Claude model it uses.</span></span></summary><div data-region="settings"></div></details></section>`,
  regions: {
    fix: () => {
      const s = S.state.setup;
      const j = S.job;
      if (j?.kind === 'setup') return progressPanel(j, 'Fixing your setup', { stop: true });
      const reply = S.state.setupReply;
      const replyHtml = reply ? `<div class="msg editor${reply.error ? ' error' : ''}" style="max-width:none;margin-top:14px"><div class="who">Editor · ${ago(reply.at)}</div>${md(reply.text)}</div>` : '';
      if (!s.claude) {
        const cmd = (INSTALL[s.platform] || INSTALL.linux).claude;
        return `<section class="panel fixit"><div><h2 class="sub">${I.wrench} One step needs you</h2>
          <p class="muted small">Install Claude Code, the editor's brain. Open ${s.platform === 'win32' ? 'PowerShell' : 'Terminal'}, paste this line, press Enter, then type <code>claude</code> once to log in. After that, everything else here can be fixed for you.</p>
          <p style="margin-top:10px"><code class="cmd">${esc(cmd)}</code></p></div></section>`;
      }
      if (setupReady(s)) return replyHtml ? `<section class="panel">${replyHtml}</section>` : '';
      return `<section class="panel fixit"><div><h2 class="sub">${I.wrench} Let the editor fix it</h2>
          <p class="muted small">It installs what's missing and renders a test video. Your computer may ask for your password. Takes a few minutes.</p></div>
        <button class="btn primary big" data-action="fix-setup" ${busy() ? 'disabled title="The editor is busy"' : ''}>${I.wrench} Fix it for me</button>${replyHtml}</section>`;
    },
    checks: () => {
      const s = S.state.setup;
      const cmd = INSTALL[s.platform] || INSTALL.linux;
      const row = (good, title, how) => `<div class="check ${good ? 'good' : 'bad'}"><span class="state">${good ? I.check : I.x}<span class="sr">${good ? 'Ready' : 'Missing'}</span></span><div><b>${title}</b>${!good && how ? `<details class="how"><summary>${I.right}Do it yourself instead</summary>${how}</details>` : ''}</div></div>`;
      const log = S.setupLog;
      return `<div class="checks">
        ${row(s.node, `Node.js ${s.nodeVersion}`, `Needs version 22 or newer. Install: <code>${esc(cmd.node)}</code>`)}
        ${row(s.git, 'Git', `Install: <code>${esc(cmd.git)}</code>`)}
        ${row(s.ffmpeg, 'FFmpeg (video tools)', `Install: <code>${esc(cmd.ffmpeg)}</code>`)}
        ${row(s.claude, 'Claude Code (the editor)', `Install: <code>${esc(cmd.claude)}</code>, then run <code>claude</code> once in a terminal to log in.`)}
        ${row(s.kit, 'Editing engine', 'Click “Run setup” below. It downloads the engine and renders a test video (a few minutes).')}
        ${row(rendererOk(s), 'Video renderer (Chrome)', `Install: <code>${esc(cmd.chrome)}</code>. Or run setup: the engine can download its own copy.`)}
      </div>
      <p class="muted small" style="margin-top:10px">After installing something yourself, close this app's window, open it again, then click “Check again”.</p>
      <div class="row" style="margin-top:16px"><button class="btn" data-action="run-setup" ${log?.running ? 'disabled' : ''}>${log?.running ? 'Setup is running…' : s.kit ? 'Run setup again' : 'Run setup'}</button>
        ${log && !log.running ? `<span class="${log.ok ? '' : 'danger'}" style="font-weight:600">${log.ok ? 'Setup finished.' : 'Setup stopped. Read the last lines below.'}</span>` : ''}</div>
      ${log ? `<div class="console" data-console>${esc(log.lines.join('\n'))}</div>` : ''}`;
    },
    transcribe: () => {
      const s = S.state.setup;
      const cmd = INSTALL[s.platform] || INSTALL.linux;
      return `<div class="panel">
        <div class="check flat ${s.groq ? 'good' : 'maybe'}" style="margin-bottom:16px"><span class="state">${s.groq ? I.check : ''}</span>
          <div><b>Groq (free, recommended)</b><div class="how">${s.groq ? 'Your key is saved on this computer.' : 'Most accurate for Taglish, and fast.'}</div></div></div>
        ${s.groq ? '' : `<ol class="small" style="margin:0 0 14px;padding-left:20px;color:var(--ink-2)"><li>Open <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> and sign in (free, no card).</li><li>Click “Create API Key”, copy it, and paste it below.</li></ol>`}
        <form class="row" data-form="groq" autocomplete="off"><label class="sr" for="groq-key">Groq key</label><input type="password" id="groq-key" placeholder="${s.groq ? 'Paste a new key to replace the saved one' : 'gsk_…'}" style="flex:1;min-width:220px"><button class="btn primary" type="submit">Save key</button></form>
        <p class="muted small" style="margin-top:8px">The key is saved only in the .env file on this computer and is never shown again.</p>
        <div class="divider"></div>
        <div class="check flat ${s.localWhisper ? 'good' : 'maybe'}"><span class="state">${s.localWhisper ? I.check : ''}</span>
          <div><b>Or: on this computer (private, no account)</b><div class="how">${s.localWhisper ? 'Installed. Used when there is no Groq key.' : `Slower. Needs Python. Install: <code>${esc(cmd.whisper)}</code>`}</div></div></div>
      </div>`;
    },
    settings: () => {
      const st = S.state.settings;
      return `<div class="panel" style="margin-top:12px">
        <h3>How much freedom does the editor get?</h3>
        <div class="radios">
          <label class="tick"><input type="radio" name="perm" value="auto" ${st.permissionMode === 'auto' ? 'checked' : ''} data-action="set-perm"><span><b>Safe mode</b> (recommended). A safety check reviews each step and blocks anything risky.</span></label>
          <label class="tick"><input type="radio" name="perm" value="bypassPermissions" ${st.permissionMode === 'bypassPermissions' ? 'checked' : ''} data-action="set-perm"><span><b>Full access.</b> No checks. Use only if safe mode keeps blocking normal editing steps.</span></label>
        </div>
        <h3 style="margin-top:22px">Editor brain</h3>
        <div class="radios">
          ${[['', 'Default', 'Whatever your Claude account uses.'], ['opus', 'Best quality', 'Opus. Uses more of your plan.'], ['sonnet', 'Lighter', 'Sonnet. Uses less of your plan.']].map(([v, a, b]) => `<label class="tick"><input type="radio" name="model" value="${v}" ${st.model === v ? 'checked' : ''} data-action="set-model"><span><b>${a}.</b> ${b}</span></label>`).join('')}
        </div></div>`;
    },
    test: () => S.state.setup.testVideo ? `<h2 style="margin-bottom:12px">Test video</h2><p class="muted" style="margin-bottom:12px">If this plays, rendering works.</p>
      <div class="monitor" style="max-width:420px"><video controls playsinline preload="metadata" src="/media/outbox/setup-test.mp4" poster="/thumb/outbox/setup-test.mp4"></video></div>` : '',
  },
  after: () => { const c = $('[data-console]'); if (c) c.scrollTop = c.scrollHeight; },
};

// ---------- new video dialog ----------
function stripHtml() {
  const { files, keep } = S.dialog;
  const inbox = S.state.inbox;
  return files.map((path, i) => {
    const f = inbox.find((x) => x.path === path);
    const name = f?.name || path;
    return `<li>
      <span class="clip"${f ? ` data-preview="${clipPreview(f)}"` : ''}><img src="${f ? clipThumb(f) : ''}" alt="">${keep && files.length > 1 ? `<span class="pos num">${i + 1}</span>` : ''}${f?.duration ? `<span class="len">${fmtDur(f.duration)}</span>` : ''}</span>
      <span class="nm" title="${esc(name)}">${esc(name)}</span>
      ${keep && files.length > 1 ? `<span class="move"><button type="button" class="btn quiet icon" data-action="move-clip" data-i="${i}" data-dir="-1" ${i ? '' : 'disabled'} aria-label="Move ${esc(name)} earlier">${I.left}</button><button type="button" class="btn quiet icon" data-action="move-clip" data-i="${i}" data-dir="1" ${i < files.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(name)} later">${I.right}</button></span>` : ''}
    </li>`;
  }).join('');
}

function openEditDialog(files) {
  files = files.filter((p) => S.state.inbox.some((f) => f.path === p && f.kind === 'video'));
  if (!files.length) return;
  S.dialog = { files: [...files], keep: false };
  const n = files.length;
  const others = S.state.inbox.filter((x) => x.kind === 'video' && !files.includes(x.path));
  const extras = S.state.inbox.filter((x) => x.kind !== 'video');
  const lib = S.state.brand.broll.length;
  const { people, contact } = S.state.brand;
  let last = 'all';
  try { last = localStorage.getItem('f247.contact') || 'all'; } catch {}
  if (!people.some((p) => p.id === last)) last = 'all';
  const shown = (o) => esc(o.folder ? `${o.folder} / ${o.name}` : o.name);
  const m = $('#modal');
  m.innerHTML = `<form class="inner" method="dialog" data-form="edit">
    <div class="top"><div><h2 id="modal-title">${n > 1 ? `One video from ${n} clips` : 'Edit this clip'}</h2>
      <p class="muted" style="margin-top:4px">${n > 1 ? 'The editor listens to every clip, puts them in story order, and drops the retakes.' : esc(files[0].split('/').pop())}</p></div>
      <button class="btn quiet icon" type="button" data-action="close-modal" aria-label="Close">${I.x}</button></div>
    <ol class="clipstrip" data-strip>${stripHtml()}</ol>
    ${n > 1 ? '<label class="tick"><input type="checkbox" data-action="keep-order"><span>Keep the order I picked</span><small>Only if the editor gets it wrong</small></label>' : ''}
    <fieldset class="q contact-pick"><legend><h3>Who is this video for?</h3></legend><p>This decides the contact part at the end.</p>
      <div class="opts">
        <label class="opt"><input type="radio" name="contact" value="all" ${last === 'all' ? 'checked' : ''}><span><b>All sales</b><small>${contact ? `Ends with ${esc(contact.name || 'the brand contact')}` : 'No brand contact yet, so it ends with the logo'}</small></span></label>
        ${people.map((p) => `<label class="opt"><input type="radio" name="contact" value="${esc(p.id)}" ${last === p.id ? 'checked' : ''}><span><b>${esc(p.onScreen)}</b><small>${p.lines.length ? esc(p.lines.map((l) => l.label).join(' · ')) : 'No numbers yet'}</small></span></label>`).join('')}
      </div>
      <a class="small" href="#/brand" data-jump="brand-details">${people.length ? 'Add or change sales people' : 'Add a sales person'} in My brand</a>
    </fieldset>
    <label class="field"><span>Name this video <span class="hint">(optional, so you can find it later)</span></span><input type="text" name="name" maxlength="80" placeholder="e.g. Why buy your car with us" autocomplete="off"></label>
    <label class="field"><span>Anything special for this video? <span class="hint">(optional)</span></span>
      <textarea name="instructions" placeholder="e.g. This is a promo for our new branch."></textarea></label>
    <details class="more"><summary>${I.right}B-roll and extras</summary><div style="display:grid;gap:16px">
      <p class="small ${lib ? '' : 'muted'}">${lib ? `${I.check} Your brand's B-roll library (${plural(lib, 'clip')}) is used automatically.` : 'Tip: add B-roll in <a href="#/brand">My brand</a> so every video can use it.'}</p>
      ${others.length ? `<div><p class="small muted" style="margin-bottom:8px">Extra B-roll just for this video:</p><div class="ticks">${others.map((o) => `<label class="tick"><input type="checkbox" name="broll" value="${esc(o.path)}">${shown(o)}<small>${fmtDur(o.duration)}</small></label>`).join('')}</div></div>` : ''}
      ${extras.length ? `<div><p class="small muted" style="margin-bottom:8px">Pictures or text from your inbox to use:</p><div class="ticks">${extras.map((o) => `<label class="tick"><input type="checkbox" name="extra" value="${esc(o.path)}">${shown(o)}</label>`).join('')}</div></div>` : ''}
    </div></details>
    <div class="row spread foot"><span class="muted small">${busy() ? `The editor is busy with “${esc(S.job.title)}”. This starts right after.` : 'Takes about 10 to 30 minutes. You can close this page while it works.'}</span>
      <button class="btn primary big" type="submit">${busy() ? `${I.queue} Add to the line` : `${I.play} Start editing`}</button></div>
  </form>`;
  m.showModal();
  $('input[name="name"]', m).focus();
}

// ---------- uploads ----------
function sendFile(url, file, label) {
  return new Promise((done) => {
    const el = document.createElement('div');
    el.className = 'up';
    el.innerHTML = `<div>${esc(label)} <b>${esc(file.name)}</b></div><div class="bar" role="progressbar" aria-label="${esc(label)} ${esc(file.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>`;
    $('.uploads').append(el);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      $('i', el).style.width = `${pct}%`;
      $('.bar', el).setAttribute('aria-valuenow', pct);
    };
    xhr.onload = () => {
      el.remove();
      let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
      done(xhr.status === 200 ? d : { error: d.error || `Could not add ${file.name}.` });
    };
    xhr.onerror = () => { el.remove(); done({ error: `Could not add ${file.name}.` }); };
    xhr.send(file);
  });
}

async function upload(files, to = 'inbox', extra = '') {
  const results = await Promise.all([...files].map((file) => sendFile(`/api/upload?to=${to}&name=${enc(file.name)}${extra}`, file, 'Adding')));
  const names = [];
  for (const r of results) if (r.error) toast(r.error, { bad: true }); else names.push(r.name);
  if (!names.length) return;
  toast(names.length === 1 ? `${to === 'brand' ? 'Added to My brand' : `${names[0]} added`}.` : `${names.length} files added.`);
  if (to !== 'inbox') return;
  const folder = new URLSearchParams(extra).get('folder') || '';
  const vids = names.filter((n) => /\.(mov|mp4|m4v|webm|mkv|avi)$/i.test(n)).map((n) => (folder ? `${folder}/${n}` : n));
  if (!vids.length) return;
  // New clips: pick them and go straight to the new-video dialog, once the server has listed them.
  const home = folder ? `#/f/${enc(folder)}` : '#/';
  if (location.hash !== home && !(home === '#/' && route().name === 'studio')) location.hash = home;
  const tryOpen = (n = 0) => {
    if (vids.every((v) => S.state.inbox.some((f) => f.path === v))) { S.pick = vids; refresh(); openEditDialog(vids); } else if (n < 20) setTimeout(() => tryOpen(n + 1), 150);
  };
  tryOpen();
}
const uploadClips = (files, folder = S.uploadFolder || '') => upload(files, 'inbox', folder ? `&folder=${enc(folder)}` : '');

async function importPack(file) {
  if (!file) return;
  const r = await sendFile('/api/brand/import', file, 'Importing');
  if (r.error) return toast(r.error, { bad: true, ms: 9000 });
  S.docs.style = undefined;
  toast(`Brand pack “${r.name}” is in. Your next videos use it.`, { link: { href: '#/brand', label: 'See it' }, ms: 9000 });
  if (route().name === 'style') loadDoc('style');
}
async function askImport() {
  const hasStyle = S.state.setup.style;
  return ask({
    title: 'Import a brand pack?',
    body: hasStyle ? 'It replaces your style, logo, screenshot, brand contact and (if included) B-roll. A backup of your style is kept. Your own rules and sales people stay.' : 'It sets your style, logo, screenshot, brand contact and B-roll from your team.',
    ok: 'Choose the file',
  });
}

// ---------- hover previews ----------
// Hovering a clip plays its short preview, with sound, over the thumbnail. Mouse only, and off when
// the computer asks for reduced motion. The server makes the preview MP4 the first time.
// Browsers allow sound only after the person has clicked the page once; until then a preview plays
// silently and its speaker button turns the sound on. The same button mutes previews for good.
const canHover = matchMedia('(hover: hover) and (pointer: fine)');
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const HP = { el: null, timer: 0, raf: 0, video: null, bar: null, sound: null };
let previewSound = true;
try { previewSound = localStorage.getItem('f247.previewSound') !== 'off'; } catch {}
const mayPlaySound = () => previewSound && (navigator.userActivation ? navigator.userActivation.hasBeenActive : true);
function soundButton(muted) {
  HP.sound.innerHTML = muted ? I.soundOff : I.soundOn;
  const label = muted ? (previewSound ? 'Click for sound' : 'Turn preview sound on') : 'Turn preview sound off';
  HP.sound.setAttribute('aria-label', label);
  HP.sound.title = label;
}
function stopPreview() {
  clearTimeout(HP.timer);
  cancelAnimationFrame(HP.raf);
  HP.el?.classList.remove('previewing');
  if (HP.video) { HP.video.pause(); HP.video.removeAttribute('src'); HP.video.load(); HP.video.remove(); }
  HP.bar?.remove();
  HP.sound?.remove();
  Object.assign(HP, { el: null, video: null, bar: null, sound: null });
}
function startPreview(el, delay = 220) {
  if (HP.el === el) return;
  stopPreview();
  HP.el = el;
  HP.timer = setTimeout(() => {
    const v = document.createElement('video');
    v.className = 'hover-preview';
    v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.muted = !mayPlaySound();
    v.volume = 0;
    v.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('i');
    bar.className = 'hover-bar';
    const sound = document.createElement('button');
    sound.type = 'button';
    sound.className = 'hover-sound';
    sound.dataset.action = 'preview-sound';
    v.addEventListener('playing', () => el.classList.add('previewing'));
    const img = $('img', el);
    if (img) img.after(v); else el.prepend(v);
    el.append(bar, sound);
    Object.assign(HP, { video: v, bar, sound });
    soundButton(v.muted);
    v.src = el.dataset.preview;
    // Blocked with sound (no click on the page yet): play silently instead.
    v.play().catch(() => { if (HP.video === v && !v.muted) { v.muted = true; soundButton(true); v.play().catch(() => {}); } });
    const start = performance.now();
    const tick = (now) => {
      if (v.duration) bar.style.transform = `scaleX(${Math.min(1, v.currentTime / v.duration)})`;
      if (v.volume < 1) v.volume = Math.min(1, Math.max(0, (now - start) / 180)); // soft start, no pop
      HP.raf = requestAnimationFrame(tick);
    };
    HP.raf = requestAnimationFrame(tick);
  }, delay);
}
// A region re-render replaces the hovered card; pick the preview up again on its replacement.
function reattachPreview() {
  if (!HP.el || HP.el.isConnected) return;
  const url = HP.el.dataset.preview;
  stopPreview();
  const again = $$('[data-preview]').find((x) => x.dataset.preview === url);
  if (again) startPreview(again, 0);
}
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse' || !canHover.matches || calm.matches) return;
  const el = e.target.closest?.('[data-preview]');
  if (el) startPreview(el); else if (HP.el) stopPreview();
});
document.addEventListener('pointerout', (e) => {
  if (HP.el && !(e.relatedTarget && HP.el.contains(e.relatedTarget))) stopPreview();
});
addEventListener('blur', stopPreview);

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('.drop-overlay').hidden = false; });
addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const tile = e.target.closest?.('[data-drop-folder]');
  for (const t of $$('.folder.dropping')) if (t !== tile) t.classList.remove('dropping');
  tile?.classList.add('dropping');
  $('.drop-overlay').hidden = Boolean(tile);
});
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('.drop-overlay').hidden = true; } });
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('.drop-overlay').hidden = true;
  const tile = e.target.closest?.('[data-drop-folder]');
  for (const t of $$('.folder.dropping')) t.classList.remove('dropping');
  const files = [...e.dataTransfer.files];
  const packs = files.filter((f) => /\.brandpack$/i.test(f.name));
  const sounds = files.filter((f) => !packs.includes(f) && (/^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name)));
  const rest = files.filter((f) => !sounds.includes(f) && !packs.includes(f));
  if (rest.length) uploadClips(rest, tile ? tile.dataset.dropFolder : undefined);
  if (sounds.length) upload(sounds, 'sounds');
  if (packs.length && await askImport()) importPack(packs[0]);
});
$('#picker').addEventListener('change', (e) => { uploadClips(e.target.files); e.target.value = ''; });
$('#sound-picker').addEventListener('change', (e) => { upload(e.target.files, 'sounds'); e.target.value = ''; });
$('#pack-picker').addEventListener('change', (e) => { importPack(e.target.files[0]); e.target.value = ''; });
$('#brand-picker').addEventListener('change', (e) => {
  const p = S.brandPick;
  if (p && e.target.files.length) upload(e.target.files, 'brand', `&slot=${p.slot}${p.category ? `&category=${enc(p.category)}` : ''}`);
  e.target.value = '';
});

// In-app confirmation. Resolves true only when the person picks the action button.
function ask({ title, body, ok, danger = false }) {
  const d = $('#confirm');
  d.innerHTML = `<form class="inner" method="dialog">
    <div><h2 id="confirm-title">${esc(title)}</h2><p class="muted" style="margin-top:8px">${esc(body)}</p></div>
    <div class="actions"><button class="btn" value="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(ok)}</button></div>
  </form>`;
  d.returnValue = '';
  return new Promise((done) => {
    d.addEventListener('close', () => done(d.returnValue === 'yes'), { once: true });
    d.showModal();
    $('button[value="yes"]', d).focus();
  });
}

function askNotify() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
const queuedToast = (r) => { if (r?.queued) toast(r.ahead > 1 ? `Added to the line. ${r.ahead - 1} ahead of it.` : 'Added to the line. It starts when the editor is free.'); };

// Keeps keyboard focus on the same clip after the grid re-renders.
function refocusClip(name) { refresh(); $(`input[data-action="pick-clip"][data-file="${CSS.escape(name)}"]`)?.focus(); }

// ---------- actions ----------
const ACTIONS = {
  pick: () => $('#picker').click(),
  'pick-sound': () => $('#sound-picker').click(),
  reveal: (d) => api('/api/reveal', { body: { area: d.area, name: d.name || null, folder: d.folder || null } }).catch(fail),
  'pick-clip': (d, el) => {
    S.pick = el.checked ? [...S.pick.filter((n) => n !== d.file), d.file] : S.pick.filter((n) => n !== d.file);
    refocusClip(d.file);
  },
  'pick-new': () => { S.pick = videosIn('').filter((f) => !f.edited).map((f) => f.path); refresh(); },
  'pick-folder': (d) => { S.pick = videosIn(d.name).map((f) => f.path); refresh(); },
  'folder-video': (d) => { S.pick = videosIn(d.name).map((f) => f.path); refresh(); openEditDialog(S.pick); },
  'new-folder': () => { S.newFolder = true; S.focusNewFolder = true; refresh(); },
  'new-folder-cancel': () => { S.newFolder = false; refresh(); $('[data-action="new-folder"]')?.focus(); },
  'rename-folder': () => { S.renamingFolder = true; S.focusRenameFolder = true; refresh(); },
  'rename-folder-cancel': () => { S.renamingFolder = false; refresh(); },
  'import-clips': (d) => openImportDialog(d.name),
  // The speaker on a playing preview. Clicking it is also the click browsers need before sound.
  'preview-sound': () => {
    const v = HP.video;
    if (!v) return;
    const turnOn = v.muted;
    previewSound = turnOn;
    try { localStorage.setItem('f247.previewSound', turnOn ? 'on' : 'off'); } catch {}
    v.muted = !turnOn;
    if (turnOn) v.volume = 1;
    soundButton(v.muted);
  },
  // Every delete in the app: confirm, then move to the Trash.
  delete: async (d) => {
    const items = JSON.parse(d.items || '[]');
    if (!items.length) return;
    const soft = items.every((x) => x.area === 'person');
    const ok = await ask({
      title: `Delete ${d.what}?`,
      body: soft ? 'You can add them again any time.' : `${win() ? 'It goes to the Recycle Bin' : 'It goes to the Trash'}, so you can get it back from there if you change your mind.`,
      ok: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/delete', { body: { items } });
      const gone = new Set(items.filter((x) => x.area === 'inbox').map((x) => x.path));
      S.pick = S.pick.filter((p) => !gone.has(p) && ![...gone].some((g) => p.startsWith(`${g}/`)));
      toast(soft ? 'Deleted.' : `Moved to the ${win() ? 'Recycle Bin' : 'Trash'}.`);
      const r = route();
      if (r.name === 'folder' && gone.has(r.arg)) location.hash = '#/';
      if (r.name === 'project' && items.some((x) => x.area === 'project' && x.path === r.arg)) location.hash = '#/videos';
    } catch (e) { fail(e); }
  },
  'delete-picked': () => ACTIONS.delete({ items: JSON.stringify(S.pick.map((p) => ({ area: 'inbox', path: p }))), what: plural(S.pick.length, 'picked clip') }),
  'person-edit': (d) => { S.personEdit = d.id; refresh(); $('.person-form input[name="name"]')?.focus(); },
  'person-cancel': () => { S.personEdit = null; refresh(); },
  'pick-clear': () => { S.pick = []; refresh(); },
  'new-video': () => openEditDialog(S.pick),
  'keep-order': (d, el) => { S.dialog.keep = el.checked; $('[data-strip]').innerHTML = stripHtml(); },
  'move-clip': (d) => {
    const i = Number(d.i);
    const j = i + Number(d.dir);
    const f = S.dialog.files;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    $('[data-strip]').innerHTML = stripHtml();
    $(`[data-action="move-clip"][data-i="${j}"][data-dir="${d.dir}"]:not([disabled])`)?.focus() || $(`[data-action="move-clip"][data-i="${j}"]:not([disabled])`)?.focus();
  },
  'close-modal': () => $('#modal').close(),
  'pick-version': (d) => { S.sel[d.slug] = d.file; refresh(); $('.monitor video')?.play().catch(() => {}); },
  idea: (d) => { const t = $('#note'); t.value = (t.value.trim() ? `${t.value.trim()}\n` : '') + d.text.replace('…', ' '); t.focus(); t.setSelectionRange(t.value.length, t.value.length); },
  stamp: () => {
    const v = $('.monitor video');
    const t = $('#note');
    if (!v || !t) return;
    v.pause();
    t.value = `${t.value.trim() ? `${t.value.trimEnd()}\n` : ''}At ${fmtDur(v.currentTime) || '0:00'}: `;
    t.focus(); t.setSelectionRange(t.value.length, t.value.length);
  },
  target: (d) => { S.noteTarget[d.slug] = d.t; refresh(); },
  'send-note': async (d, el) => {
    const t = $('#note');
    if (!t.value.trim()) { t.focus(); return toast('Write what should change first.'); }
    const p = proj(d.slug);
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    try {
      const r = await api(`/api/projects/${d.slug}/notes`, { body: { text: t.value, horizontal: S.noteTarget[d.slug] === 'horizontal', watching: p && selected(p)?.file } });
      t.value = ''; askNotify(); queuedToast(r);
    } catch (e) { fail(e); }
    el.disabled = false;
    el.removeAttribute('aria-busy');
  },
  final: async (d) => {
    if (!await ask({ title: 'Make the final version?', body: 'The editor renders this video at full quality. It takes a little longer than a draft.', ok: 'Make final' })) return;
    try { queuedToast(await api(`/api/projects/${d.slug}/final`, { body: {} })); askNotify(); } catch (e) { fail(e); }
  },
  horizontal: async (d) => { try { queuedToast(await api(`/api/projects/${d.slug}/horizontal`, { body: {} })); askNotify(); } catch (e) { fail(e); } },
  retry: async (d) => { try { queuedToast(await api(`/api/projects/${d.slug}/retry`, { body: {} })); askNotify(); } catch (e) { fail(e); } },
  unqueue: (d) => api('/api/queue/remove', { body: { id: d.id } }).then(() => toast('Removed from the line.')).catch(fail),
  stop: async () => {
    if (await ask({ title: 'Stop the editor?', body: 'Work that is not saved as a version yet is lost. Versions already made stay. Anything waiting in line starts next.', ok: 'Stop editing', danger: true })) api('/api/stop', { body: {} }).catch(fail);
  },
  rename: (d) => { S.renaming = d.slug; S.focusRename = true; refresh(); },
  'rename-cancel': () => { S.renaming = null; refresh(); $('[data-action="rename"]')?.focus(); },
  'style-mode': async (d) => {
    if (d.mode === 'wizard' && (S.docs.style || '').length > 1200) {
      const kb = Math.max(1, Math.round(S.docs.style.length / 1000));
      if (!await ask({ title: 'Replace your detailed style?', body: `Your style is a detailed ${kb} KB spec. The quick questions write a short list instead, so most of those details would be lost. A backup is kept as my-style.md.bak.`, ok: 'Replace it', danger: true })) return;
    }
    S.styleMode = d.mode; S.wizard = { step: 0, answers: {} }; regionCache.clear(); refresh(); window.scrollTo(0, 0);
  },
  'rules-mode': (d) => { S.rulesMode = d.mode; regionCache.clear(); refresh(); },
  'save-doc': async (d) => {
    try {
      await api(`/api/doc/${d.doc}`, { method: 'PUT', body: { text: $('#doc-text').value } });
      S[`${d.doc}Mode`] = 'read'; toast('Saved.'); loadDoc(d.doc);
    } catch (e) { fail(e); }
  },
  'style-ask': async () => {
    const t = $('#style-ask');
    if (!t.value.trim()) return t.focus();
    try { const r = await api('/api/style/ask', { body: { text: t.value } }); S.docs.styleReply = null; t.value = ''; r.queued ? queuedToast(r) : toast('Updating your style…'); } catch (e) { fail(e); }
  },
  'wiz-back': () => { collectWizard(); S.wizard.step--; regionCache.clear(); refresh(); window.scrollTo(0, 0); },
  'wiz-next': async () => {
    collectWizard();
    if (S.wizard.step < WIZARD.length - 1) { S.wizard.step++; regionCache.clear(); refresh(); window.scrollTo(0, 0); return; }
    try {
      await api('/api/style/wizard', { body: S.wizard.answers });
      toast('Your style is saved.', { link: { href: '#/brand', label: 'Add your logo' } });
      S.styleMode = 'read'; S.wizard = { step: 0, answers: {} }; loadDoc('style');
    } catch (e) { fail(e); }
  },
  'add-rule': async () => {
    const t = $('#new-rule');
    const rule = t.value.trim().replace(/\s+/g, ' ');
    if (!rule) return t.focus();
    const cur = (S.docs.rules || '# My rules\n').trimEnd();
    const date = new Date().toLocaleDateString('en-CA');
    try { await api('/api/doc/rules', { method: 'PUT', body: { text: `${cur}\n- ${rule} (added in the app, ${date})\n` } }); t.value = ''; toast('Rule added.'); loadDoc('rules'); } catch (e) { fail(e); }
  },
  // brand
  jump: (d) => { const el = document.getElementById(d.to); el?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); el?.querySelector('button, input')?.focus({ preventScroll: true }); },
  'brand-pick': (d) => {
    S.brandPick = { slot: d.slot, category: d.category || null };
    const p = $('#brand-picker');
    p.accept = d.slot === 'broll' ? 'video/*,.mov,.mp4,.m4v' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    p.multiple = d.slot === 'broll';
    p.click();
  },
  'use-inbox': (d) => api('/api/brand/use-inbox', { body: { slot: d.slot, name: d.name } }).then(() => toast(d.slot === 'person' ? 'Sales person added. Check their title and numbers.' : 'Added to My brand.')).catch(fail),
  'add-line': (d, el) => { const box = $('[data-lines]', el.closest('form')); box.insertAdjacentHTML('beforeend', lineRow()); $$('input[name="label"]', box).at(-1).focus(); },
  'remove-line': (d, el) => { const row = el.closest('.line'); const next = row.nextElementSibling || row.previousElementSibling; row.remove(); next?.querySelector('input')?.focus(); },
  'import-pack': async () => { if (await askImport()) $('#pack-picker').click(); },
  unlock: async () => {
    if (!await ask({ title: 'Stop using the brand pack?', body: 'Your style stays as it is, but you can change it yourself again. Your videos may stop matching your team’s.', ok: 'Stop using it', danger: true })) return;
    api('/api/brand/unlock', { body: {} }).then(() => toast('You can change your style again.')).catch(fail);
  },
  // setup
  'run-setup': () => { S.setupLog = { running: true, lines: ['Starting setup…'] }; refresh(); api('/api/setup/run', { body: {} }).catch(fail); },
  'fix-setup': () => api('/api/setup/fix', { body: {} }).catch(fail),
  recheck: () => api('/api/setup/recheck', { body: {} }).then(() => toast('Checked.')).catch(fail),
  'set-perm': (d, el) => api('/api/settings', { body: { permissionMode: el.value } }).then(() => toast('Saved.')).catch(fail),
  'set-model': (d, el) => api('/api/settings', { body: { model: el.value } }).then(() => toast('Saved.')).catch(fail),
};

document.addEventListener('click', (e) => {
  const jump = e.target.closest('a[data-jump]');
  if (jump) setTimeout(() => ACTIONS.jump({ to: jump.dataset.jump }), 80);
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.tagName === 'INPUT') return; // checkboxes and radios use change
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener('change', (e) => {
  const imp = e.target.closest?.('[data-form="import-clips"]');
  if (imp) { const n = $$('input[name="clip"]:checked', imp).length; $('[data-import-count]', imp).textContent = n ? `${plural(n, 'clip')} picked.` : 'Pick the clips to move here.'; }
  const el = e.target.closest('input[data-action]');
  if (el) ACTIONS[el.dataset.action]?.(el.dataset, el);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.renaming && e.target.id === 'rename-input') { e.preventDefault(); ACTIONS['rename-cancel'](); return; }
  const el = e.target.closest?.('[role="button"][data-action]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ACTIONS[el.dataset.action]?.(el.dataset, el); }
  if (e.target.id === 'note' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('[data-action="send-note"]')?.click();
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'rename') {
    const title = $('#rename-input').value.trim();
    if (!title) return $('#rename-input').focus();
    try { await api(`/api/projects/${form.dataset.slug}/rename`, { body: { title } }); S.renaming = null; toast('Renamed.'); } catch (err) { fail(err); }
  }
  if (kind === 'groq') {
    const k = $('#groq-key');
    try { await api('/api/settings/groq', { body: { key: k.value } }); k.value = ''; toast('Key saved.'); } catch (err) { fail(err); }
  }
  const formLines = () => $$('.line', form).map((row) => ({ label: $('input[name="label"]', row).value, value: $('input[name="value"]', row).value }));
  if (kind === 'bcontact') {
    try { await api('/api/brand/contact', { body: { name: form.elements.name.value, lines: formLines() } }); toast('Brand contact saved.'); } catch (err) { fail(err); }
  }
  if (kind === 'person') {
    const el = form.elements;
    try {
      await api('/api/people', { body: { id: form.dataset.id || null, title: el.title.value, name: el.name.value, pronoun: el.pronoun.value, lines: formLines() } });
      S.personEdit = null; toast('Sales person saved.'); refresh();
    } catch (err) { fail(err); }
  }
  if (kind === 'new-folder') {
    const input = $('#new-folder');
    if (!input.value.trim()) return input.focus();
    try { const r = await api('/api/folders', { body: { name: input.value } }); S.newFolder = false; toast(`Folder “${r.name}” made.`, { link: { href: `#/f/${enc(r.name)}`, label: 'Open' } }); } catch (err) { fail(err); }
  }
  if (kind === 'rename-folder') {
    const input = $('#rename-folder');
    if (!input.value.trim()) return input.focus();
    try { const r = await api('/api/folders/rename', { body: { from: form.dataset.name, to: input.value } }); S.renamingFolder = false; S.pick = []; location.hash = `#/f/${enc(r.name)}`; refresh(); } catch (err) { fail(err); }
  }
  if (kind === 'import-clips') {
    const paths = $$('input[name="clip"]:checked', form).map((i) => i.value);
    if (!paths.length) return toast('Pick at least one clip.');
    try { const r = await api('/api/move', { body: { paths, folder: form.dataset.folder } }); $('#modal').close(); toast(`${plural(r.count, 'clip')} moved here.`); } catch (err) { fail(err); }
  }
  if (kind === 'newcat') {
    const input = $('#newcat');
    const c = input.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!c) return input.focus();
    if (!S.extraCats.includes(c)) S.extraCats.push(c);
    input.value = '';
    refresh();
    $(`[data-action="brand-pick"][data-category="${CSS.escape(c)}"]`)?.focus();
  }
  if (kind === 'export') {
    const name = form.elements.name.value.trim();
    if (!name) return form.elements.name.focus();
    const a = document.createElement('a');
    const on = (k) => (form.elements[k].checked ? 1 : 0);
    a.href = `/api/brand/export?name=${enc(name)}&broll=${on('broll')}&music=${on('music')}&people=${on('people')}`;
    a.download = '';
    document.body.append(a); a.click(); a.remove();
    toast('Making your brand pack. Send the file to your teammates any way you like.', { ms: 8000 });
  }
  if (kind === 'edit') {
    const fd = new FormData(form);
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      const r = await api('/api/edit', { body: {
        files: S.dialog.files, keepOrder: S.dialog.keep, name: fd.get('name') || '',
        instructions: fd.get('instructions') || '', broll: fd.getAll('broll'), extra: fd.getAll('extra'),
        contact: fd.get('contact') && fd.get('contact') !== 'all' ? { type: 'person', id: fd.get('contact') } : { type: 'all' },
      } });
      try { localStorage.setItem('f247.contact', fd.get('contact') || 'all'); } catch {}
      $('#modal').close();
      S.pick = [];
      askNotify(); queuedToast(r);
      location.hash = `#/p/${enc(r.slug)}`;
    } catch (err) { fail(err); btn.disabled = false; }
  }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.close(); });
$('#modal').addEventListener('close', () => { S.dialog = null; });

connect();
