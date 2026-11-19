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
  docs: { style: undefined, rules: undefined, brandRules: undefined, styleReply: null, learned: undefined },
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
  importIco: icon('tray-arrow-down'), queue: icon('queue'), soundOn: icon('speaker-high'), soundOff: icon('speaker-slash'), copy: icon('copy'),
};
for (const el of document.querySelectorAll('i[data-icon]')) el.outerHTML = icon(el.dataset.icon);
const kindIcon = (k) => ({ video: I.film, image: I.image, text: I.text, audio: I.music })[k] || I.text;

// ---------- formatting ----------
const fmtClock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
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
const tapeLabel = (l) => l.startsWith('bg-') ? l.replace(/^bg-(\w)(\w*)-/, (_, a, b) => `${a.toUpperCase()}${b} bg `) : l === 'final' ? 'Final' : l === 'horizontal-final' ? 'YouTube final' : l.startsWith('horizontal-') ? `YouTube ${l.slice(11)}` : l;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const prettyCat = (c) => c.replace(/-/g, ' ').replace(/^\w/, (x) => x.toUpperCase());
// Sound effects live in my-sounds/sfx as <kind>-<n>.*, kept apart from the music list.
function sfxSummary() {
  const sfx = S.state.sfx || [];
  if (!sfx.length) return '';
  const kinds = [...new Set(sfx.map((f) => f.name.replace(/(-\d+)?\.\w+$/, '')))].sort();
  return `<p class="small muted" style="margin-top:12px">${plural(sfx.length, 'sound effect')} in ${plural(kinds.length, 'kind')}: ${esc(kinds.map((k) => k.replace(/-/g, ' ')).join(', '))}. The editor picks from them.
    <button class="btn quiet sm" data-action="reveal" data-area="sounds" data-folder="${esc(sfx[0].folder)}" data-name="${esc(sfx[0].name)}">Show in folder</button></p>`;
}
const JOB_LABEL = { bgcheck: 'Background check', edit: 'New video', go: 'Full edit', notes: 'Notes', final: 'Final version', horizontal: 'YouTube version', style: 'Style update', learn: 'Learning a style', setup: 'Setup' };

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
let lastHeard = Date.now();
function connect() {
  const es = new EventSource('/api/events');
  // A connection can die silently (laptop sleep, network change) and the page would keep showing an old job.
  // The server pings every 25 s; after 60 s of silence, reconnect, which also resends the full state.
  for (const ev of ['state', 'job', 'setup', 'done', 'ping']) es.addEventListener(ev, () => { lastHeard = Date.now(); });
  const watch = setInterval(() => {
    if (Date.now() - lastHeard > 60000) { clearInterval(watch); es.close(); lastHeard = Date.now(); connect(); }
  }, 10000);
  es.addEventListener('state', (e) => { S.state = JSON.parse(e.data); S.job = S.state.job; refresh(); });
  es.addEventListener('job', (e) => { S.job = JSON.parse(e.data); refresh(); });
  es.addEventListener('setup', (e) => { S.setupLog = JSON.parse(e.data); refresh(); });
  es.addEventListener('done', (e) => onDone(JSON.parse(e.data)));
  es.onerror = () => { document.title = 'free247editor (reconnecting…)'; };
}

function onDone(d) {
  if (d.kind === 'style' && !d.styleId) {
    S.docs.style = undefined; S.docs.styleReply = { text: d.text, error: d.error };
    if (route().name === 'style') loadDoc('style');
  }
  if ((d.kind === 'style' || d.kind === 'learn') && d.styleId && route().name === 'style' && route().arg === d.styleId) loadLearned(d.styleId);
  const styleName = S.state?.styles.find((x) => x.id === d.styleId)?.name || 'The new style';
  const proj = S.state?.projects.find((p) => p.slug === d.slug);
  const name = proj?.title || 'Your video';
  if (d.kind === 'learn') toast(d.error || d.text?.startsWith('Stopped') ? `${styleName}: learning did not finish.` : `${styleName} is ready to use.`, { bad: d.error, link: { href: `#/style/${enc(d.styleId)}`, label: 'See it' }, ms: 9000 });
  else if (d.kind === 'setup') toast(d.error ? 'Setup ran into a problem. Open Setup to read why.' : 'Setup check finished.', { bad: d.error, link: { href: '#/setup', label: 'Open' }, ms: 9000 });
  else if (d.error) toast(`${name}: the editor ran into a problem. Open it to see what happened.`, { bad: true, link: d.slug ? { href: `#/p/${d.slug}`, label: 'Open' } : null, ms: 10000 });
  else if (d.text?.startsWith('Stopped')) toast('Stopped.');
  else if (d.kind === 'fix') toast(`${name}: the fixed part is going back in. The new version is ready in a moment.`, { link: d.slug ? { href: `#/p/${d.slug}`, label: 'Read' } : null, ms: 9000 });
  else if (d.kind !== 'style' && !d.newVersion) toast(`The editor replied about ${name}.`, { link: d.slug ? { href: `#/p/${d.slug}`, label: 'Read' } : null, ms: 9000 });
  else if (d.kind !== 'style') toast(`${name} is ready to watch.`, { link: d.slug ? { href: `#/p/${d.slug}`, label: 'Watch' } : null, ms: 9000 });
  else toast(d.styleId ? `${styleName} was updated.` : 'Your style was updated.');
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
  if (!S.state.brand || !S.state.queue || !S.state.styles || !('outdated' in S.state) || S.state.outdated) {
    current = { key: 'outdated', view: null };
    $('#main').innerHTML = `<div class="banner alert">${I.warn}<div><strong>The app was updated. Restart it to finish.</strong>
      <span class="muted">Close the black app window (or press Ctrl+C in it), then double-click Open Editor again.</span></div></div>`;
    return;
  }
  const r = route();
  const key = `${r.name}:${r.arg || ''}`;
  if (key !== current.key) {
    current.view?.leave?.();
    current = { key, view: VIEWS[r.name] || VIEWS.studio };
    document.body.classList.toggle('editing', r.name === 'edit');
    regionCache.clear();
    $('#main').innerHTML = current.view.layout(r.arg);
    for (const a of $$('.nav')) if (a.dataset.nav === ({ project: 'videos', edit: 'videos', folder: 'studio' }[r.name] || r.name)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
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
const jobHref = (j) => (j.slug ? `#/p/${enc(j.slug)}` : j.styleId ? `#/style/${enc(j.styleId)}` : j.kind === 'style' ? '#/style/main' : '#/setup');
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
    out += `<div class="banner">${I.style}<div><strong>Pick your style</strong><span class="muted">Import your team's brand pack, or answer a few quick questions. About 2 minutes.</span></div><a class="btn primary" href="#/style/main">Set my style</a></div>`;
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
      <div><div class="name" title="${esc(p.title)}">${esc(p.title)}</div><div class="meta">${p.versions.length ? `${plural(p.versions.length, 'version')} · ` : ''}${ago(p.updatedAt)}</div></div>
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
        const files = S.state.inbox.filter((f) => f.folder === fo.name).length;
        return `<div class="folder-tile"><a class="folder" href="#/f/${enc(fo.name)}" data-drop-folder="${esc(fo.name)}">
          <span class="covers">${covers.length ? covers.map((c) => `<img src="${clipThumb(c)}" alt="" loading="lazy" decoding="async">`).join('') : `<span class="nofile">${I.folder}</span>`}</span>
          <span class="fname">${esc(fo.name)}</span><span class="meta">${clips.length ? plural(clips.length, 'clip') : 'Empty'} · ${ago(fo.mtime)}</span></a>
          ${delBtn([{ area: 'inbox', path: fo.name }], files ? `the folder “${fo.name}” and its ${plural(files, 'file')}` : `the folder “${fo.name}”`, { cls: 'card-del' })}</div>`;
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
        <div data-region="pv"></div>
        <div class="under-player" data-region="under"></div>
        <div data-region="notdone"></div>
      </div>
      <div class="col">
        <p class="sr" aria-live="polite" data-region="liveStep"></p>
        <div data-region="progress" hidden></div>
        <div data-region="bgswap"></div>
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
      const forWho = `${p.clean ? 'Clean raw · ' : ''}${p.contactLabel ? `${esc(p.contactLabel)} · ` : ''}${p.styleName ? `${esc(p.styleName)} style · ` : ''}`;
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
      const pv = p?.preview;
      if (pv?.video && S.job?.slug !== slug) return `<video controls playsinline preload="metadata" src="/media/outbox/${enc(pv.video)}?t=${Math.round(pv.mtime)}" poster="/thumb/outbox/${enc(pv.video)}?t=${Math.round(pv.mtime)}"></video>`;
      if (S.job?.slug === slug && p?.previewFirst && S.job.kind !== 'go') return `<div class="waiting"><span class="live"></span><b>Your preview is on its way.</b><span>A storyboard and a 5-second sample, so you can check the look before the full edit.</span></div>`;
      if (S.job?.slug === slug) return `<div class="waiting"><span class="live"></span><b>Your first draft is on its way.</b><span>Most videos take 10 to 30 minutes. You can leave this page; you'll get a notice when it's ready.</span></div>`;
      if (p?.status === 'manual') return `<div class="waiting"><b>Ready for your changes.</b><span>Zoom, cut and add clips in the editor, then press Auto edit.</span><a class="btn" href="#/edit/${enc(slug)}">${I.film} Open in editor</a></div>`;
      if (p?.status === 'queued') return `<div class="waiting"><b>Waiting in line.</b><span>The editor starts this as soon as it finishes what it's doing.</span></div>`;
      return `<div class="waiting"><b>No video yet.</b><span>${p?.status === 'error' || p?.status === 'interrupted' ? 'The last run did not finish. See the reply on the right.' : ''}</span></div>`;
    },
    under: (slug) => {
      const p = proj(slug);
      const v = p && selected(p);
      const quick = v && S.job?.slug !== slug && p.status !== 'queued' ? `<div class="quick">
        <button class="btn sm" data-action="open-editor" data-slug="${esc(slug)}" data-file="${esc(v.file)}">${I.film} Open in editor</button>
        <span class="muted small">Zoom, cut and add clips yourself. No AI used.</span></div>` : '';
      return `${quick}${v ? `<a class="btn quiet sm" href="/media/outbox/${enc(v.file)}" download="${esc(v.file)}">${I.down} Download</a>
        <button class="btn quiet sm" data-action="reveal" data-area="outbox" data-name="${esc(v.file)}">${I.folder} Show in folder</button>
        ${S.job?.slug === slug || p.status === 'queued' ? '' : delBtn([{ area: 'version', path: v.file }], `version ${tapeLabel(v.label)}`, { label: 'Delete this version' })}` : ''}
        <button class="btn quiet sm" data-action="reveal" data-area="kit" data-name="${esc(slug)}" title="The editable project files">${I.folder} Project files</button>`;
    },
    pv: (slug) => {
      const p = proj(slug);
      const pv = p?.preview;
      if (!pv || p.versions.length || S.job?.slug === slug || p.status === 'queued') return '';
      return `<section class="panel preview-panel">
        <div class="panel-head"><h2 class="sub">${I.film} Preview</h2><span class="muted small">Nothing full-length is made until you say so.</span></div>
        ${pv.frames.length ? `<div class="board">${pv.frames.map((f, i) => `<figure class="frame"><a href="/media/outbox/${enc(f)}?t=${Math.round(pv.mtime)}" target="_blank" rel="noopener"><img src="/media/outbox/${enc(f)}?t=${Math.round(pv.mtime)}" alt="Storyboard frame ${i + 1}" loading="lazy" decoding="async"></a></figure>`).join('')}</div>` : ''}
        <div class="row"><button class="btn primary" data-action="go" data-slug="${esc(slug)}">${I.check} Looks good, make the full edit</button>
          <span class="muted small">Not right? Write what to change below and the editor makes a new preview.</span></div>
      </section>`;
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
        return progressPanel(j, { edit: p?.previewFirst ? 'Making your preview' : 'Editing your video', go: 'Building the full edit', final: 'Making the final version', horizontal: 'Making the YouTube version', bgcheck: 'Checking your background photo' }[j.kind] || 'Working on your notes');
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
    bgswap: bgPanel,
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
      if (p?.preview && !p.versions.length) return 'Makes a new preview.';
      const n = p ? p.versions.filter((v) => /^v\d+$/.test(v.label)).length : 0;
      return n ? `Makes version ${n + 1}.` : '';
    },
  },
  after: (slug) => {
    const p = proj(slug);
    for (const b of $$('[data-action="send-note"], [data-action="final"], [data-action="horizontal"]')) b.disabled = !p;
    for (const b of $$('[data-action="final"], [data-action="horizontal"]')) if (p && !p.versions.length) b.disabled = true;
    for (const b of $$('[data-action="horizontal"]')) b.hidden = Boolean(p?.clean);
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

// ---------- replace background (clean raw videos only) ----------
// Free steps (photo, check, prices) run on a click. Paid steps ask first with the exact credits.
const BG_VERDICT = { good: 'Looks right', fixable: 'Fixable', bad: 'Not usable' };
const bgModelName = { kling: 'Kling 4.0', seedance: 'Seedance 2.5' };
function bgPanel(slug) {
  const p = proj(slug);
  if (!p?.clean || !p.versions.some((v) => /^(v\d+|final)$/.test(v.label))) return '';
  const b = p.bg || {};
  // Optional step: without Higgsfield on this computer there is nothing to press, so just say it can be skipped.
  if (!S.state.setup.higgsfield && !Object.keys(b.runs || {}).length) {
    return `<section class="panel"><div class="panel-head"><h2 class="sub">${I.image} Replace background <span class="muted small">(optional)</span></h2></div>
      <p class="muted small" style="margin-top:6px">Needs a Higgsfield account, which is not set up on this computer. You can skip it: your clean video is ready to use as it is.</p></section>`;
  }
  const v = `?v=${b.stamp || 0}-${b.check ? 1 : 0}`;
  const file = (f) => `/bgfile/${enc(slug)}/${f.split('/').map(enc).join('/')}${v}`;
  const checking = (S.job?.slug === slug && S.job.kind === 'bgcheck') || S.state.queue.some((q) => q.slug === slug && q.type === 'bgcheck');
  const working = b.busy ? `<p class="small"><span class="live"></span> ${esc(b.busy)}…</p>` : '';
  const c = b.check;
  const step1 = `<div class="bg-step"><h3 class="sub">1. Background photo</h3>
    ${b.photo ? `<div class="bg-pics"><figure><img src="${file(b.photo)}" alt="Your background photo"><figcaption>Your photo</figcaption></figure>
      ${b.reference ? `<figure><img src="${file(b.reference)}" alt="What the AI will use"><figcaption>${b.plate ? 'Angle-matched' : 'What the AI uses'}</figcaption></figure>` : ''}</div>` : '<p class="muted small">A photo of the room you want behind you. The check tells you if its angle and light fit your video.</p>'}
    <div class="row"><button class="btn sm" data-action="bg-photo" data-slug="${esc(slug)}">${I.image} ${b.photo ? 'Change photo' : 'Add background photo'}</button>
      ${b.photo ? `<button class="btn sm${c ? '' : ' primary'}" data-action="bg-check" data-slug="${esc(slug)}" ${checking ? 'disabled' : ''}>${checking ? 'Checking…' : c ? 'Check again' : 'Check background'}</button><span class="muted small">Free</span>` : ''}</div>
    ${c ? `<div><span class="verdict ${esc(c.verdict)}">${esc(BG_VERDICT[c.verdict] || c.verdict)}</span>
      <ul class="small" style="margin:8px 0 0 18px">${(c.points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      ${c.fix ? `<p class="small" style="margin-top:6px"><b>Fix:</b> ${esc(c.fix)}</p>` : ''}</div>
      ${c.verdict !== 'good' && b.platePrompt && !b.plate ? `<div class="bg-free"><h3 class="sub">Make it yourself on Higgsfield <span class="muted small">(free with Nano Banana Pro Unlimited)</span></h3>
        <ol class="small"><li>Open <a href="https://higgsfield.ai" target="_blank" rel="noopener">higgsfield.ai</a> and pick <b>Nano Banana Pro</b>, 2K, 9:16.</li>
          <li>Add these two pictures, in this order:</li></ol>
        <div class="bg-pics">${b.cameraFrame ? `<figure><a href="${file('camera_frame.jpg')}" download="1-camera.jpg"><img src="${file('camera_frame.jpg')}" alt="Picture 1: a frame of your video"></a><figcaption>1. Your video (camera)</figcaption></figure>` : ''}
          <figure><a href="${file(b.photo)}" download="2-room${esc(b.photo.slice(b.photo.lastIndexOf('.')))}"><img src="${file(b.photo)}" alt="Picture 2: your room photo"></a><figcaption>2. Your room</figcaption></figure></div>
        <p class="muted small">Click a picture to save it.</p>
        <ol class="small" start="3"><li>Paste this prompt:</li></ol>
        <textarea id="bg-plate-prompt" readonly rows="6">${esc(b.platePrompt)}</textarea>
        <div class="row"><button class="btn sm" data-action="bg-copy-prompt">${I.copy} Copy prompt</button></div>
        <ol class="small" start="4"><li>Save the picture it makes, press <b>Change photo</b> above, pick that picture, then <b>Check again</b>.</li></ol></div>` : ''}
      ${c.verdict !== 'good' ? `<div class="row"><button class="btn sm" data-action="bg-plate" data-slug="${esc(slug)}" ${b.busy ? 'disabled' : ''}>Make an angle-matched background</button><span class="muted small">Costs a few credits; you see the price first</span></div>` : ''}` : ''}
  </div>`;
  const q = b.quote;
  const runs = Object.entries(b.runs || {});
  const step2 = c && b.reference ? `<div class="bg-step"><h3 class="sub">2. Pick model and quality</h3>
    ${q ? `<p class="muted small">${plural(q.chunks, 'part')}, ${fmtDur(q.seconds)} in total. Your balance: <b>${esc(q.balance)}</b> credits.</p>
      <table class="bg-price"><tbody>${q.rows.map((r) => `<tr><td><label class="row" style="gap:8px"><input type="checkbox" name="bgpick" value="${esc(r.model)}|${esc(r.res)}">${esc(r.name)}</label></td><td>${esc(r.res)}</td><td class="num">${esc(r.total)} credits</td></tr>`).join('')}</tbody></table>
      <label class="field"><span>Prompt <span class="hint">(the same for every part, so the room matches)</span></span><textarea id="bg-prompt">${esc(b.prompt)}</textarea></label>
      <div class="row"><button class="btn primary" data-action="bg-generate" data-slug="${esc(slug)}">${I.play} Generate…</button><span class="muted small">Each model runs one part at a time. You confirm the total first.</span></div>`
    : `<div class="row"><button class="btn sm primary" data-action="bg-prices" data-slug="${esc(slug)}" ${b.busy ? 'disabled' : ''}>Get prices</button><span class="muted small">Free. Splits your video at pauses and asks Higgsfield for each price.</span></div>`}
  </div>` : '';
  const runHtml = ([key, r]) => {
    const name = `${bgModelName[r.model] || r.model} ${r.res}`;
    const row = q?.rows.find((x) => x.model === r.model && x.res === r.res);
    const state = r.status === 'running' ? `<span class="live"></span> Part ${Math.min(r.done + 1, r.total)} of ${r.total}…`
      : r.status === 'done' ? `${I.check} Saved as <b>${esc(tapeLabel(r.version.replace(/^.*-(bg-[a-z]+-v\d+)\.mp4$/, '$1')))}</b> above`
      : r.status === 'interrupted' ? 'Stopped when the app closed.' : `<span class="bg-flag">${esc(r.error || 'Stopped.')}</span>`;
    const again = ['interrupted', 'error'].includes(r.status)
      ? `<button class="btn sm" data-action="bg-again" data-slug="${esc(slug)}" data-key="${esc(key)}">${I.retry} Continue</button>` : '';
    const flagged = (r.report || []).filter((x) => x.flags?.length);
    const parts = r.status === 'done' ? `
      ${r.boundaries?.length ? `<p class="small muted">Where parts meet (left: end of one part, right: start of the next). The room should not jump.</p>
        <div class="bg-pics wide">${r.boundaries.map((f) => `<figure><img src="${file(`runs/${key}/boundaries/${f}`)}" alt="Where parts meet: ${esc(f.replace(/\D+/g, ' ').trim().replace(' ', ' and '))}" loading="lazy"><figcaption>Parts ${esc(f.replace(/\D+/g, ' ').trim().replace(' ', ' → '))}</figcaption></figure>`).join('')}</div>` : ''}
      ${flagged.length ? `<ul class="small bg-flag" style="margin-left:18px">${flagged.map((x) => `<li>${esc(x.chunk.replace(/\.mp4$/, '').replace('chunk_', 'Part '))}: ${esc(x.flags.join('; '))}</li>`).join('')}</ul>` : '<p class="small">Lips stay in sync in every part.</p>'}
      <details><summary class="small">Redo one part</summary><div class="row" style="flex-wrap:wrap;margin-top:8px">${(r.report || []).map((x, i) => {
        const id = x.chunk.replace(/\.mp4$/, '');
        return `<button class="btn sm" data-action="bg-again" data-slug="${esc(slug)}" data-key="${esc(key)}" data-chunk="${esc(id)}" data-cost="${esc(row?.perChunk[i] ?? '')}">Part ${i + 1}${row ? ` · ${esc(row.perChunk[i])} credits` : ''}</button>`;
      }).join('')}</div></details>` : '';
    return `<div class="bg-run"><b>${esc(name)}</b><p class="small">${state}</p>${again ? `<div class="row">${again}</div>` : ''}${parts}</div>`;
  };
  const step3 = runs.length ? `<div class="bg-step"><h3 class="sub">3. Results</h3>${runs.map(runHtml).join('')}</div>` : '';
  return `<section class="panel"><div class="panel-head"><h2 class="sub">${I.image} Replace background <span class="muted small">(optional)</span></h2></div>
    ${b.error ? `<p class="small bg-flag" role="alert">${esc(b.error)}</p>` : ''}${working}${step1}${step2}${step3}</section>`;
}
function selected(p) {
  const file = S.sel[p.slug];
  return p.versions.find((v) => v.file === file) || [...p.versions].sort((a, b) => b.mtime - a.mtime)[0];
}

// ---------- manual editor: timeline math (pure; the scratchpad test slices this block out) ----------
// Parts play in order; "output time" is time in the finished video, in/out are seconds of each part's source.
const MIN_PART = 0.1;
const r3 = (n) => Math.round(n * 1000) / 1000;
const partLen = (p) => p.out - p.in;
const totalLen = (parts) => parts.reduce((s, p) => s + partLen(p), 0);
const partStart = (parts, i) => totalLen(parts.slice(0, i));
// The part playing at output time t and how far into it. Past the end lands at the end of the last part.
function locate(parts, t) {
  let start = 0;
  for (let i = 0; i < parts.length; i++) {
    const len = partLen(parts[i]);
    if (t < start + len || i === parts.length - 1) return { i, start, off: Math.min(Math.max(0, t - start), len) };
    start += len;
  }
  return null;
}
// Splits the part under t in two. Returns the right half's index, or -1 when t is too near an edge.
function splitAt(parts, t) {
  const L = locate(parts, t);
  if (!L || L.off < MIN_PART || partLen(parts[L.i]) - L.off < MIN_PART) return -1;
  const p = parts[L.i];
  const cut = r3(p.in + L.off);
  parts.splice(L.i, 1, { ...p, out: cut }, { ...p, in: cut });
  return L.i + 1;
}
// Puts a part in at t: at a boundary goes between parts, inside a part splits it. Returns the new index.
function insertAt(parts, t, part) {
  const L = locate(parts, t);
  let i = 0;
  if (L && L.off < MIN_PART) i = L.i;
  else if (L) { const r = splitAt(parts, t); i = r < 0 ? L.i + 1 : r; }
  parts.splice(i, 0, part);
  return i;
}
function trimPart(p, edge, value, duration) {
  if (edge === 'in') p.in = r3(Math.min(Math.max(0, value), p.out - MIN_PART));
  else p.out = r3(Math.max(Math.min(duration, value), p.in + MIN_PART));
}
const movePart = (parts, from, to) => parts.splice(to, 0, parts.splice(from, 1)[0]);
// Where a part's picture sits in the W x H frame, as fractions of the frame. Zoom 1 = the source scaled to fill
// the frame. x,y = the point of the source at the frame centre. At zoom 1 or more it is clamped so no empty edge
// shows; under 1 it is not and the empty edge is black. Same rule as place() in app/editor.mjs.
function place(part, src, W, H) {
  const s = Math.max(W / src.width, H / src.height) * part.zoom;
  const w = (src.width * s) / W, h = (src.height * s) / H;
  const clamp = (v, size) => (part.zoom >= 1 ? Math.min(Math.max(v, 1 / (2 * size)), 1 - 1 / (2 * size)) : Math.min(Math.max(v, 0), 1));
  const x = clamp(part.x, w), y = clamp(part.y, h);
  return { w, h, x, y, left: 0.5 - x * w, top: 0.5 - y * h };
}
// Sound clips sit on the output timeline at `at`, playing in..out of their source, over the parts' own sound.
const sndLen = (a) => a.out - a.in;
const nextSoundId = (audio) => `a${Math.max(0, ...audio.map((a) => Number(String(a.id).slice(1)) || 0)) + 1}`;
// Splits sound clip i at output time t. Returns the right half's index, or -1 when t is not well inside it.
function splitSound(audio, i, t, id) {
  const a = audio[i];
  const off = t - a.at;
  if (off < MIN_PART || sndLen(a) - off < MIN_PART) return -1;
  const cut = r3(a.in + off);
  audio.splice(i, 1, { ...a, out: cut }, { ...a, id, in: cut, at: r3(t) });
  return i + 1;
}
// Dragging the left edge keeps the clip's end where it is in time (and never starts before 0:00); the right edge moves the end.
function trimSound(a, edge, d, orig, duration) {
  if (edge === 'in') { a.in = r3(Math.min(Math.max(0, orig.in + d, orig.in - orig.at), orig.out - MIN_PART)); a.at = r3(orig.at + a.in - orig.in); }
  else a.out = r3(Math.max(Math.min(duration, orig.out + d), orig.in + MIN_PART));
}
// "Extract audio": part i's sound becomes a sound clip at the same place, and the part is muted.
function extractAudio(parts, i, id) {
  const p = parts[i];
  const clip = { id, src: p.src, in: p.in, out: p.out, at: r3(partStart(parts, i)), volume: p.volume || 1 };
  p.volume = 0;
  return clip;
}
// Overlapping sound clips go on separate rows: each takes the first row that is free when it starts.
function soundRows(audio) {
  const ends = [], rows = [];
  for (const i of audio.map((_, j) => j).sort((x, y) => audio[x].at - audio[y].at)) {
    let r = ends.findIndex((e) => e <= audio[i].at + 1e-6);
    if (r < 0) r = ends.length;
    ends[r] = audio[i].at + sndLen(audio[i]);
    rows[i] = r;
  }
  return rows;
}
// ---------- end of timeline math ----------

// ---------- manual editor (#/edit/<slug>) ----------
// One <video> per source; the one for the part under the playhead is shown, sized and moved by place().
// Edits change E.parts / E.marks, then edCommit() keeps an undo step and saves a moment later.
let E = null;
const edSrc = (id) => E.sources.find((s) => s.id === id);
const edVid = (id) => $$('[data-ed-frame] video').find((v) => v.dataset.src === id);
const edTotal = () => totalLen(E.parts);
const EI = {
  split: icon('scissors'), pause: icon('pause'), undo: icon('arrow-counter-clockwise'), mark: icon('selection-plus'), zoom: icon('magnifying-glass-plus'),
  reset: icon('frame-corners'), wave: icon('waveform'), addSound: icon('music-notes-plus'), note: icon('note-pencil'), vol: icon('speaker-low'),
};
const edJSON = () => JSON.stringify({ parts: E.parts, marks: E.marks, audio: E.audio });
const pct = (v) => `${Math.round((v ?? 1) * 100)}%`;
const edPreview = new Audio(); // "Listen" in the Add sound dialog

VIEWS.edit = {
  layout: (slug) => `<div class="ed">
    <header class="ed-top">
      <a class="btn quiet sm" href="#/p/${enc(slug)}">${I.left} Back to the video</a>
      <h1>${esc(proj(slug)?.title || 'Editor')}</h1>
      <span class="small ed-status" aria-live="polite" data-ed-status></span>
      <div class="row">
        <button class="btn sm" data-action="ed-render" disabled title="Makes a new version you can watch and download">${I.check} Save as new version</button>
        <button class="btn sm primary" data-action="ed-auto" disabled title="The AI edits what you made here: captions, graphics and sound in your style">${I.star} Auto edit</button>
      </div>
    </header>
    <div class="ed-body" data-ed-body><div class="ed-wait"><span class="live"></span><b>Opening the editor…</b></div></div>
  </div>`,
  enter: (slug) => {
    E = { slug, sources: [], parts: [], marks: [], audio: [], sounds: [], frames: {}, sel: -1, mark: -1, snd: -1, panel: null, cur: -1, t: 0, pps: 20, playing: false,
      rev: 0, savedRev: 0, saveP: Promise.resolve(), undo: [], snapAt: 0, marking: false, busy: '', ready: false };
    edLoad();
  },
  leave: () => {
    const e = E;
    E = null;
    if (!e) return;
    e.playing = false; cancelAnimationFrame(e.raf); clearTimeout(e.poll); e.ro?.disconnect();
    for (const v of $$('[data-ed-frame] video, [data-ed-auds] audio')) v.pause();
    edPreview.pause();
    if (e.rev !== e.savedRev) edSave(e);
  },
  regions: {},
};

async function edLoad() {
  const e = E;
  if (!e) return;
  clearTimeout(e.poll);
  let d;
  try { d = await api(`/api/projects/${enc(e.slug)}/editor`); } catch (err) { d = { ready: false, error: err.message }; }
  if (E !== e) return;
  // A video made a moment ago is not in the state yet when the page first draws.
  const h1 = $('.ed-top h1');
  if (h1 && proj(e.slug)) h1.textContent = proj(e.slug).title;
  // Nothing opened and nothing on its way: polling would wait forever.
  if (!d.ready && !d.preparing && !d.error) d.error = 'Nothing is open in the editor for this video yet. Go back, pick a version, and press "Open in editor".';
  Object.assign(e, { canAuto: d.canAuto, from: d.from, W: d.width || e.W, H: d.height || e.H, preparing: d.preparing || '' });
  if (!d.ready) {
    $('[data-ed-body]').innerHTML = d.error && !d.preparing
      ? `<div class="ed-wait">${I.warn}<b>The editor could not open this video.</b><span>${esc(d.error)}</span><a class="btn" href="#/p/${enc(e.slug)}">Back to the video</a></div>`
      : `<div class="ed-wait"><span class="live"></span><b>${d.fixing ? 'Fixing one part…' : 'Getting your clips ready…'}</b><span>${esc(d.preparing || 'Long clips take a minute or two.')} You can leave this page and come back.</span></div>`;
    e.poll = setTimeout(edLoad, d.error && !d.preparing ? 8000 : 2000);
    return;
  }
  e.sources = d.sources;
  e.sounds = d.sounds || [];
  if (!e.ready) {
    e.ready = true;
    e.parts = d.parts?.length ? d.parts : d.sources.filter((s) => s.kind !== 'sound').map((s) => ({ src: s.id, in: 0, out: s.duration, zoom: 1, x: 0.5, y: 0.5, volume: 1 }));
    e.marks = d.marks || [];
    e.audio = d.audio || [];
    e.last = edJSON();
    edBuild();
  } else edSyncVideos();
  // A clip or sound added from "Add clip" / "Add sound" goes in at the playhead once its source is ready to play.
  const s = e.pending && d.sources.find((x) => x.id === e.pending.id);
  if (s?.url && s.duration > 0 && !d.preparing) {
    edPause();
    const sound = e.pending.kind === 'sound';
    if (sound) {
      e.audio.push({ id: nextSoundId(e.audio), src: s.id, in: 0, out: r3(s.duration), at: r3(e.pending.t), volume: 1 });
      Object.assign(e, { pending: null, sel: -1, mark: -1, snd: e.audio.length - 1, panel: null });
    } else {
      const i = insertAt(e.parts, e.pending.t, { src: s.id, in: 0, out: r3(s.duration), zoom: 1, x: 0.5, y: 0.5, volume: 1 });
      Object.assign(e, { pending: null, sel: i, mark: -1, snd: -1, panel: null, t: partStart(e.parts, i) });
    }
    edCommit(); edDraw(); toast(sound ? 'Sound added.' : 'Clip added.');
  } else if (e.pending && d.error) { e.pending = null; toast(d.error, { bad: true, ms: 9000 }); }
  edDrawTools();
  if (d.preparing || e.pending) e.poll = setTimeout(edLoad, 2000);
}

function edBuild() {
  $('[data-ed-body]').innerHTML = `
    <div class="ed-stage" data-ed-stage>
      <div class="ed-frame" data-ed-frame role="group" aria-label="Video preview. Drag to move the picture, scroll to zoom.">
        <div class="ed-boxes" data-ed-boxes></div><div class="ed-draw" data-ed-draw hidden></div>
        <p class="ed-hint" data-ed-hint hidden>Draw a box around the spot</p>
      </div>
    </div>
    <div data-ed-auds hidden></div>
    <div class="ed-tools" data-ed-tools></div>
    <div class="ed-scroll" data-ed-scroll><div class="ed-track" data-ed-track></div></div>`;
  edSyncVideos();
  const stage = $('[data-ed-stage]');
  const fit = () => {
    const f = $('[data-ed-frame]');
    if (!f || !E?.W) return;
    const k = Math.min((stage.clientWidth - 32) / E.W, (stage.clientHeight - 32) / E.H); // minus the stage padding
    f.style.width = `${E.W * k}px`; f.style.height = `${E.H * k}px`;
  };
  E.ro = new ResizeObserver(fit);
  E.ro.observe(stage);
  fit();
  E.pps = Math.min(300, Math.max(2, ($('[data-ed-scroll]').clientWidth - 80) / Math.max(1, edTotal())));
  edDraw();
}

// Adds a <video> (and reads the filmstrip size) for each source that does not have one yet.
function edSyncVideos() {
  const f = $('[data-ed-frame]');
  if (!f) return;
  for (const s of E.sources) {
    if (!s.url || s.kind === 'sound' || edVid(s.id)) continue;
    const v = document.createElement('video');
    Object.assign(v, { src: s.url, preload: 'auto', playsInline: true, hidden: true });
    v.dataset.src = s.id;
    f.prepend(v);
    if (s.strip && !(s.id in E.frames)) {
      E.frames[s.id] = s.duration;
      const im = new Image();
      // The filmstrip is one frame per second in a row; count its frames so the timeline lines up.
      im.onload = () => { if (E) { E.frames[s.id] = Math.round(im.naturalWidth / ((im.naturalHeight * s.width) / s.height)) || s.duration; edDrawTrack(); } };
      im.src = s.strip;
    }
  }
}

function edPlace(v, p) {
  const s = v && edSrc(p.src);
  if (!s) return;
  const g = place(p, s, E.W, E.H);
  Object.assign(v.style, { width: `${g.w * 100}%`, height: `${g.h * 100}%`, left: `${g.left * 100}%`, top: `${g.top * 100}%` });
}

// Shows output time t in the player (seeking that source when paused).
function edShow(t, seek = !E.playing) {
  const L = locate(E.parts, Math.max(0, t));
  if (!L) return;
  E.t = L.start + L.off;
  const p = E.parts[L.i];
  E.cur = L.i;
  for (const v of $$('[data-ed-frame] video')) { const on = v.dataset.src === p.src; if (!on) v.pause(); v.hidden = !on; }
  const v = edVid(p.src);
  edPlace(v, p);
  if (v) edGain(v, p.volume ?? 1);
  if (v && seek) v.currentTime = Math.min(p.in + L.off, p.out - 0.01);
  edTick();
}

function edTick() {
  const head = $('[data-ed-head]');
  if (head) head.style.transform = `translateX(${E.t * E.pps}px)`;
  const tm = $('[data-ed-time]');
  if (tm) tm.textContent = `${fmtClock(E.t)} / ${fmtClock(edTotal())}`;
  const on = E.marks.map((m, i) => [m, i]).filter(([m]) => E.t >= m.start && E.t < m.end);
  const html = on.map(([m, i]) => `<div class="ed-box${i === E.mark ? ' on' : ''}" style="left:${m.box.x * 100}%;top:${m.box.y * 100}%;width:${m.box.w * 100}%;height:${m.box.h * 100}%"><span>${i + 1}</span></div>`).join('');
  const boxes = $('[data-ed-boxes]');
  if (boxes && boxes.innerHTML !== html) boxes.innerHTML = html;
}

function edFollow() {
  const sc = $('[data-ed-scroll]');
  const x = E.t * E.pps;
  if (sc && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40)) sc.scrollLeft = x - 40;
}

function edPlay() {
  if (E.playing) return edPause();
  if (E.t >= edTotal() - 0.05) E.t = 0;
  edShow(E.t, true);
  E.playing = true;
  E.ac?.resume();
  edVid(E.parts[E.cur].src)?.play().catch(() => edPause());
  edSyncAudio();
  edDrawPlay();
  const step = () => {
    if (!E?.playing) return;
    const p = E.parts[E.cur];
    const v = edVid(p.src);
    if (v && !v.seeking) {
      if (v.currentTime >= p.out - 0.03 || v.ended) {
        if (E.cur + 1 >= E.parts.length) { E.t = edTotal(); edPause(); edTick(); return; }
        edShow(partStart(E.parts, E.cur + 1), true);
        edVid(E.parts[E.cur].src)?.play().catch(() => {});
      } else E.t = partStart(E.parts, E.cur) + Math.max(0, v.currentTime - p.in);
      edTick(); edFollow(); edSyncAudio();
    }
    E.raf = requestAnimationFrame(step);
  };
  E.raf = requestAnimationFrame(step);
}
function edPause() {
  if (!E) return;
  E.playing = false;
  cancelAnimationFrame(E.raf);
  for (const v of $$('[data-ed-frame] video')) v.pause();
  edSyncAudio();
  edDrawPlay();
}
// Volume 0-5 on a <video> or <audio>. Over 100% needs Web Audio (an element can only be routed once, so it stays routed).
function edGain(el, vol) {
  if (vol <= 1 && !el.gain) { el.volume = vol; return; }
  try {
    E.ac ||= new AudioContext();
    if (!el.gain) { el.gain = E.ac.createGain(); E.ac.createMediaElementSource(el).connect(el.gain).connect(E.ac.destination); }
    el.volume = 1; el.gain.gain.value = vol;
  } catch { el.volume = Math.min(1, vol); }
}
// Sound clips: one <audio> each, playing only while the playhead is inside it, kept in step with the playhead.
function edSyncAudio() {
  const box = $('[data-ed-auds]');
  if (!box) return;
  for (const el of $$('audio', box)) if (!E.audio.some((a) => a.id === el.dataset.id && edSrc(a.src)?.url === el.dataset.url)) { el.pause(); el.remove(); }
  for (const a of E.audio) {
    let el = $$('audio', box).find((x) => x.dataset.id === a.id);
    const off = E.t - a.at;
    const on = E.playing && off >= 0 && off < sndLen(a);
    if (!on) { el?.pause(); continue; }
    const url = edSrc(a.src)?.url;
    if (!url) continue;
    if (!el) { el = document.createElement('audio'); Object.assign(el, { preload: 'auto', src: url }); Object.assign(el.dataset, { id: a.id, url }); box.append(el); }
    edGain(el, a.volume ?? 1);
    if (!el.seeking && (el.paused || Math.abs(el.currentTime - (a.in + off)) > 0.4)) el.currentTime = a.in + off;
    if (el.paused) el.play().catch(() => {});
  }
}
function edDrawPlay() {
  const b = $('[data-action="ed-play"]');
  if (!b) return;
  b.innerHTML = E.playing ? EI.pause : I.play;
  b.setAttribute('aria-label', E.playing ? 'Pause (Space)' : 'Play (Space)');
}

// After any change: keep marks inside the video, keep an undo step, save soon. merge: a slider, drag or typing, whose
// quick repeats are one undo step; buttons and keys are always their own step, however fast they come.
function edCommit(merge = false) {
  const total = edTotal();
  for (const m of E.marks) { m.end = r3(Math.min(m.end, total)); m.start = r3(Math.max(0, Math.min(m.start, m.end - MIN_PART))); }
  const now = edJSON();
  if (now === E.last) return;
  if (!merge || !E.snapMerge || Date.now() - E.snapAt > 700) { E.undo.push(E.last); if (E.undo.length > 100) E.undo.shift(); }
  E.snapAt = Date.now(); E.snapMerge = merge; E.last = now; E.rev++;
  clearTimeout(E.timer);
  E.timer = setTimeout(() => edSave(E), 800);
  edStatus();
}
// Saves are chained so an older save never lands after a newer one.
function edSave(e) {
  if (!e) return Promise.resolve();
  clearTimeout(e.timer);
  e.saveP = e.saveP.then(async () => {
    if (e.savedRev === e.rev) return;
    const rev = e.rev;
    try {
      await api(`/api/projects/${enc(e.slug)}/editor`, { method: 'PUT', body: { parts: e.parts, marks: e.marks, audio: e.audio } });
      e.savedRev = rev; e.saveErr = '';
    } catch (err) { e.saveErr = err.message; e.timer = setTimeout(() => edSave(e), 5000); }
  });
  if (E === e) edStatus();
  return e.saveP.then(() => { if (E === e) edStatus(); });
}
addEventListener('beforeunload', (ev) => { if (E && E.rev !== E.savedRev) { edSave(E); ev.preventDefault(); ev.returnValue = ''; } });

function edStatus() {
  const el = $('[data-ed-status]');
  if (!el || !E) return;
  el.classList.toggle('bad', Boolean(E.saveErr) && !E.busy);
  el.innerHTML = E.busy ? `<span class="live"></span> ${esc(E.busy)}`
    : E.saveErr ? `Not saved: ${esc(E.saveErr)} Trying again…`
    : E.rev !== E.savedRev ? 'Saving…' : E.rev ? 'All changes saved' : '';
  for (const b of $$('[data-action="ed-render"], [data-action="ed-auto"]')) b.disabled = !E.ready || Boolean(E.busy) || Boolean(E.pending);
}

function edDraw() { edDrawTrack(); edDrawTools(); edShow(E.t); edStatus(); }

// Re-renders keep keyboard focus on the same control.
function keepFocus(box, render) {
  const a = document.activeElement;
  const sel = box.contains(a) ? ['action', 'dir', 'panel', 'ed', 'edPart', 'edMark', 'edSnd'].filter((k) => a.dataset[k] != null)
    .map((k) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(a.dataset[k])}"]`).join('') : '';
  render();
  if (sel) $(sel, box)?.focus({ preventScroll: true });
}

// The strip under the player: play and time, the tools for what is selected (square buttons), timeline zoom.
// Zoom, Volume and Note swap the tools for one slider (or text) row with a Done button.
function edDrawTools() {
  const el = $('[data-ed-tools]');
  if (!el) return;
  const z = Math.round((Math.log(E.pps / 2) / Math.log(150)) * 100);
  const p = E.parts[E.sel], a = E.audio[E.snd], m = E.marks[E.mark];
  const target = a || p; // what Volume and Mute change
  const vol = target?.volume ?? 1;
  const tile = (action, ic, label, on = true, more = '') => `<button type="button" class="ed-tile" data-action="${action}" ${more}${on ? '' : ' disabled'}>${ic}<span>${label}</span></button>`;
  const done = `<button class="btn sm primary" data-action="ed-panel">${I.check} Done</button>`;
  let mid;
  if (E.panel === 'zoom' && p) {
    mid = `<div class="ed-slide"><span class="ed-slide-name">${EI.zoom} Zoom</span>
      <input type="range" data-ed="zoom" min="0.5" max="3" step="0.01" value="${p.zoom}" aria-label="Zoom">
      <b class="num" data-ed-val>${pct(p.zoom)}</b><span class="small muted ed-slide-hint">Drag the picture to move it.</span>
      <button class="btn sm" data-action="ed-reset">${EI.reset} Reset</button>${done}</div>`;
  } else if (E.panel === 'volume' && target) {
    mid = `<div class="ed-slide"><span class="ed-slide-name">${EI.vol} Volume</span>
      <input type="range" data-ed="volume" min="0" max="5" step="0.01" value="${vol}" aria-label="Volume">
      <b class="num" data-ed-val>${pct(vol)}</b><span class="small muted ed-slide-hint">100% is as recorded.</span>${done}</div>`;
  } else if (E.panel === 'note' && m) {
    mid = `<div class="ed-slide"><label class="ed-slide-name" for="ed-note">${EI.note} Note</label>
      <input type="text" id="ed-note" data-ed="note" maxlength="300" value="${esc(m.note)}" placeholder="What should the AI fix here? e.g. Glitch on the wall, cover it.">${done}</div>`;
  } else {
    const split = tile('ed-split', EI.split, 'Split', true, 'title="Split at the playhead (S)"');
    const del = tile('ed-delete', I.trash, 'Delete', true, 'title="Delete (Delete key)"');
    const volume = tile('ed-panel', EI.vol, 'Volume', true, 'data-panel="volume"');
    const mute = tile('ed-mute', vol ? I.soundOff : I.soundOn, vol ? 'Mute' : 'Unmute');
    const tiles = a ? [split, del, volume, mute]
      : p ? [split, del, tile('ed-panel', EI.zoom, 'Zoom', true, 'data-panel="zoom"'), tile('ed-reset', EI.reset, 'Reset position'), volume, mute,
        tile('ed-extract', EI.wave, 'Extract audio', Boolean(edSrc(p.src)?.wave), 'title="Make this part\'s sound its own clip, and mute the part"'),
        tile('ed-move', I.left, 'Move earlier', E.sel > 0, 'data-dir="-1"'), tile('ed-move', I.right, 'Move later', E.sel < E.parts.length - 1, 'data-dir="1"')]
      : m ? [tile('ed-panel', EI.note, 'Note', true, 'data-panel="note"'),
        tile('ed-fix', I.star, 'Fix with AI', !E.busy, 'title="The AI fixes only this part, the way the note says, then puts it back and saves a new version"'), del]
      : [tile('ed-add', I.film, 'Add clip', !E.pending), tile('ed-add-sound', EI.addSound, 'Add sound', !E.pending),
        tile('ed-mark', EI.mark, 'Mark a spot', true, `aria-pressed="${E.marking}" title="Draw a box on the video for the AI to fix"`), split];
    const what = a ? `Sound ${E.snd + 1}` : p ? `Part ${E.sel + 1}` : m ? `Mark ${E.mark + 1}` : '';
    mid = `<div class="ed-grid" role="group" aria-label="${what ? `Tools for ${what.toLowerCase()}` : 'Tools'}">
      ${what ? tile('ed-unselect', I.check, 'Done', true, `title="Done with ${what.toLowerCase()} (Esc)"`) : ''}${tiles.join('')}
      ${tile('ed-undo', EI.undo, 'Undo', E.undo.length > 0, 'title="Undo (Ctrl or Cmd + Z)"')}</div>`;
  }
  keepFocus(el, () => {
    el.innerHTML = `<div class="ed-transport"><button class="btn sm icon ed-play" data-action="ed-play"></button><span class="num small ed-time" data-ed-time></span></div>
      ${mid}
      <div class="ed-right">${E.pending || E.preparing ? `<span class="small ed-prep"><span class="live"></span> ${esc(E.preparing || 'Getting it ready…')}</span>` : ''}
        <label class="ed-tlzoom small">Timeline<input type="range" data-ed="tlzoom" min="0" max="100" step="1" value="${z}" aria-label="Zoom the timeline"></label></div>`;
  });
  edDrawPlay(); edTick();
}

function edDrawTrack() {
  const tr = $('[data-ed-track]');
  if (!tr) return;
  const pps = E.pps, total = edTotal();
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 64) || 600;
  let ruler = '';
  for (let s = 0; s <= total + step; s += step) ruler += `<span style="left:${s * pps}px">${step < 1 ? fmtClock(s) : fmtDur(s) || '0:00'}</span>`;
  let x = 0;
  const parts = E.parts.map((p, i) => {
    const s = edSrc(p.src) || {};
    const w = partLen(p) * pps;
    const bg = s.strip ? `background-image:url(${esc(JSON.stringify(s.strip))});background-size:${(E.frames[p.src] || s.duration) * pps}px 100%;background-position:${-p.in * pps}px 0;` : '';
    const html = `<button type="button" class="ed-part" data-ed-part="${i}" aria-pressed="${i === E.sel}" style="left:${x}px;width:${w}px;${bg}"
      aria-label="Part ${i + 1} of ${E.parts.length}: ${esc(s.label || 'clip')}, ${partLen(p).toFixed(1)} seconds${p.zoom !== 1 ? `, zoom ${Math.round(p.zoom * 100)}%` : ''}">
      ${s.wave ? `<span class="ed-pwave" style="${edWave(s, p.in)}"></span>` : ''}
      <span class="ed-lbl">${(p.volume ?? 1) === 0 ? I.soundOff : ''}${esc(s.label || '')} <b class="num">${partLen(p).toFixed(1)}s</b>${(p.volume ?? 1) !== 1 ? ` <b class="num">${pct(p.volume)}</b>` : ''}</span><span class="ed-trim l" data-trim="in"></span><span class="ed-trim r" data-trim="out"></span></button>`;
    x += w;
    return html;
  }).join('');
  const rows = soundRows(E.audio);
  const sounds = E.audio.map((a, i) => {
    const s = edSrc(a.src) || {};
    return `<button type="button" class="ed-snd" data-ed-snd="${i}" aria-pressed="${i === E.snd}" style="left:${a.at * pps}px;width:${sndLen(a) * pps}px;top:${rows[i] * 38}px;${s.wave ? edWave(s, a.in) : ''}"
      aria-label="Sound ${i + 1}: ${esc(s.label || 'sound')}, from ${fmtClock(a.at)}, ${sndLen(a).toFixed(1)} seconds, volume ${pct(a.volume)}">
      <span class="ed-lbl">${a.volume === 0 ? I.soundOff : ''}${esc(s.label || '')}${(a.volume ?? 1) !== 1 ? ` <b class="num">${pct(a.volume)}</b>` : ''}</span><span class="ed-trim l" data-trim="in"></span><span class="ed-trim r" data-trim="out"></span></button>`;
  }).join('');
  const end = Math.max(total, ...E.audio.map((a) => a.at + sndLen(a)));
  const marks = E.marks.map((m, i) => `<button type="button" class="ed-mark" data-ed-mark="${i}" aria-pressed="${i === E.mark}" style="left:${m.start * pps}px;width:${(m.end - m.start) * pps}px"
    aria-label="Mark ${i + 1}, ${fmtClock(m.start)} to ${fmtClock(m.end)}: ${esc(m.note || 'no note yet')}"><span class="ed-lbl">${i + 1}. ${esc(m.note || 'Add a note')}</span><span class="ed-trim l" data-trim="start"></span><span class="ed-trim r" data-trim="end"></span></button>`).join('');
  keepFocus(tr, () => {
    tr.style.width = `${end * pps + 240}px`;
    tr.innerHTML = `<div class="ed-ruler" data-ed-seek aria-hidden="true">${ruler}</div>
      <div class="ed-lane ed-marks" data-ed-seek>${marks || '<span class="ed-empty">Marks for the AI show here. Use Mark a spot.</span>'}</div>
      <div class="ed-lane ed-parts" data-ed-seek>${parts}</div>
      <div class="ed-lane ed-sounds" data-ed-seek style="height:${(Math.max(0, ...rows) + 1) * 38}px">${sounds || '<span class="ed-empty">Sounds show here. Use Add sound, or Extract audio on a part.</span>'}</div>
      <div class="ed-drop" data-ed-drop hidden></div><div class="ed-head" data-ed-head aria-hidden="true"><i></i></div>`;
  });
  edTick();
}

// The waveform of a source drawn so its time lines up with the timeline, starting at second `from` of the source.
const edWave = (s, from) => `background-image:url(${esc(JSON.stringify(s.wave))});background-size:${s.duration * E.pps}px 100%;background-position:${-from * E.pps}px 0;`;

// Selects a part, mark or sound clip ('part' | 'mark' | 'snd', or null for nothing) without re-rendering the block under the pointer.
function edSelect(kind, i) {
  Object.assign(E, { sel: kind === 'part' ? i : -1, mark: kind === 'mark' ? i : -1, snd: kind === 'snd' ? i : -1, panel: null });
  for (const b of $$('[data-ed-part], [data-ed-mark], [data-ed-snd]')) {
    const [n, cur] = 'edPart' in b.dataset ? [b.dataset.edPart, E.sel] : 'edMark' in b.dataset ? [b.dataset.edMark, E.mark] : [b.dataset.edSnd, E.snd];
    b.setAttribute('aria-pressed', String(Number(n) === cur));
  }
  edDrawTools();
}
const edBlock = (b) => ('edMark' in b.dataset ? ['mark', Number(b.dataset.edMark)] : 'edSnd' in b.dataset ? ['snd', Number(b.dataset.edSnd)] : ['part', Number(b.dataset.edPart)]);

// Zoom for part i (the selected one, else the one on screen); it is selected and shown.
function edZoom(z, i = E.sel >= 0 ? E.sel : E.cur) {
  const p = E.parts[i];
  if (!p) return;
  if (E.sel !== i) edSelect('part', i);
  if (E.cur !== i) edShow(partStart(E.parts, i));
  p.zoom = Math.round(Math.min(3, Math.max(0.5, z)) * 100) / 100;
  const g = place(p, edSrc(p.src), E.W, E.H);
  p.x = r3(g.x); p.y = r3(g.y); // store what is shown, so the saved video matches
  edPlace(edVid(p.src), p);
  const r = $('[data-ed="zoom"]');
  if (r && document.activeElement !== r) r.value = p.zoom;
  if (E.panel === 'zoom') $('[data-ed-val]').textContent = pct(p.zoom);
  edCommit(true);
}
// Volume of the selected sound clip or part, 0-5.
function edVolume(v) {
  const t = E.audio[E.snd] || E.parts[E.sel];
  if (!t) return;
  t.volume = Math.round(Math.min(5, Math.max(0, v)) * 100) / 100;
  const val = $('[data-ed-val]');
  if (val) val.textContent = pct(t.volume);
  const p = E.parts[E.cur], vid = p && edVid(p.src);
  if (vid) edGain(vid, p.volume ?? 1);
  edSyncAudio(); edCommit(true); edDrawTrack();
}

function edAddMark(box) {
  if (E.marks.length >= 50) return toast('You can add up to 50 marks.');
  const total = edTotal();
  const start = Math.max(0, Math.min(E.t, total - 2));
  E.marks.push({ start: r3(start), end: r3(Math.min(total, start + 2)), box, note: '' });
  E.marking = false;
  edSelect('mark', E.marks.length - 1);
  E.panel = 'note';
  edMarking(false); edCommit(); edDraw();
  $('[data-ed="note"]')?.focus();
}
function edMarking(on) {
  E.marking = on;
  if (on) edPause();
  $('[data-ed-hint]').hidden = !on;
  $('[data-ed-frame]').classList.toggle('marking', on);
  edDrawTools();
}

// Pointer drags listen on the window, so re-rendering the dragged element mid-drag is fine.
function edDrag(e, move, up) {
  const x0 = e.clientX, y0 = e.clientY;
  const mv = (ev) => move(ev.clientX - x0, ev.clientY - y0, ev);
  const end = (ev) => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
    up?.(ev.type === 'pointercancel', ev);
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', end); addEventListener('pointercancel', end);
}

document.addEventListener('pointerdown', (e) => {
  if (!E?.ready || e.button > 0 || !e.target.closest) return;
  const frame = e.target.closest('[data-ed-frame]');
  const block = e.target.closest('[data-ed-part], [data-ed-mark], [data-ed-snd]');
  const tr = $('[data-ed-track]');
  const timeAt = (cx) => Math.max(0, Math.min(edTotal(), (cx - tr.getBoundingClientRect().left) / E.pps));
  if (frame && E.marking) {
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    const at = (ev) => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
    const [x0, y0] = at(e);
    const draw = $('[data-ed-draw]');
    let box = null;
    edDrag(e, (dx, dy, ev) => {
      const [x1, y1] = at(ev);
      box = { x: r3(Math.min(x0, x1)), y: r3(Math.min(y0, y1)), w: r3(Math.abs(x1 - x0)), h: r3(Math.abs(y1 - y0)) };
      Object.assign(draw.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
      draw.hidden = false;
    }, (cancel) => {
      draw.hidden = true;
      if (!cancel && box && box.w > 0.02 && box.h > 0.02) edAddMark(box);
    });
  } else if (frame) {
    const p = E.parts[E.cur];
    if (!p) return;
    e.preventDefault();
    if (E.sel !== E.cur) edSelect('part', E.cur);
    const r = frame.getBoundingClientRect();
    const g0 = place(p, edSrc(p.src), E.W, E.H);
    edDrag(e, (dx, dy) => {
      const g = place({ ...p, x: g0.x - dx / (r.width * g0.w), y: g0.y - dy / (r.height * g0.h) }, edSrc(p.src), E.W, E.H);
      p.x = Math.round(g.x * 1e4) / 1e4; p.y = Math.round(g.y * 1e4) / 1e4;
      edPlace(edVid(p.src), p);
      edCommit(true);
    });
  } else if (block) {
    const [kind, i] = edBlock(block);
    const trim = e.target.closest('[data-trim]')?.dataset.trim;
    const orig = { ...{ mark: E.marks, snd: E.audio, part: E.parts }[kind][i] };
    const clickT = timeAt(e.clientX);
    let moved = false;
    edPause();
    edSelect(kind, i);
    edDrag(e, (dx) => {
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      const d = dx / E.pps;
      if (kind === 'mark') {
        const m = E.marks[i], total = edTotal(), len = orig.end - orig.start;
        if (trim === 'start') m.start = r3(Math.min(Math.max(0, orig.start + d), m.end - MIN_PART));
        else if (trim === 'end') m.end = r3(Math.max(Math.min(total, orig.end + d), m.start + MIN_PART));
        else { m.start = r3(Math.min(Math.max(0, orig.start + d), total - len)); m.end = r3(m.start + len); }
        edCommit(true); edDrawTrack(); edShow(trim === 'end' ? m.end - 0.01 : m.start);
      } else if (kind === 'snd') {
        // Sound clips move freely along the time; they may overlap other sounds.
        const a = E.audio[i];
        if (trim) trimSound(a, trim, d, orig, edSrc(a.src).duration); else a.at = r3(Math.max(0, orig.at + d));
        edCommit(true); edDrawTrack(); edShow(trim === 'out' ? a.at + sndLen(a) - 0.01 : a.at);
      } else if (trim) {
        const p = E.parts[i];
        trimPart(p, trim, orig[trim] + d, edSrc(p.src).duration);
        edCommit(true); edDrawTrack();
        edShow(partStart(E.parts, i) + (trim === 'in' ? 0 : partLen(p) - 0.01));
      } else {
        // Reorder: the block floats with the pointer and a line shows where it lands.
        $(`[data-ed-part="${i}"]`)?.classList.add('dragging');
        $(`[data-ed-part="${i}"]`)?.style.setProperty('transform', `translateX(${dx}px)`);
        const mid = partStart(E.parts, i) + partLen(orig) / 2 + d;
        const others = E.parts.filter((_, j) => j !== i);
        E.dropTo = others.filter((p, j) => partStart(others, j) + partLen(p) / 2 < mid).length;
        const line = $('[data-ed-drop]');
        line.hidden = false;
        line.style.left = `${totalLen(others.slice(0, E.dropTo)) * E.pps}px`;
      }
    }, (cancel) => {
      if (!moved) {
        if (!cancel) edShow(kind === 'mark' ? E.marks[i].start : kind === 'snd' ? clickT : Math.min(Math.max(clickT, partStart(E.parts, i)), partStart(E.parts, i) + partLen(E.parts[i]) - 0.01));
        return;
      }
      if (kind === 'part' && !trim && !cancel && E.dropTo !== i) { movePart(E.parts, i, E.dropTo); E.sel = E.dropTo; E.t = partStart(E.parts, E.sel); edCommit(); }
      edDraw();
    });
  } else if (e.target.closest('[data-ed-seek]')) {
    edPause();
    if (E.sel >= 0 || E.mark >= 0 || E.snd >= 0) edSelect(null, -1);
    edShow(timeAt(e.clientX));
    edDrag(e, (dx, dy, ev) => { edShow(timeAt(ev.clientX)); });
  }
});

document.addEventListener('wheel', (e) => {
  if (!E?.ready || E.marking || !e.target.closest?.('[data-ed-frame]')) return;
  e.preventDefault();
  edZoom((E.parts[E.cur]?.zoom || 1) * Math.exp(-e.deltaY * 0.0015), E.cur);
}, { passive: false });

document.addEventListener('input', (e) => {
  const k = E?.ready && e.target.dataset?.ed;
  if (!k) return;
  if (k === 'zoom') edZoom(Number(e.target.value));
  if (k === 'volume') edVolume(Number(e.target.value));
  if (k === 'note' && E.marks[E.mark]) { E.marks[E.mark].note = e.target.value.slice(0, 300); edCommit(true); edDrawTrack(); }
  if (k === 'tlzoom') { E.pps = 2 * 150 ** (Number(e.target.value) / 100); edDrawTrack(); edFollow(); }
});

document.addEventListener('keydown', (e) => {
  if (!E?.ready || $('dialog[open]')) return;
  const k = e.key;
  if (k === 'Escape' && E.panel) { e.preventDefault(); ACTIONS['ed-panel']({}); return; }
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); ACTIONS['ed-undo'](); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const block = e.target.closest?.('[data-ed-part], [data-ed-mark], [data-ed-snd]');
  if (k === 'Enter' && block) {
    e.preventDefault();
    const [kind, i] = edBlock(block);
    edPause(); edSelect(kind, i);
    edShow(kind === 'mark' ? E.marks[i].start : kind === 'snd' ? Math.min(E.audio[i].at, edTotal()) : partStart(E.parts, i));
  } else if (k === ' ') { e.preventDefault(); edPlay(); }
  else if (k === 's' || k === 'S') ACTIONS['ed-split']();
  else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); ACTIONS['ed-delete'](); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault(); edPause();
    edShow(Math.min(edTotal(), Math.max(0, E.t + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)))); edFollow();
  } else if (k === 'Escape') { if (E.marking) edMarking(false); else edSelect(null, -1); }
});

// Renders the edit list to the next version. Returns its file name.
async function edRenderNow() {
  const e = E;
  e.busy = 'Making your video… usually under a minute'; edStatus();
  try {
    await edSave(e);
    if (e.saveErr) throw new Error(`Your changes could not be saved: ${e.saveErr}`);
    const r = await api(`/api/projects/${enc(e.slug)}/editor/render`, { body: {} });
    e.rendered = { file: r.file, rev: e.rev };
    S.sel[e.slug] = r.file;
    return r.file;
  } finally { e.busy = ''; if (E === e) edStatus(); }
}

function edClipDialog() {
  const vids = S.state.inbox.filter((f) => f.kind === 'video');
  const m = $('#modal');
  m.innerHTML = `<div class="inner">
    <div class="top"><div><h2 id="modal-title">Add a clip</h2><p class="muted" style="margin-top:4px">It goes in at the playhead (<span class="num">${fmtClock(E.t)}</span>). Drag it on the timeline to move it after.</p></div>
      <button class="btn quiet icon" type="button" data-action="close-modal" aria-label="Close">${I.x}</button></div>
    ${vids.length ? `<div class="import-grid">${vids.map((f) => `<button type="button" class="import-clip" data-action="ed-add-inbox" data-path="${esc(f.path)}">
      <span class="ic-thumb"><img src="${clipThumb(f)}" alt="" loading="lazy" decoding="async"></span>
      <span class="nm" title="${esc(f.name)}">${esc(f.folder ? `${f.folder} / ${f.name}` : f.name)}</span>${f.duration ? `<span class="len">${fmtDur(f.duration)}</span>` : ''}</button>`).join('')}</div>`
      : '<div class="empty">No clips in your inbox yet.</div>'}
    <div class="row spread foot"><span class="muted small">Or pick a video on this computer.</span><button class="btn" type="button" data-action="ed-upload">${I.up} Upload a clip</button></div>
  </div>`;
  m.showModal();
}
function edSoundDialog() {
  const row = (f) => `<li><button type="button" class="btn quiet sm icon" data-action="ed-sound-play" data-path="${esc(f.path)}" aria-pressed="false" aria-label="Listen to ${esc(f.name)}">${I.play}</button>
    <span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="muted small num">${fmtDur(f.duration)}</span>
    <button type="button" class="btn sm" data-action="ed-sound-pick" data-path="${esc(f.path)}">${I.plus} Add</button></li>`;
  const group = (kind, title) => { const g = E.sounds.filter((f) => f.kind === kind); return g.length ? `<div><h3 class="sub">${title}</h3><ul class="ed-sound-list">${g.map(row).join('')}</ul></div>` : ''; };
  const m = $('#modal');
  m.innerHTML = `<div class="inner">
    <div class="top"><div><h2 id="modal-title">Add a sound</h2><p class="muted" style="margin-top:4px">It goes under the video at the playhead (<span class="num">${fmtClock(E.t)}</span>). Drag it on the timeline to move it after.</p></div>
      <button class="btn quiet icon" type="button" data-action="close-modal" aria-label="Close">${I.x}</button></div>
    ${E.sounds.length ? group('music', 'Music') + group('sfx', 'Sound effects') : '<div class="empty">No music or sound effects yet. Add some in My brand, or upload one here.</div>'}
    <div class="row spread foot"><span class="muted small">Or pick a sound file on this computer.</span><button class="btn" type="button" data-action="ed-sound-upload">${I.up} Upload a sound</button></div>
  </div>`;
  m.showModal();
}
$('#modal').addEventListener('close', () => edPreview.pause());
// Opens the file picker for a video clip ('part') or a sound file ('sound').
function edPick(kind) {
  $('#modal').close();
  E.pickKind = kind;
  const p = $('#clip-picker');
  p.accept = kind === 'sound' ? 'audio/*,.mp3,.wav,.m4a,.aac' : 'video/*,.mov,.mp4,.m4v';
  p.click();
}
// While a clip or sound is being added, show the server's "getting ready" text and keep the Add buttons off.
function edWaitClip(e, kind = 'part') { e.pending = { id: null, kind }; edDrawTools(); edStatus(); edLoad(); }
function edAdded(e, r, at) {
  const s = r.source || r;
  if (!s?.id) { e.pending = null; return toast('It could not be added. Try again.', { bad: true }); }
  e.pending = { ...e.pending, id: s.id, t: at };
  if (E === e) { edDrawTools(); edStatus(); edLoad(); }
}
$('#clip-picker').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  const e = E;
  if (!file || !e) return;
  const at = e.t;
  edWaitClip(e, e.pickKind);
  const r = await sendFile(`/api/projects/${enc(e.slug)}/editor/source?name=${enc(file.name)}`, file, 'Adding');
  if (r.error) { e.pending = null; if (E === e) { edDrawTools(); edStatus(); } return toast(r.error, { bad: true, ms: 9000 }); }
  edAdded(e, r, at);
});

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

const colorRow = (c = { label: '', hex: '#000000' }) => `<div class="line color-row">
  <input type="color" name="hex" value="${esc(c.hex)}" aria-label="Color">
  <input type="text" name="label" value="${esc(c.label)}" placeholder="e.g. Main gold, Text white" maxlength="40" aria-label="What this color is for">
  <button type="button" class="btn quiet icon" data-action="remove-line" aria-label="Remove this color">${I.x}</button></div>`;
const ANGLES = [[180, 'Top to bottom'], [90, 'Left to right'], [135, 'Diagonal ↘'], [45, 'Diagonal ↗']];
const gradientRow = (g = { label: '', from: '#000000', to: '#ffffff', angle: 180 }) => `<div class="line gradient-row">
  <span class="swatch" style="background:linear-gradient(${Number(g.angle)}deg, ${esc(g.from)}, ${esc(g.to)})" aria-hidden="true"></span>
  <input type="color" name="from" value="${esc(g.from)}" aria-label="Start color">
  <input type="color" name="to" value="${esc(g.to)}" aria-label="End color">
  <select name="angle" aria-label="Direction">${ANGLES.map(([v, l]) => `<option value="${v}" ${Number(g.angle) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <input type="text" name="label" value="${esc(g.label)}" placeholder="e.g. Caption bars" maxlength="40" aria-label="What this gradient is for">
  <button type="button" class="btn quiet icon" data-action="remove-line" aria-label="Remove this gradient">${I.x}</button></div>`;

VIEWS.brand = {
  layout: () => `
    <div class="page-head"><div><h1>My brand</h1><p>The things every video for your brand uses. Add them once and the editor picks them up on every edit.</p></div><div data-region="packTag"></div></div>
    <div data-region="needs"></div>
    <div class="slots"><section class="panel" data-region="logo"></section><section class="panel" data-region="social"></section></div>
    <section class="section" id="brand-look">
      <div class="section-head"><div><h2>Brand look</h2><p class="muted small">Your colors stay the same on every branded video. Fonts come from your shelf, so each style can still feel different. Use “Make a branded copy” on a learned style to put them on it.</p></div></div>
      <div class="contact-grid"><section class="panel" data-region="look"></section><section class="panel" data-region="fonts"></section></div>
      <section class="panel about" data-region="about"></section>
    </section>
    <section class="section" id="brand-details">
      <div class="section-head"><div><h2>Contact part</h2><p class="muted small">The end of each video shows either the brand contact (for all sales) or one sales person. You choose when you start a video.</p></div></div>
      <div class="contact-grid"><section class="panel" data-region="bcontact"></section><section class="panel" data-region="people" id="brand-people"></section></div>
    </section>
    <section class="section" data-region="broll"></section>
    <section class="section" data-region="images"></section>
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
    look: () => {
      const l = S.state.brand.look;
      return `<h2 class="sub">${I.style} Colors and feel</h2>
        <form class="details" data-form="look" autocomplete="off">
          <div class="field"><span>Colors <span class="hint">(say what each is for)</span></span><div class="lines" data-lines="color">${(l.colors.length ? l.colors : [{ label: '', hex: '#000000' }]).map(colorRow).join('')}</div>
            <button type="button" class="btn quiet sm" data-action="add-row" data-kind="color">${I.plus} Add a color</button></div>
          <div class="field"><span>Gradients <span class="hint">(optional, for caption bars and cards)</span></span><div class="lines" data-lines="gradient">${l.gradients.map(gradientRow).join('')}</div>
            <button type="button" class="btn quiet sm" data-action="add-row" data-kind="gradient">${I.plus} Add a gradient</button></div>
          <label class="field"><span>The feel</span><textarea name="feel" rows="3" maxlength="2000" placeholder="e.g. Premium but friendly. Clean, lots of space. No cartoon stickers.">${esc(l.feel)}</textarea></label>
          <div class="row spread"><span></span><button class="btn primary" type="submit">Save colors and feel</button></div>
        </form>`;
    },
    fonts: () => {
      const fonts = S.state.brand.look.fonts;
      const face = (f, i) => `@font-face{font-family:"shelf-${i}";src:url("/media/brand/fonts/${enc(f.name)}?t=${Math.round(f.mtime)}");font-display:swap}`;
      return `<div class="slot-head"><h2 class="sub">${I.text} Font shelf</h2></div>
        <p class="muted small">Add 3 to 6 fonts you are happy to use, and give each a mood. Each style picks the one closest to its own feel. Write “Always” for a font every video must use.</p>
        ${fonts.length ? `<style>${fonts.map(face).join('')}</style>
        <form class="details" data-form="fonts" autocomplete="off"><ul class="font-shelf">${fonts.map((f, i) => `<li>
          <span class="font-sample" style="font-family:'shelf-${i}',sans-serif" aria-hidden="true">Aa Bb 123</span>
          <span class="who"><small>${esc(f.name)}</small><input type="text" name="mood" data-file="${esc(f.name)}" value="${esc(f.mood)}" placeholder="Mood, e.g. Big bold, Clean, Always" maxlength="40" aria-label="Mood for ${esc(f.name)}"></span>
          ${delBtn([{ area: 'font', path: f.name }], `the font ${f.name}`, { cls: 'btn quiet icon sm danger' })}</li>`).join('')}</ul>
          <div class="row spread"><button type="button" class="btn sm" data-action="brand-pick" data-slot="font">${I.up} Add fonts</button><button class="btn primary" type="submit">Save moods</button></div></form>`
        : `<div class="row"><button type="button" class="btn sm" data-action="brand-pick" data-slot="font">${I.up} Add fonts</button><span class="muted small">TTF, OTF, WOFF or WOFF2 files</span></div>`}`;
    },
    about: () => `<h2 class="sub">${I.brand} About the company</h2>
      <p class="muted small">Helps the editor write hook text, pick which words to highlight, word the ending, choose B-roll and spell names right. It never changes what you say in your recording.</p>
      <form class="details" data-form="about" autocomplete="off">
        <textarea name="about" rows="6" maxlength="6000" aria-label="About the company" placeholder="What you sell, who buys, where you are, what makes you different, your tagline, words to use or avoid. e.g. Used and brand-new cars in Cebu, 20 years. Families and first-time buyers. Tagline: …">${esc(S.state.brand.look.about)}</textarea>
        <div class="row spread"><span></span><button class="btn primary" type="submit">Save about the company</button></div>
      </form>`,
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
          <label class="field"><span>Facebook page <span class="hint">(optional, shown at the end of their videos)</span></span><input type="text" name="fb" value="${esc(p.fb || '')}" placeholder="Page name as it should show, e.g. Jhay Gold Aces Cars" maxlength="200"></label>
          <fieldset class="field pron"><legend>The editor calls them</legend><div class="seg" role="group">${['she', 'he'].map((v) => `<label><input type="radio" name="pronoun" value="${v}" ${(p.pronoun || 'she') === v ? 'checked' : ''}><span>${v === 'she' ? 'She / her' : 'He / him'}</span></label>`).join('')}</div></fieldset>
          <div class="field"><span>Numbers and other lines</span><div class="lines" data-lines>${(p.lines?.length ? p.lines : [{ label: '', value: '' }, { label: '', value: '' }]).map(lineRow).join('')}</div></div>
          <div class="row spread"><button type="button" class="btn quiet sm" data-action="add-line">${I.plus} Add a line</button>
            <div class="row"><button type="button" class="btn quiet" data-action="person-cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></div>
        </form>`;
      return `<div class="slot-head"><h2 class="sub">${I.id} Sales people</h2><span class="muted small private">${I.lock} On this computer</span></div>
        <p class="muted small">For a video about one person: “Look for MISS JHAY” and their own numbers.</p>
        ${people.length ? `<ul class="people">${people.map((p) => editing === p.id ? `<li class="editing">${form(p)}</li>` : `<li>
            <span class="avatar" aria-hidden="true">${esc((p.name || '?').charAt(0))}</span>
            <span class="who"><b>${esc(p.onScreen)}</b><small>${esc(pron[p.pronoun])}${p.lines.length ? ` · ${p.lines.map((l) => esc(l.label)).join(' · ')}` : ' · no numbers'}${p.fb ? ' · Facebook' : ''}</small></span>
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
    images: () => {
      const imgs = S.state.brand.images || [];
      const tile = (x) => `<figure class="reel-tile"><img src="/media/brand/images/${enc(x.name)}?t=${Math.round(x.mtime)}" alt="${esc(x.name)}" loading="lazy" decoding="async">
        ${delBtn([{ area: 'images', path: x.name }], `the picture ${x.name}`, { cls: 'del' })}</figure>`;
      return `<div class="section-head" id="brand-images"><div><h2>Pictures</h2><p class="muted small">Logos, badges, product shots and other images. Pick the ones you want when you start a video.</p></div>
          <div class="row"><span class="muted small">${imgs.length ? `${plural(imgs.length, 'picture')} · ${fmtSize(S.state.brand.sizes.images)}` : 'No pictures yet'}</span>
          ${imgs.length > 1 ? delBtn(imgs.map((x) => ({ area: 'images', path: x.name })), `all ${plural(imgs.length, 'picture')}`, { label: 'Delete all' }) : ''}
          <button class="btn sm" data-action="brand-pick" data-slot="image">${I.up} Add pictures</button></div></div>
        ${imgs.length ? `<div class="reel">${imgs.map(tile).join('')}</div>` : '<div class="empty">No pictures yet.</div>'}`;
    },
    music: () => {
      const sounds = S.state.sounds;
      return `<div class="section-head" id="brand-music"><div><h2>Music and sound effects</h2><p class="muted small">Only add sounds you have the right to use. Without any, the editor makes simple effects itself.</p></div>
          <div class="row">${sounds.length > 1 ? delBtn(sounds.map((f) => ({ area: 'sounds', path: f.folder ? `${f.folder}/${f.name}` : f.name })), `all ${plural(sounds.length, 'sound')}`, { label: 'Delete all' }) : ''}
          <button class="btn sm" data-action="pick-sound">${I.up} Add music or sounds</button></div></div>
        ${sounds.length ? `<div class="extras">${sounds.map((f) => `<span class="chip-del"><button class="chip" data-action="reveal" data-area="sounds" data-name="${esc(f.name)}" data-folder="${esc(f.folder || '')}">${I.music}${esc(f.folder ? `${f.folder} / ` : '')}${esc(f.name)}</button>${delBtn([{ area: 'sounds', path: f.folder ? `${f.folder}/${f.name}` : f.name }], f.name, { cls: 'btn quiet icon sm' })}</span>`).join('')}</div>` : '<div class="empty">No music yet.</div>'}
        ${sfxSummary()}`;
    },
    share: () => {
      const b = S.state.brand;
      const music = S.state.sounds.filter((f) => f.kind === 'audio').length;
      const learned = S.state.styles.filter((x) => x.ready).length;
      if (!S.state.setup.style) return `<h2 class="sub">${I.share} Share with your team</h2><p class="muted small">Set your style first. Then you can send it to teammates as one file.</p>`;
      return `<h2 class="sub">${I.share} Share with your team</h2>
        <p class="muted small">Makes one file with your style, rules, logo, screenshot and brand contact. Teammates import it, and their videos look like yours.</p>
        <form class="pack-form" data-form="export">
          <label class="field"><span>Brand name</span><input type="text" name="name" value="${esc(b.pack?.name || '')}" placeholder="e.g. Gold Aces" maxlength="60" required></label>
          <label class="tick"><input type="checkbox" name="broll" ${b.broll.length ? 'checked' : 'disabled'}>Include B-roll<small>${b.broll.length ? fmtSize(b.sizes.broll) : 'none yet'}</small></label>
          <label class="tick"><input type="checkbox" name="music" ${music ? '' : 'disabled'}>Include music<small>${music ? fmtSize(b.sizes.music) : 'none yet'}</small></label>
          <label class="tick"><input type="checkbox" name="images" ${b.images.length ? 'checked' : 'disabled'}>Include pictures<small>${b.images.length ? fmtSize(b.sizes.images) : 'none yet'}</small></label>
          <label class="tick"><input type="checkbox" name="styles" ${learned ? 'checked' : 'disabled'}>Include learned styles<small>${learned ? plural(learned, 'style') : 'none yet'}</small></label>
          <label class="tick"><input type="checkbox" name="people" ${b.people.length ? '' : 'disabled'}>Include sales people<small>${b.people.length ? `${b.people.length} with their numbers` : 'none yet'}</small></label>
          <button class="btn primary" type="submit">${I.pack} Make brand pack</button>
        </form>`;
    },
    import: () => {
      const p = S.state.brand.pack;
      return `<h2 class="sub">${I.importIco} ${p ? 'Your brand pack' : 'Got a brand pack?'}</h2>
        <p class="muted small">${p
          ? `Using “${esc(p.name)}” since ${new Date(p.importedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. When your team sends a newer one, import it here.`
          : 'Import the .brandpack file from your team. It sets your style, logo, screenshot, brand contact and B-roll, and adds the team’s pictures and learned styles. Your own rules and sales people stay.'}</p>
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

async function loadLearned(id) {
  try {
    const d = await api(`/api/styles/${enc(id)}`);
    S.docs.learned = { id, ...d };
    regionCache.clear(); refresh();
  } catch (e) { fail(e); }
}

const styleOf = (id) => S.state.styles.find((x) => x.id === id);
const mainStyleName = () => S.state.settings.mainStyleName || (S.state.brand.pack ? S.state.brand.pack.name : 'My style');
// A style's name as a page title, with a pencil to rename it in place. id is 'main' or a learned style's id.
const styleTitle = (id, name, canRename = true) => (S.renamingStyle
  ? `<form class="rename" data-form="rename-style" data-id="${esc(id)}"><label class="sr" for="rename-style">Style name</label>
      <input type="text" id="rename-style" value="${esc(name)}" maxlength="60" autocomplete="off">
      <button class="btn primary" type="submit">Save name</button><button class="btn quiet" type="button" data-action="rename-style-cancel">Cancel</button></form>`
  : `<div class="title"><h1>${esc(name)}</h1>${canRename ? `<button class="btn quiet sm icon" data-action="rename-style" aria-label="Rename this style" title="Rename">${I.edit}</button>` : ''}</div>`);
const renameCardBtn = (id, name) => `<button class="btn quiet sm icon" data-action="rename-style-go" data-id="${esc(id)}" aria-label="Rename ${esc(name)}" title="Rename">${I.edit}</button>`;
const learningNow = (st) => S.job?.kind === 'learn' && S.job.styleId === st.id;
const learnQueued = (st) => S.state.queue.some((q) => q.type === 'learn' && q.styleId === st.id);
const frameSrc = (st, f) => `/media/styles/${enc(st.id)}/${enc(f.file)}?t=${Math.round(f.mtime)}`;
const atLabel = (f) => (f.at === null ? '' : fmtDur(f.at) || '0:00');

// #/style lists every style, #/style/main is the main style (my-style.md), #/style/<id> a learned one.
VIEWS.style = {
  enter: (id) => {
    S.styleMode = 'read';
    S.renamingStyle = S.focusRenameStyle = Boolean(id) && S.renameOnEnter === id;
    S.renameOnEnter = null;
    if (id === 'main') { S.docs.style = undefined; loadDoc('style'); } else if (id) { S.docs.learned = undefined; loadLearned(id); }
  },
  layout: (id) => (!id ? `
    <div class="page-head"><div><h1>My styles</h1><p>Each style is a way your videos can look. You pick one every time you start a video.</p></div></div>
    <section class="section" data-region="slist"></section>
    <section class="panel learn" data-region="learn"></section>`
    : id === 'main' ? `<a class="back" href="#/style">${I.left} My styles</a><div data-region="body"></div>`
    : `<a class="back" href="#/style">${I.left} My styles</a>
    <div data-region="lhead"></div>
    <div data-region="lstatus"></div>
    <section class="section" data-region="board"></section>
    <div data-region="ldoc"></div>`),
  regions: {
    slist: () => {
      const pack = S.state.brand.pack;
      const has = S.state.setup.style;
      const main = `<article class="card"><a class="cover" href="#/style/main" aria-label="Open your main style"><span class="thumb style-cover">${I.style}${pack ? `<span class="tape sm">From ${esc(pack.name)}</span>` : ''}</span></a>
        <div class="body"><div><div class="name" title="${esc(mainStyleName())}">${esc(mainStyleName())}</div><div class="meta">${has ? 'Main style' : 'Not set yet'}</div></div>
        <div class="row"><a class="btn sm" href="#/style/main">${has ? 'Open' : 'Set it up'}</a>${has ? renameCardBtn('main', mainStyleName()) : ''}</div></div></article>`;
      const card = (st) => {
        const cover = st.frames[0];
        const tape = learningNow(st) ? '<span class="tape rec sm">Learning…</span>' : learnQueued(st) ? '<span class="tape pale sm">In line</span>'
          : st.ready ? '' : '<span class="tape pale sm">Not finished</span>';
        return `<article class="card"><a class="cover" href="#/style/${enc(st.id)}" aria-label="Open the style ${esc(st.name)}"><span class="thumb style-cover">${cover ? `<img src="${frameSrc(st, cover)}" alt="" loading="lazy" decoding="async">` : I.film}${tape}</span></a>
          <div class="body"><div><div class="name" title="${esc(st.name)}">${esc(st.name)}</div><div class="meta">${st.ready ? `${plural(st.frames.length, 'frame')} · ` : ''}learned ${ago(st.createdAt)}</div></div>
          <div class="row"><a class="btn sm" href="#/style/${enc(st.id)}">Open</a>${learningNow(st) || learnQueued(st) ? '' : renameCardBtn(st.id, st.name)}</div></div>
          ${learningNow(st) || learnQueued(st) ? '' : delBtn([{ area: 'style', path: st.id }], `the style “${st.name}”`, { cls: 'card-del' })}</article>`;
      };
      return `<div class="grid">${main}${S.state.styles.map(card).join('')}</div>`;
    },
    learn: () => `<h2 class="sub">${I.star} Learn a style from a video</h2>
      <p class="muted small">Upload a video edited the way you like. The editor studies every detail of the edit (captions, cuts, graphics, color and sound), writes it down as a new style, and keeps a storyboard of frames that show how your videos should look. It takes a few minutes. If the editor is busy, it waits in line.</p>
      <form class="row learn-form" data-form="learn" autocomplete="off">
        <label class="field"><span>Name this style</span><input type="text" id="learn-name" maxlength="60" placeholder="e.g. Fast promo, Calm testimonial" required></label>
        <button class="btn primary" type="submit">${I.up} Choose the video</button>
      </form>`,
    lhead: (id) => {
      const st = styleOf(id);
      if (!st) return '<div class="page-head"><div><h1>Not found</h1><p>This style is not here anymore. <a href="#/style">Back to My styles</a></p></div></div>';
      const busyHere = learningNow(st) || learnQueued(st) || (S.job?.kind === 'style' && S.job.styleId === st.id);
      return `<div class="page-head folder-head"><div>${styleTitle(st.id, st.name, !busyHere)}<p>Learned from a sample video ${ago(st.createdAt)}. Pick it when you start a video.</p></div>
        <div class="row">${busyHere ? '' : (st.ready ? `<button class="btn quiet sm" data-action="style-duplicate" data-id="${esc(st.id)}">${I.copy} Make a copy</button><button class="btn sm" data-action="style-duplicate" data-id="${esc(st.id)}" data-branded="1">${I.brand} Make a branded copy</button>` : '') + delBtn([{ area: 'style', path: st.id }], `the style “${st.name}”`, { label: 'Delete style' })}</div></div>`;
    },
    lstatus: (id) => {
      const st = styleOf(id);
      if (!st) return '';
      if (learningNow(st)) return progressPanel(S.job, 'Learning this style');
      if (learnQueued(st)) return `<section class="panel waitline"><h2 class="sub">${I.queue} Waiting in line</h2><p class="muted small">The editor studies this video as soon as it finishes what it's doing.</p></section>`;
      if (st.ready) return '';
      return `<section class="panel"><h2 class="sub">${I.warn} Learning did not finish</h2>
        ${st.reply ? `<div class="msg editor${st.reply.error ? ' error' : ''}" style="max-width:none;margin:12px 0"><div class="who">Editor</div>${md(st.reply.text)}</div>` : '<p class="muted small" style="margin:8px 0 12px">It was stopped or the app was closed.</p>'}
        <button class="btn" data-action="style-retry" data-id="${esc(st.id)}">${I.retry} Try again</button></section>`;
    },
    board: (id) => {
      const st = styleOf(id);
      if (!st?.frames.length) return '';
      return `<div class="section-head"><div><h2>Storyboard</h2><p class="muted small">Frames from the sample video. Your videos in this style should look like these.</p></div></div>
        <div class="board">${st.frames.map((f) => `<figure class="frame"><a href="${frameSrc(st, f)}" target="_blank" rel="noopener"><img src="${frameSrc(st, f)}" alt="Frame${atLabel(f) ? ` at ${atLabel(f)}` : ''} of the sample video" loading="lazy" decoding="async"></a>
          <figcaption>${atLabel(f) ? `<span class="num">${atLabel(f)}</span> ` : ''}${esc(f.note)}</figcaption></figure>`).join('')}</div>`;
    },
    ldoc: (id) => {
      const st = styleOf(id);
      const doc = S.docs.learned;
      if (!st || !st.ready) return st?.source ? `<section class="section"><h2 style="margin-bottom:12px">Sample video</h2><div class="monitor" style="max-width:420px"><video controls playsinline preload="metadata" src="/media/styles/${enc(st.id)}/${enc(st.source)}"></video></div></section>` : '';
      if (doc?.id !== id) return SKELETON;
      const styleBusy = (S.job?.kind === 'style' && S.job.styleId === id) || S.state.queue.some((q) => q.type === 'style' && q.styleId === id);
      return `<div class="split"><article class="panel doc">${md(doc.text)}</article>
        <aside>
          <section class="panel composer"><h2 class="sub"><label for="style-ask">Change something</label></h2><p class="muted small">Describe it in your own words. The editor updates this style for you.</p>
            <textarea id="style-ask" placeholder="e.g. Make the captions smaller"></textarea>
            <button class="btn primary" data-action="style-ask" data-style="${esc(id)}" ${styleBusy ? 'disabled' : ''}>${styleBusy ? 'Updating…' : busy() ? 'Update this style (waits in line)' : 'Update this style'}</button>
            ${doc.reply ? `<div class="msg editor${doc.reply.error ? ' error' : ''}" style="max-width:none"><div class="who">Editor</div>${md(doc.reply.text)}</div>` : ''}
          </section>
          ${st.reply && !st.reply.error ? `<section class="panel"><h2 class="sub">What stands out</h2><div class="doc small">${md(st.reply.text)}</div></section>` : ''}
          ${st.source ? `<section class="panel"><h2 class="sub">Sample video</h2><div class="monitor" style="margin-top:10px"><video controls playsinline preload="metadata" src="/media/styles/${enc(st.id)}/${enc(st.source)}"></video></div></section>` : ''}
        </aside></div>`;
    },
    body: () => {
      const text = S.docs.style;
      const pack = S.state.brand.pack;
      if (text === undefined) return SKELETON;
      if (pack && text !== null) {
        return `<div class="page-head folder-head"><div>${styleTitle('main', mainStyleName())}<p>Your team's brand style. Every ${esc(pack.name)} video follows it, whoever films.</p></div><span class="tape">From ${esc(pack.name)}</span></div>
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
      return `<div class="page-head folder-head"><div>${styleTitle('main', mainStyleName())}<p>Your main style: how videos are edited unless you pick another one. Notes you give on videos can also become <a href="#/rules">rules</a>, which win over this.</p></div></div>
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
  after: () => { const i = $('#rename-style'); if (i && S.focusRenameStyle) { S.focusRenameStyle = false; i.focus(); i.select(); } },
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
        <h3>Brand check</h3>
        <label class="tick"><input type="checkbox" ${st.brandCheck ? 'checked' : ''} data-action="set-brand-check"><span><b>Check every draft against My brand.</b> Before you see a draft, the editor looks at a few frames and fixes colors, fonts, logo or contact details that are off. Takes a little longer and uses a bit more of your plan.</span></label>
        <h3 style="margin-top:22px">How much freedom does the editor get?</h3>
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

// auto = { slug, file }: the same options, for sending an editor version to the AI as a new video.
function openEditDialog(files, auto = null) {
  files = files.filter((p) => S.state.inbox.some((f) => f.path === p && f.kind === 'video'));
  if (!files.length && !auto) return;
  S.dialog = { files: [...files], keep: false, auto };
  const n = files.length;
  const others = S.state.inbox.filter((x) => x.kind === 'video' && !files.includes(x.path));
  const extras = S.state.inbox.filter((x) => x.kind !== 'video');
  const lib = S.state.brand.broll.length;
  const brandImgs = S.state.brand.images || [];
  const sounds = S.state.sounds || [];
  const assetRow = (ref, label, thumb) => `<label class="asset-row"><input type="checkbox" name="asset" value="${esc(ref)}">
    ${thumb ? `<img class="asset-thumb" src="${thumb}" alt="">` : `<span class="asset-thumb ph">${I.music}</span>`}
    <span class="asset-name">${esc(label)}</span>
    <input type="text" class="asset-note" placeholder="What's it for? (optional)" maxlength="200" autocomplete="off"></label>`;
  const { people, contact } = S.state.brand;
  let last = 'all';
  try { last = localStorage.getItem('f247.contact') || 'all'; } catch {}
  if (!people.some((p) => p.id === last)) last = 'all';
  const shown = (o) => esc(o.folder ? `${o.folder} / ${o.name}` : o.name);
  const styles = S.state.styles.filter((x) => x.ready);
  let lastStyle = '';
  try { lastStyle = localStorage.getItem('f247.style') || ''; } catch {}
  if (!styles.some((x) => x.id === lastStyle)) lastStyle = '';
  const pack = S.state.brand.pack;
  const m = $('#modal');
  m.innerHTML = `<form class="inner" method="dialog" data-form="edit">
    <div class="top"><div><h2 id="modal-title">${auto ? 'Auto edit your changes' : n > 1 ? `One video from ${n} clips` : 'Edit this clip'}</h2>
      <p class="muted" style="margin-top:4px">${auto ? `The AI edits ${esc(auto.file)} as a new video and keeps your zoom, cuts and marks.` : n > 1 ? 'The editor listens to every clip, puts them in story order, and drops the retakes.' : esc(files[0].split('/').pop())}</p></div>
      <button class="btn quiet icon" type="button" data-action="close-modal" aria-label="Close">${I.x}</button></div>
    ${auto ? '' : `<ol class="clipstrip" data-strip>${stripHtml()}</ol>
      <label class="tick"><input type="checkbox" name="manual" data-action="edit-manual">Adjust it myself first (zoom, cuts, clips)<small>Opens the editor. The AI starts when you press Auto edit there.</small></label>`}
    ${n > 1 ? '<label class="tick"><input type="checkbox" data-action="keep-order"><span>Keep the order I picked</span><small>Only if the editor gets it wrong</small></label>' : ''}
    <fieldset class="q"><legend><h3>What kind of edit?</h3></legend><p>Pick clean raw when you only want the cuts, for example before replacing the background.</p>
      <div class="opts">
        <label class="opt"><input type="radio" name="kind" value="full" data-action="edit-kind" checked><span><b>Full edit</b><small>Captions, graphics, zoom-ins and sound, in your style</small></span></label>
        <label class="opt"><input type="radio" name="kind" value="clean" data-action="edit-kind"><span><b>Clean raw</b><small>Only cuts silences and mistakes and cleans up the voice. No captions, graphics, transitions, sound effects or music</small></span></label>
      </div></fieldset>
    <fieldset class="q contact-pick full-only"><legend><h3>Who is this video for?</h3></legend><p>This decides the contact part at the end.</p>
      <div class="opts">
        <label class="opt"><input type="radio" name="contact" value="all" ${last === 'all' ? 'checked' : ''}><span><b>All sales</b><small>${contact ? `Ends with ${esc(contact.name || 'the brand contact')}` : 'No brand contact yet, so it ends with the logo'}</small></span></label>
        ${people.map((p) => `<label class="opt"><input type="radio" name="contact" value="${esc(p.id)}" ${last === p.id ? 'checked' : ''}><span><b>${esc(p.onScreen)}</b><small>${p.lines.length ? esc(p.lines.map((l) => l.label).join(' · ')) : 'No numbers yet'}${p.fb ? ' · Facebook' : ''}</small></span></label>`).join('')}
      </div>
      <a class="small" href="#/brand" data-jump="brand-details">${people.length ? 'Add or change sales people' : 'Add a sales person'} in My brand</a>
    </fieldset>
    ${styles.length ? `<fieldset class="q style-pick full-only"><legend><h3>Which style?</h3></legend><p>How this video should look.</p>
      <div class="opts">
        <label class="opt"><input type="radio" name="style" value="" ${lastStyle ? '' : 'checked'}><span><b>${esc(mainStyleName())}</b><small>${S.state.setup.style ? 'Your main style' : 'Not set yet, so the editor uses its own'}</small></span></label>
        ${styles.map((x) => `<label class="opt"><input type="radio" name="style" value="${esc(x.id)}" ${lastStyle === x.id ? 'checked' : ''}><span>${x.frames[0] ? `<img class="opt-frame" src="${frameSrc(x, x.frames[0])}" alt="">` : ''}<b>${esc(x.name)}</b><small>Learned from a video</small></span></label>`).join('')}
      </div>
      <a class="small" href="#/style">See my styles</a>
    </fieldset>` : ''}
    <fieldset class="q full-only"><legend><h3>Preview first</h3></legend><p>Check the look before the full edit is made.</p>
      <label class="tick"><input type="checkbox" name="preview">Show me a preview first<small>A storyboard and a 5-second sample. Worth it for a new style; skip it for a style you trust.</small></label>
    </fieldset>
    <fieldset class="q full-only"><legend><h3>Sound effects</h3></legend><p>Makes the video feel lively.</p>
      <label class="tick"><input type="checkbox" name="sfx" checked>Add sound effects<small>Whooshes, pops and dings on cuts and graphics</small></label>
    </fieldset>
    <fieldset class="q music-pick full-only"><legend><h3>Background music</h3></legend><p>A quiet music bed under your voice.</p>
      <div class="opts">
        <label class="opt"><input type="radio" name="music" value="none" checked><span><b>No music</b><small>Voice (and effects) only</small></span></label>
        <label class="opt"><input type="radio" name="music" value=""><span><b>Let the editor choose</b><small>${sounds.length ? 'Uses your My brand music when the style wants music' : 'Makes or skips music to fit the style'}</small></span></label>
        ${sounds.map((f) => `<label class="opt"><input type="radio" name="music" value="track:${esc(f.folder ? `${f.folder}/${f.name}` : f.name)}"><span><b>${esc(f.name)}</b><small>From My brand</small></span></label>`).join('')}
      </div>
      ${sounds.length ? '' : '<a class="small" href="#/brand" data-jump="brand-music">Add music in My brand</a>'}
    </fieldset>
    <label class="field"><span>Name this video <span class="hint">(optional, so you can find it later)</span></span><input type="text" name="name" maxlength="80" placeholder="e.g. Why buy your car with us" autocomplete="off"></label>
    <label class="field"><span>Anything special for this video? <span class="hint">(optional)</span></span>
      <textarea name="instructions" placeholder="e.g. This is a promo for our new branch."></textarea></label>
    <details class="more full-only"><summary>${I.right}B-roll, pictures and sounds</summary><div style="display:grid;gap:16px">
      <p class="small ${lib ? '' : 'muted'}">${lib ? `${I.check} Your brand's B-roll library (${plural(lib, 'clip')}) is used automatically.` : 'Tip: add B-roll in <a href="#/brand">My brand</a> so every video can use it.'}</p>
      ${brandImgs.length ? `<div><p class="small muted" style="margin-bottom:8px">Pictures from My brand — tick the ones to use and say what each is for:</p><div class="asset-list">${brandImgs.map((x) => assetRow(`image:${x.name}`, x.name, `/media/brand/images/${enc(x.name)}?t=${Math.round(x.mtime)}`)).join('')}</div></div>` : ''}
      ${sounds.length ? `<div><p class="small muted" style="margin-bottom:8px">Sounds from My brand — tick one and say what it's for (e.g. a voiceover line):</p><div class="asset-list">${sounds.map((f) => assetRow(`sound:${f.folder ? `${f.folder}/${f.name}` : f.name}`, f.folder ? `${f.folder} / ${f.name}` : f.name, null)).join('')}</div></div>` : ''}
      ${others.length ? `<div><p class="small muted" style="margin-bottom:8px">Extra B-roll just for this video:</p><div class="ticks">${others.map((o) => `<label class="tick"><input type="checkbox" name="broll" value="${esc(o.path)}">${shown(o)}<small>${fmtDur(o.duration)}</small></label>`).join('')}</div></div>` : ''}
      ${extras.length ? `<div><p class="small muted" style="margin-bottom:8px">Pictures or text from your inbox to use:</p><div class="ticks">${extras.map((o) => `<label class="tick"><input type="checkbox" name="extra" value="${esc(o.path)}">${shown(o)}</label>`).join('')}</div></div>` : ''}
    </div></details>
    <div class="row spread foot"><span class="muted small">${busy() ? `The editor is busy with “${esc(S.job.title)}”. This starts right after.` : 'Takes about 10 to 30 minutes. You can close this page while it works.'}</span>
      <button class="btn primary big" type="submit" data-label="${esc(busy() ? `${I.queue} Add to the line` : `${I.play} Start editing`)}">${busy() ? `${I.queue} Add to the line` : `${I.play} Start editing`}</button></div>
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
    body: hasStyle ? 'It replaces your style, logo, screenshot, brand contact and (if included) B-roll, and adds the team’s pictures and learned styles. A backup of your style is kept. Your own rules and sales people stay.' : 'It sets your style, logo, screenshot, brand contact, B-roll, pictures and learned styles from your team.',
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
$('#style-picker').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !S.learnName) return;
  const r = await sendFile(`/api/styles/learn?name=${enc(S.learnName)}&file=${enc(file.name)}`, file, 'Uploading');
  if (r.error) return toast(r.error, { bad: true, ms: 9000 });
  S.learnName = null;
  askNotify();
  toast(r.queued ? 'Saved. The editor studies it when it is free.' : 'The editor is studying your video…');
  location.hash = `#/style/${enc(r.id)}`;
});
$('#bg-picker').addEventListener('change', async (e) => {
  const file = e.target.files[0], slug = S.bgSlug;
  e.target.value = '';
  if (!file || !slug) return;
  const r = await sendFile(`/api/projects/${slug}/bg/photo?name=${enc(file.name)}`, file, 'Adding');
  if (r.error) toast(r.error, { bad: true, ms: 9000 }); else toast('Photo added. Press Check background.');
});
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
  'bg-photo': (d) => { S.bgSlug = d.slug; $('#bg-picker').click(); },
  'bg-check': async (d) => { try { queuedToast(await api(`/api/projects/${d.slug}/bg/check`, { body: {} })); } catch (e) { fail(e); } },
  'bg-copy-prompt': () => navigator.clipboard.writeText($('#bg-plate-prompt').value).then(() => toast('Prompt copied.'), fail),
  'bg-prices': (d) => api(`/api/projects/${d.slug}/bg/prices`, { body: {} }).catch(fail),
  'bg-plate': async (d, el) => {
    el.disabled = true;
    try {
      const { credits } = await api(`/api/projects/${d.slug}/bg/plate-price`, { body: {} });
      if (await ask({ title: `Spend ${credits} credits?`, body: 'Makes an empty-room version of your photo, seen from your video\'s camera angle (Nano Banana Pro, 2k). Then check it again before generating.', ok: `Spend ${credits} credits` })) {
        await api(`/api/projects/${d.slug}/bg/plate`, { body: {} });
      }
    } catch (e) { fail(e); }
    el.disabled = false;
  },
  'bg-generate': async (d) => {
    const p = proj(d.slug);
    const picks = $$('input[name="bgpick"]:checked').map((x) => { const [model, res] = x.value.split('|'); return { model, res }; });
    if (!picks.length) return toast('Tick at least one model first.', { bad: true });
    const rows = picks.map((k) => p.bg.quote.rows.find((r) => r.model === k.model && r.res === k.res));
    const total = Math.round(rows.reduce((a, r) => a + r.total, 0) * 100) / 100;
    if (!await ask({ title: `Spend ${total} credits?`, body: `${rows.map((r) => `${r.name} ${r.res}: ${r.total}`).join(' · ')}. Your balance: ${p.bg.quote.balance}. Each model does one part at a time; this takes a while.`, ok: `Spend ${total} credits` })) return;
    try { await api(`/api/projects/${d.slug}/bg/generate`, { body: { picks, prompt: $('#bg-prompt')?.value || '' } }); toast('Started. You can leave this page; it keeps going.'); askNotify(); } catch (e) { fail(e); }
  },
  'bg-again': async (d) => {
    const ok = d.chunk
      ? await ask({ title: `Redo this part for ${d.cost || 'a few'} credits?`, body: 'Only this part is made again. The other parts are kept, and you get a new version.', ok: `Spend ${d.cost || ''} credits`.trim() })
      : await ask({ title: 'Continue this run?', body: 'Finishes the parts you already paid for and approved. Parts that were already done are not made again.', ok: 'Continue' });
    if (!ok) return;
    try { await api(`/api/projects/${d.slug}/bg/again`, { body: { key: d.key, chunk: d.chunk || null } }); } catch (e) { fail(e); }
  },
  'edit-manual': (d, el) => { const b = $('button[type="submit"]', el.form); b.innerHTML = el.checked ? `${I.film} Open the editor` : b.dataset.label; },
  'edit-kind': (d, el) => { for (const f of $$('.full-only', el.form)) f.hidden = el.value === 'clean'; },
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
      if (r.name === 'style' && items.some((x) => x.area === 'style' && x.path === r.arg)) location.hash = '#/style';
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
  // A different version replaces the edit list, so ask first when there are changes from another version.
  'open-editor': async (d, el) => {
    el.disabled = true;
    try {
      const cur = await api(`/api/projects/${enc(d.slug)}/editor`).catch(() => null);
      if (cur?.from !== d.file) {
        if (cur?.parts?.length && !await ask({ title: 'Start over from this version?', body: 'The editor has your changes from another version. Opening this version replaces them.', ok: 'Start over' })) { el.disabled = false; return; }
        await api(`/api/projects/${enc(d.slug)}/editor/open`, { body: { from: d.file } });
      }
      location.hash = `#/edit/${enc(d.slug)}`;
    } catch (e) { fail(e); }
    el.disabled = false;
  },
  'ed-play': () => E?.ready && edPlay(),
  'ed-split': () => {
    if (!E?.ready) return;
    edPause();
    if (E.snd >= 0) {
      const i = splitSound(E.audio, E.snd, E.t, nextSoundId(E.audio));
      if (i < 0) return toast('Move the playhead inside the sound first, away from its ends.');
      E.snd = i;
    } else {
      const i = splitAt(E.parts, E.t);
      if (i < 0) return toast('Move the playhead inside a part first, away from its ends.');
      Object.assign(E, { sel: i, mark: -1 });
    }
    E.panel = null;
    edCommit(); edDraw();
  },
  'ed-delete': () => {
    if (!E?.ready) return;
    if (E.snd >= 0) E.audio.splice(E.snd, 1);
    else if (E.mark >= 0) E.marks.splice(E.mark, 1);
    else if (E.sel >= 0) {
      if (E.parts.length < 2) return toast('The video needs at least one part.');
      edPause(); E.parts.splice(E.sel, 1); E.t = Math.min(E.t, edTotal());
    } else return;
    Object.assign(E, { sel: -1, mark: -1, snd: -1, panel: null });
    edCommit(); edDraw();
  },
  // Zoom, Volume and Note open their row; Done (or Esc) closes it and puts focus back on the button that opened it.
  'ed-panel': (d) => {
    const prev = E.panel;
    E.panel = d.panel || null;
    edDrawTools();
    if (E.panel) $('[data-ed-tools] .ed-slide input')?.focus(); else $(`[data-panel="${prev}"]`)?.focus();
  },
  'ed-mute': () => {
    const t = E.audio[E.snd] || E.parts[E.sel];
    if (!t) return;
    t.volume = (t.volume ?? 1) > 0 ? 0 : 1;
    edCommit(); edDraw();
  },
  'ed-extract': () => {
    const p = E.parts[E.sel];
    if (!p) return;
    if (!edSrc(p.src)?.wave) return toast('This part has no sound to take out.');
    if (E.audio.length >= 50) return toast('You can have up to 50 sounds.');
    edPause();
    E.audio.push(extractAudio(E.parts, E.sel, nextSoundId(E.audio)));
    edCommit();
    edSelect('snd', E.audio.length - 1);
    edDraw();
    toast('The sound is now its own clip under the video, and the part is muted.');
  },
  'ed-add-sound': () => {
    if (!E?.ready) return;
    if (E.audio.length >= 50) return toast('You can have up to 50 sounds.');
    edSoundDialog();
  },
  'ed-sound-play': (d, el) => {
    const again = !edPreview.paused && edPreview.dataset.path === d.path;
    edPreview.pause();
    for (const b of $$('[data-action="ed-sound-play"]')) { b.innerHTML = I.play; b.setAttribute('aria-pressed', 'false'); }
    if (again) return;
    edPreview.src = `/media/sounds/${encPath(d.path)}`;
    edPreview.dataset.path = d.path;
    edPreview.onended = () => { el.innerHTML = I.play; el.setAttribute('aria-pressed', 'false'); };
    edPreview.play().catch(fail);
    el.innerHTML = EI.pause; el.setAttribute('aria-pressed', 'true');
  },
  'ed-sound-pick': async (d) => {
    const e = E, at = e.t;
    $('#modal').close();
    edWaitClip(e, 'sound');
    try { edAdded(e, await api(`/api/projects/${enc(e.slug)}/editor/source`, { body: { sound: d.path } }), at); } catch (err) { e.pending = null; if (E === e) { edDrawTools(); edStatus(); } fail(err); }
  },
  'ed-sound-upload': () => edPick('sound'),
  'ed-move': (d) => {
    const j = E.sel + Number(d.dir);
    if (E.sel < 0 || j < 0 || j >= E.parts.length) return;
    edPause(); movePart(E.parts, E.sel, j);
    Object.assign(E, { sel: j, t: partStart(E.parts, j) });
    edCommit(); edDraw();
  },
  'ed-add': () => E?.ready && edClipDialog(),
  'ed-add-inbox': async (d) => {
    const e = E, at = e.t;
    $('#modal').close();
    edWaitClip(e);
    try { edAdded(e, await api(`/api/projects/${enc(e.slug)}/editor/source`, { body: { inbox: d.path } }), at); } catch (err) { e.pending = null; if (E === e) { edDrawTools(); edStatus(); } fail(err); }
  },
  'ed-upload': () => edPick('part'),
  'ed-mark': () => edMarking(!E.marking),
  'ed-unselect': () => edSelect(null, -1),
  'ed-reset': () => {
    const i = E.sel >= 0 ? E.sel : E.cur, p = E.parts[i];
    if (!p) return;
    p.x = 0.5; p.y = 0.5; edZoom(1, i);
    const r = $('[data-ed="zoom"]');
    if (r) r.value = 1;
  },
  'ed-undo': () => {
    if (!E?.ready || !E.undo.length) return;
    edPause();
    const s = E.undo.pop();
    ({ parts: E.parts, marks: E.marks, audio: E.audio } = JSON.parse(s));
    Object.assign(E, { last: s, rev: E.rev + 1, sel: -1, mark: -1, snd: -1, panel: null, snapAt: 0 });
    clearTimeout(E.timer); E.timer = setTimeout(() => edSave(E), 800);
    edDraw();
  },
  // Sends only the selected mark's stretch to the AI. The page waits (and reloads the edit) until the fixed part is back.
  'ed-fix': async () => {
    const e = E, i = e.mark, m = e.marks[i];
    if (!m || e.busy) return;
    edPause();
    try { await edSave(e); if (e.saveErr) throw new Error(`Your changes could not be saved: ${e.saveErr}`); } catch (err) { return fail(err); }
    // Locked from here: the wait screen replaces the editor, and edLoad brings it back from what the server has.
    Object.assign(e, { ready: false, sel: -1, mark: -1, snd: -1, panel: null, marking: false, undo: [] });
    const when = `${fmtClock(m.start)} to ${fmtClock(m.end)}`;
    $('[data-ed-body]').innerHTML = `<div class="ed-wait"><span class="live"></span><b>Fixing one part…</b><span>Cutting out ${when}…</span></div>`;
    try {
      const r = await api(`/api/projects/${enc(e.slug)}/editor/fix`, { body: { mark: i } });
      askNotify();
      if (r.queued) queuedToast(r); else toast(`The AI is fixing ${when}. Only that part changes.`);
    } catch (err) { fail(err); }
    if (E === e) edLoad();
  },
  'ed-render': async () => {
    const slug = E.slug;
    try { await edRenderNow(); toast('Saved as a new version.', { link: { href: `#/p/${enc(slug)}`, label: 'Watch it' }, ms: 9000 }); } catch (err) { fail(err); }
  },
  // Auto edit sends the shown edit as a version: render it first unless nothing changed since the last render.
  'ed-auto': async () => {
    const e = E;
    try {
      // Opened from a version and left as it is: send that version, no copy.
      const [p] = e.parts, src = e.sources.find((s) => s.id === p?.src);
      const untouched = e.from && e.parts.length === 1 && !e.marks.length && src?.url.startsWith(`/media/outbox/${e.from}?`)
        && p.in < 0.05 && p.out > src.duration - 0.05 && p.zoom === 1 && p.x === 0.5 && p.y === 0.5 && (p.volume ?? 1) === 1 && !e.audio.length;
      const file = untouched ? e.from : e.rendered?.rev === e.rev ? e.rendered.file : await edRenderNow();
      if (e.canAuto === 'form') return openEditDialog([], { slug: e.slug, file });
      e.busy = 'Sending it to the AI editor…'; edStatus();
      const r = await api(`/api/projects/${enc(e.slug)}/editor/auto`, { body: { file } });
      askNotify();
      if (r.queued) queuedToast(r); else toast('The AI editor is on it. You get a notice when it is ready.');
      location.hash = `#/p/${enc(r.slug || e.slug)}`;
    } catch (err) { fail(err); }
    e.busy = '';
    if (E === e) edStatus();
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
  go: async (d, el) => {
    el.disabled = true;
    try { const r = await api(`/api/projects/${d.slug}/go`, { body: {} }); askNotify(); r.queued ? queuedToast(r) : toast('Making the full edit…'); } catch (e) { fail(e); el.disabled = false; }
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
  'style-ask': async (d) => {
    const t = $('#style-ask');
    if (!t.value.trim()) return t.focus();
    try {
      const r = await api('/api/style/ask', { body: { text: t.value, styleId: d.style || null } });
      if (d.style && S.docs.learned) S.docs.learned.reply = null; else S.docs.styleReply = null;
      t.value = ''; r.queued ? queuedToast(r) : toast(d.style ? 'Updating this style…' : 'Updating your style…');
    } catch (e) { fail(e); }
  },
  'rename-style': () => { S.renamingStyle = true; S.focusRenameStyle = true; refresh(); },
  'rename-style-cancel': () => { S.renamingStyle = false; refresh(); },
  'rename-style-go': (d) => { S.renameOnEnter = d.id; location.hash = `#/style/${enc(d.id)}`; },
  'style-duplicate': (d) => api(`/api/styles/${enc(d.id)}/duplicate`, { body: { branded: Boolean(d.branded) } }).then((r) => {
    if (!d.branded) return toast(`Made a copy: “${r.name}”. It is in My styles.`);
    location.hash = `#/style/${enc(r.id)}`;
    r.queued ? queuedToast(r) : toast(`Putting your brand on “${r.name}”…`);
  }).catch((e) => (/My brand first/.test(e.message) ? toast(e.message, { bad: true, link: { href: '#/brand', label: 'Open My brand' } }) : fail(e))),
  'style-retry': (d) => api(`/api/styles/${enc(d.id)}/retry`, { body: {} }).then((r) => { askNotify(); r.queued ? queuedToast(r) : toast('Learning the style again…'); }).catch(fail),
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
    p.accept = d.slot === 'broll' ? 'video/*,.mov,.mp4,.m4v' : d.slot === 'font' ? '.ttf,.otf,.woff,.woff2' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    p.multiple = ['broll', 'image', 'font'].includes(d.slot);
    p.click();
  },
  'use-inbox': (d) => api('/api/brand/use-inbox', { body: { slot: d.slot, name: d.name } }).then(() => toast(d.slot === 'person' ? 'Sales person added. Check their title and numbers.' : 'Added to My brand.')).catch(fail),
  'add-line': (d, el) => { const box = $('[data-lines]', el.closest('form')); box.insertAdjacentHTML('beforeend', lineRow()); $$('input[name="label"]', box).at(-1).focus(); },
  'add-row': (d, el) => { const box = $(`[data-lines="${d.kind}"]`, el.closest('form')); box.insertAdjacentHTML('beforeend', d.kind === 'color' ? colorRow() : gradientRow()); $$('input[type="text"]', box).at(-1).focus(); },
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
  'set-brand-check': (d, el) => api('/api/settings', { body: { brandCheck: el.checked } }).then(() => toast(el.checked ? 'Brand check is on.' : 'Brand check is off.')).catch(fail),
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
  if (kind === 'look') {
    const rows = (k) => $$(`[data-lines="${k}"] .line`, form);
    const colors = rows('color').map((r) => ({ hex: $('[name="hex"]', r).value, label: $('[name="label"]', r).value }));
    const gradients = rows('gradient').map((r) => ({ from: $('[name="from"]', r).value, to: $('[name="to"]', r).value, angle: Number($('[name="angle"]', r).value), label: $('[name="label"]', r).value }));
    try { await api('/api/brand/look', { body: { colors, gradients, feel: form.elements.feel.value } }); toast('Colors and feel saved.'); } catch (err) { fail(err); }
  }
  if (kind === 'fonts') {
    const fonts = Object.fromEntries($$('input[name="mood"]', form).map((i) => [i.dataset.file, i.value]));
    try { await api('/api/brand/look', { body: { fonts } }); toast('Font moods saved.'); } catch (err) { fail(err); }
  }
  if (kind === 'about') {
    try { await api('/api/brand/look', { body: { about: form.elements.about.value } }); toast('Saved. The editor uses it on every video.'); } catch (err) { fail(err); }
  }
  if (kind === 'bcontact') {
    try { await api('/api/brand/contact', { body: { name: form.elements.name.value, lines: formLines() } }); toast('Brand contact saved.'); } catch (err) { fail(err); }
  }
  if (kind === 'person') {
    const el = form.elements;
    try {
      await api('/api/people', { body: { id: form.dataset.id || null, title: el.title.value, name: el.name.value, pronoun: el.pronoun.value, lines: formLines(), fb: el.fb.value } });
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
  if (kind === 'learn') {
    const input = $('#learn-name');
    if (!input.value.trim()) return input.focus();
    S.learnName = input.value.trim();
    $('#style-picker').click();
  }
  if (kind === 'rename-style') {
    const input = $('#rename-style');
    if (!input.value.trim()) return input.focus();
    const id = form.dataset.id;
    try {
      await api(id === 'main' ? '/api/style/rename' : `/api/styles/${enc(id)}/rename`, { body: { name: input.value } });
      S.renamingStyle = false; toast('Renamed.');
      if (id === 'main') refresh(); else loadLearned(id);
    } catch (err) { fail(err); }
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
    a.href = `/api/brand/export?name=${enc(name)}&broll=${on('broll')}&music=${on('music')}&images=${on('images')}&styles=${on('styles')}&people=${on('people')}`;
    a.download = '';
    document.body.append(a); a.click(); a.remove();
    toast('Making your brand pack. Send the file to your teammates any way you like.', { ms: 8000 });
  }
  if (kind === 'edit') {
    const fd = new FormData(form);
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      // A row counts as picked when ticked or when its "what's it for" note is filled in.
      const assets = $$('.asset-row', form).map((row) => ({ ref: $('input[name="asset"]', row).value, on: $('input[name="asset"]', row).checked, note: $('.asset-note', row).value.trim() }))
        .filter((a) => a.on || a.note).map(({ ref, note }) => ({ ref, note }));
      const options = {
        name: fd.get('name') || '',
        instructions: fd.get('instructions') || '', broll: fd.getAll('broll'), extra: fd.getAll('extra'),
        contact: fd.get('contact') && fd.get('contact') !== 'all' ? { type: 'person', id: fd.get('contact') } : { type: 'all' },
        style: fd.get('style') || '', music: fd.get('music') || '', sfx: fd.get('sfx') === 'on', assets, preview: fd.get('preview') === 'on',
        clean: fd.get('kind') === 'clean',
      };
      const { auto } = S.dialog;
      const manual = !auto && fd.get('manual') === 'on';
      const r = auto
        ? await api(`/api/projects/${enc(auto.slug)}/editor/auto`, { body: { file: auto.file, options } })
        : await api('/api/edit', { body: { ...options, files: S.dialog.files, keepOrder: S.dialog.keep, manual } });
      try { localStorage.setItem('f247.contact', fd.get('contact') || 'all'); localStorage.setItem('f247.style', fd.get('style') || ''); } catch {}
      $('#modal').close();
      if (!auto) S.pick = [];
      if (!manual) { askNotify(); queuedToast(r); }
      location.hash = manual ? `#/edit/${enc(r.slug)}` : `#/p/${enc(r.slug || auto.slug)}`;
    } catch (err) { fail(err); btn.disabled = false; }
  }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.close(); });
$('#modal').addEventListener('close', () => { S.dialog = null; });

connect();
