#!/usr/bin/env node
// free247editor web app: a local page for dropping videos, watching edits run, giving notes,
// and managing style and rules. Claude Code still does the editing; this runs `claude -p`
// in the repo root so it follows CLAUDE.md exactly as it does in the terminal.
//
//   node app/server.mjs            (opens http://localhost:4747)
//   node app/server.mjs --no-open  (does not open the browser)
//
// Only listens on 127.0.0.1. No packages needed beyond Node 22.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync, copyFileSync, createReadStream, lstatSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'app', 'public');
// my-brand/ holds what every video for the brand uses: logo.*, social.* (a screenshot of the social
// page), broll/broll_<category>_<nn>.*, brand-rules.md and pack.json (present = style comes from a brand pack).
const dirs = { inbox: join(root, 'inbox'), outbox: join(root, 'outbox'), sounds: join(root, 'my-sounds'), brand: join(root, 'my-brand') };
const brollDir = join(dirs.brand, 'broll');
// Sales people a video can be for (personal, optional in a brand pack), and the brand contact for all-sales videos.
const peopleFile = join(root, 'my-people.json');
const brandContactFile = join(dirs.brand, 'contact.json');
const data = join(root, '.webapp');
const projectsDir = join(data, 'projects');
const thumbsDir = join(data, 'thumbs');
const previewsDir = join(data, 'previews');
for (const d of [...Object.values(dirs), brollDir, projectsDir, thumbsDir, previewsDir]) mkdirSync(d, { recursive: true });

const win = process.platform === 'win32';
// Double-click launchers start without the user's shell profile, so add the usual install places.
const extraPath = win ? [] : [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'),
  '/opt/homebrew/bin', '/usr/local/bin'];
process.env.PATH = [...new Set([...process.env.PATH.split(delimiter), ...extraPath])].join(delimiter);

const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8',
};
const PERMISSION_MODES = ['auto', 'bypassPermissions'];
const MODELS = ['', 'opus', 'sonnet', 'fable'];

// ---------- small helpers ----------

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const today = () => new Date().toLocaleDateString('en-CA');
const ok = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'ignore', shell: win }); return !r.error && r.status === 0; };
// A single file name inside one of our folders. Rejects anything that could climb out.
const safeName = (name) => {
  const n = basename(String(name || ''));
  return n && n === name && !n.startsWith('.') && !/[\\/\0]/.test(n) ? n : null;
};
const slugify = (s) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';

const settingsFile = join(data, 'settings.json');
const getSettings = () => ({ permissionMode: 'auto', model: '', ...readJson(settingsFile, {}) });

function envHasGroq() {
  const env = readText(join(root, '.env')) || '';
  return /^\s*GROQ_API_KEY\s*=\s*\S+/m.test(env);
}

// ---------- folders ----------

// The inbox may hold one level of folders, usually one per video. Inbox files are named by path:
// "IMG_1.MOV" or "Promo Oct 20/IMG_1.MOV".
function listInbox() {
  const files = [];
  const folders = [];
  const entry = (name, folder, st) => {
    const e = { name, folder, path: folder ? `${folder}/${name}` : name, size: st.size, mtime: st.mtimeMs, kind: kindOf(name) };
    return e.kind === 'video' ? { ...e, ...probe(join(dirs.inbox, ...(folder ? [folder] : []), name), st.mtimeMs) } : e;
  };
  for (const name of readdirSafe(dirs.inbox)) {
    const full = join(dirs.inbox, name);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      let latest = st.mtimeMs;
      for (const inner of readdirSafe(full)) {
        let s2; try { s2 = statSync(join(full, inner)); } catch { continue; }
        if (!s2.isFile()) continue;
        latest = Math.max(latest, s2.mtimeMs);
        files.push(entry(inner, name, s2));
      }
      folders.push({ name, mtime: latest });
    } else if (st.isFile()) files.push(entry(name, '', st));
  }
  return { files: files.sort((a, b) => b.mtime - a.mtime), folders: folders.sort((a, b) => b.mtime - a.mtime) };
}
// "clip.mov" or "Folder/clip.mov", nothing deeper and nothing that climbs out.
const safePath = (rel) => {
  const parts = String(rel || '').split('/');
  return parts.length <= 2 && parts.every((x) => safeName(x)) ? parts.join('/') : null;
};
const inboxFull = (rel) => join(dirs.inbox, ...rel.split('/'));
const folderName = (s) => String(s || '').replace(/[\\/:*?"<>|\0]+/g, '-').replace(/^[.\s]+/, '').trim().slice(0, 60);
const freeName = (dir, name) => {
  const stem = name.replace(/\.[^.]+$/, '');
  const ext = extname(name);
  let n = name;
  for (let i = 2; existsSync(join(dir, n)); i++) n = `${stem} (${i})${ext}`;
  return n;
};

const statSafeDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
// Inbox clips a running or queued edit still needs.
function busyInbox() {
  const slugs = new Set([job?.slug, ...queue.map((q) => q.slug)].filter(Boolean));
  return [...slugs].flatMap((slug) => { const r = loadProject(slug); return [...(r?.sources || []), ...(r?.broll || [])]; });
}
// Keeps projects' clip lists right after clips move or a folder is renamed.
function remapSources(fn) {
  for (const f of readdirSafe(projectsDir)) {
    const rec = readJson(join(projectsDir, f), null);
    if (!rec?.sources) continue;
    const next = rec.sources.map(fn);
    if (next.join('\0') === rec.sources.join('\0')) continue;
    rec.sources = next; rec.source = next[0]; rec.broll = (rec.broll || []).map(fn);
    writeJson(join(projectsDir, f), rec);
  }
}

// Deleting moves things to the computer's Trash (Recycle Bin on Windows), so nothing is lost by a slip.
function toTrash(paths) {
  paths = paths.filter((p) => { try { lstatSync(p); return true; } catch { return false; } });
  if (!paths.length) return;
  if (process.platform === 'darwin') {
    const trash = join(homedir(), '.Trash');
    for (const p of paths) {
      const dest = join(trash, freeName(trash, basename(p)));
      try { renameSync(p, dest); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        const r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', p]);
        if (r.status !== 0) throw new Error('Could not move that to the Trash.');
      }
    }
  } else if (win) {
    const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in ($env:F247_TRASH -split "`n")) { if (Test-Path -LiteralPath $p -PathType Container) ' +
      "{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else " +
      "{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }";
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, F247_TRASH: paths.join('\n') }, windowsHide: true });
    if (r.status !== 0) throw new Error('Could not move that to the Recycle Bin.');
  } else {
    const r = spawnSync('gio', ['trash', ...paths]);
    if (r.status !== 0) throw new Error('Could not move that to the Trash.');
  }
}

function listFolder(area) {
  const out = [];
  for (const name of readdirSync(dirs[area])) {
    if (name.startsWith('.')) continue;
    const full = join(dirs[area], name);
    let st; try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) {
      if (area === 'sounds' && st.isDirectory()) {
        for (const inner of readdirSync(full)) {
          if (inner.startsWith('.')) continue;
          const s2 = statSync(join(full, inner));
          if (s2.isFile()) out.push({ name: inner, folder: name, size: s2.size, mtime: s2.mtimeMs, kind: kindOf(inner) });
        }
      }
      continue;
    }
    out.push({ name, size: st.size, mtime: st.mtimeMs, kind: kindOf(name) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
function kindOf(name) {
  const e = extname(name).toLowerCase();
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (IMAGE.has(e)) return 'image';
  if (['.txt', '.md'].includes(e)) return 'text';
  return 'other';
}
const readdirSafe = (d) => { try { return readdirSync(d).filter((n) => !n.startsWith('.')); } catch { return []; } };
const sizeOf = (f) => { try { return statSync(f).size; } catch { return 0; } };

// ---------- brand ----------

const styleFile = join(root, 'my-style.md');
const brandRulesFile = join(dirs.brand, 'brand-rules.md');
const packFile = join(dirs.brand, 'pack.json');
const slotFile = (slot) => readdirSafe(dirs.brand).find((n) => n.toLowerCase().startsWith(`${slot}.`) && kindOf(n) === 'image') || null;
const BROLL_RE = /^broll_([a-z0-9-]+)_(\d+)\.[a-z0-9]+$/i;
const DEFAULT_CATEGORIES = ['outside', 'inside', 'product', 'people', 'team'];

// The style decides what the brand needs. A plain keyword read keeps this generic across brands.
function styleNeeds(style) {
  const t = (style || '').toLowerCase();
  return {
    logo: /\blogo\b/.test(t),
    details: /contact|phone|number|\bcta\b|call to action/.test(t),
    broll: /b-?roll/.test(t),
    social: /screenshot|social[- ]?(media|proof|page)/.test(t),
    music: /\bmusic\b/.test(t),
  };
}
// B-roll categories named in the style, e.g. "Library categories: `exterior`, `showroom-wide`".
function styleCategories(style) {
  const out = [];
  for (const line of (style || '').split('\n')) {
    if (!/categor/i.test(line)) continue;
    for (const m of line.matchAll(/`([a-z0-9][a-z0-9-]{0,30})`/gi)) if (!/^broll_/i.test(m[1])) out.push(m[1].toLowerCase());
  }
  return [...new Set(out)];
}

// ---------- contact part: sales people and the brand contact ----------
// A video is either for all sales (brand contact, or no contact part when there is none) or for one
// sales person ("Look for MISS JHAY" plus their own lines).

const TITLES = ['MISS', 'MS.', "MA'AM", 'SIR', 'MR.', ''];
const clean = (v, max = 120) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const cleanLines = (lines) => (Array.isArray(lines) ? lines : [])
  .map((l) => ({ label: clean(l?.label, 30), value: clean(l?.value) })).filter((l) => l.label && l.value).slice(0, 8);
const readPeople = () => { const p = readJson(peopleFile, []); return Array.isArray(p) ? p : []; };
const onScreen = (p) => `${p.title ? `${p.title} ` : ''}${p.name}`.trim();
function cleanPerson(p) {
  const title = TITLES.includes(String(p?.title || '').toUpperCase()) ? String(p.title).toUpperCase() : '';
  const pronoun = ['she', 'he', 'they'].includes(p?.pronoun) ? p.pronoun : /SIR|MR/.test(title) ? 'he' : title ? 'she' : 'they';
  return { id: /^[a-z0-9-]{6,40}$/.test(p?.id || '') ? p.id : randomUUID().slice(0, 8), title, name: clean(p?.name, 60), pronoun, lines: cleanLines(p?.lines) };
}
function savePerson(p) {
  const person = cleanPerson(p);
  if (!person.name) throw new Error('Give the sales person a name.');
  const list = readPeople().filter((x) => x.id !== person.id);
  const at = readPeople().findIndex((x) => x.id === person.id);
  list.splice(at < 0 ? list.length : at, 0, person);
  writeJson(peopleFile, list);
  return person;
}
// A CTA.txt like "MISS JHAY\nGLOBE: 0945…" becomes a sales person.
function personFromText(text) {
  let name = '';
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    const m = l.match(/^([^:]{1,30}):\s*(.+)$/);
    if (m) lines.push({ label: m[1].trim(), value: m[2].trim() });
    else if (!name) name = l;
  }
  const t = name.match(/^(MISS|MS\.?|MA'?AM|SIR|MR\.?)\s+(.+)$/i);
  const title = t ? ({ MS: 'MS.', MR: 'MR.', MAAM: "MA'AM" }[t[1].toUpperCase().replace(/[.']/g, '')] || t[1].toUpperCase()) : '';
  return { title, name: t ? t[2] : name, lines };
}
const readBrandContact = () => { const c = readJson(brandContactFile, null); return c && (c.name || c.lines?.length) ? c : null; };

// What the editor is told about the end of one video.
function contactPrompt(choice) {
  if (choice?.type === 'person') {
    const p = readPeople().find((x) => x.id === choice.id);
    if (p) {
      return `This video is for one sales person. Contact part: "Look for ${onScreen(p)}"` +
        `${p.lines.length ? `, then ${p.lines.map((l) => `${l.label}: ${l.value}`).join('; ')}` : ''}. ` +
        `Refer to them as ${{ she: 'she/her', he: 'he/him', they: 'they/them' }[p.pronoun]}.`;
    }
  }
  const c = readBrandContact();
  if (c) {
    return `This video is for all sales, not one person: no "Look for" name. Contact part: the brand contact, "${c.name}"` +
      `${c.lines?.length ? `, then ${c.lines.map((l) => `${l.label}: ${l.value}`).join('; ')}` : ''}.`;
  }
  return 'This video is for all sales and there is no brand contact: skip the contact part and go straight to the outro.';
}
function contactLabel(choice) {
  const p = choice?.type === 'person' && readPeople().find((x) => x.id === choice.id);
  return p ? `For ${onScreen(p)}` : 'For all sales';
}

function brandState() {
  const style = readText(styleFile);
  const broll = readdirSafe(brollDir).filter((n) => kindOf(n) === 'video').map((name) => {
    const full = join(brollDir, name);
    const st = statSync(full);
    preview(full, st);
    return { name, category: name.match(BROLL_RE)?.[1]?.toLowerCase() || 'other', size: st.size, mtime: st.mtimeMs, ...probe(full, st.mtimeMs) };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sounds = listFolder('sounds').filter((f) => f.kind === 'audio');
  const logo = slotFile('logo');
  const social = slotFile('social');
  const people = readPeople();
  const contact = readBrandContact();
  const needs = styleNeeds(style);
  const has = {
    logo: Boolean(logo), social: Boolean(social), broll: broll.length > 0, music: sounds.length > 0,
    details: Boolean(contact || people.length),
  };
  const styleCats = styleCategories(style);
  return {
    logo: logo && { name: logo, mtime: statSync(join(dirs.brand, logo)).mtimeMs },
    social: social && { name: social, mtime: statSync(join(dirs.brand, social)).mtimeMs },
    broll, people: people.map((p) => ({ ...p, onScreen: onScreen(p) })), contact, needs, has,
    categories: [...new Set([...(styleCats.length ? styleCats : DEFAULT_CATEGORIES), ...broll.map((b) => b.category)])],
    pack: readJson(packFile, null),
    brandRules: Boolean(readText(brandRulesFile)?.trim()),
    sizes: { broll: broll.reduce((s, b) => s + b.size, 0), music: sounds.reduce((s, f) => s + f.size, 0) },
  };
}
const locked = () => existsSync(packFile);

// ---------- brand pack: a plain tar file named <brand>.brandpack ----------

function tarHeader(name, size, mtime = Date.now()) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const PACK_PATHS = [
  /^pack\.json$/, /^style\.md$/, /^brand-rules\.md$/, /^contact\.json$/, /^people\.json$/, /^logo\.(png|jpe?g|webp|gif|svg)$/i, /^social\.(png|jpe?g|webp|gif)$/i,
  /^broll\/broll_[a-z0-9-]+_\d+\.(mp4|mov|m4v|webm|mkv)$/i, /^music\/\d+\.(mp3|wav|m4a|aac|ogg|flac)$/i,
];

async function exportPack(res, { name, broll, music, people }) {
  const entries = [];
  const add = (path, file) => existsSync(file) && entries.push({ path, file, size: statSync(file).size, mtime: statSync(file).mtimeMs });
  add('style.md', styleFile);
  add('contact.json', brandContactFile);
  if (people) add('people.json', peopleFile);
  const rules = [readText(brandRulesFile), readText(join(root, 'my-rules.md'))].filter((t) => t?.trim()).join('\n\n');
  const logo = slotFile('logo');
  const social = slotFile('social');
  if (logo) add(`logo${extname(logo).toLowerCase()}`, join(dirs.brand, logo));
  if (social) add(`social${extname(social).toLowerCase()}`, join(dirs.brand, social));
  if (broll) for (const n of readdirSafe(brollDir)) if (BROLL_RE.test(n) && kindOf(n) === 'video') add(`broll/${n}`, join(brollDir, n));
  const musicNames = {};
  if (music) {
    listFolder('sounds').filter((f) => f.kind === 'audio').forEach((f, i) => {
      const path = `music/${String(i + 1).padStart(2, '0')}${extname(f.name).toLowerCase()}`;
      musicNames[path] = f.name;
      add(path, f.folder ? join(dirs.sounds, f.folder, f.name) : join(dirs.sounds, f.name));
    });
  }
  const manifest = Buffer.from(JSON.stringify({ format: 1, name, createdAt: Date.now(), includes: { broll, music, people }, musicNames }, null, 2));
  const file = `${name.replace(/[^\w .-]+/g, '').trim() || 'brand'}.brandpack`;
  res.writeHead(200, { 'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${file}"` });
  const write = async (buf) => { if (!res.write(buf)) await once(res, 'drain'); };
  const pad = (n) => (512 - (n % 512)) % 512;
  await write(tarHeader('pack.json', manifest.length)); await write(manifest); await write(Buffer.alloc(pad(manifest.length)));
  if (rules) { const b = Buffer.from(rules); await write(tarHeader('brand-rules.md', b.length)); await write(b); await write(Buffer.alloc(pad(b.length))); }
  for (const e of entries) {
    await write(tarHeader(e.path, e.size, e.mtime));
    for await (const chunk of createReadStream(e.file)) await write(chunk);
    await write(Buffer.alloc(pad(e.size)));
  }
  res.end(Buffer.alloc(1024));
}

// Reads the pack's table of contents, keeping only the paths a pack may contain.
function readPack(file) {
  const fd = openSync(file, 'r');
  try {
    const total = statSync(file).size;
    const entries = [];
    const h = Buffer.alloc(512);
    for (let pos = 0; pos + 512 <= total;) {
      readSync(fd, h, 0, 512, pos);
      if (h.every((b) => b === 0)) break;
      const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim(), 8) || 0;
      const start = pos + 512;
      if (h[156] === 48 || h[156] === 0) if (PACK_PATHS.some((re) => re.test(name))) entries.push({ name, start, size });
      pos = start + size + ((512 - (size % 512)) % 512);
    }
    const man = entries.find((e) => e.name === 'pack.json');
    if (!man || !entries.some((e) => e.name === 'style.md')) return null;
    const buf = Buffer.alloc(man.size);
    readSync(fd, buf, 0, man.size, man.start);
    const manifest = JSON.parse(buf.toString('utf8'));
    return manifest?.format === 1 ? { manifest, entries } : null;
  } catch { return null; } finally { closeSync(fd); }
}

async function importPack(tmp) {
  const pack = readPack(tmp);
  if (!pack) throw new Error('That file is not a brand pack. Ask for the file that ends in .brandpack.');
  const { manifest, entries } = pack;
  const brandName = String(manifest.name || 'brand').slice(0, 60);
  // Unpack everything into a staging folder first, so a broken file changes nothing.
  const stage = `${tmp}-files`;
  mkdirSync(join(stage, 'broll'), { recursive: true });
  mkdirSync(join(stage, 'music'), { recursive: true });
  try {
    for (const e of entries) {
      if (e.name === 'pack.json') continue;
      const dest = join(stage, e.name.toLowerCase());
      if (e.size) await pipeline(createReadStream(tmp, { start: e.start, end: e.start + e.size - 1 }), createWriteStream(dest));
      else writeFileSync(dest, '');
    }
    for (const d of [dirs.brand, brollDir]) mkdirSync(d, { recursive: true });
    const has = (prefix) => entries.some((e) => e.name.startsWith(prefix));
    if (existsSync(styleFile)) copyFileSync(styleFile, `${styleFile}.bak`);
    copyFileSync(join(stage, 'style.md'), styleFile);
    if (has('brand-rules.md')) copyFileSync(join(stage, 'brand-rules.md'), brandRulesFile); else rmSync(brandRulesFile, { force: true });
    if (has('contact.json')) {
      const c = readJson(join(stage, 'contact.json'), null);
      if (c) writeJson(brandContactFile, { name: clean(c.name, 80), lines: cleanLines(c.lines) });
    }
    // The team's sales people join this computer's list; people already here keep their details.
    if (has('people.json')) {
      const incoming = readJson(join(stage, 'people.json'), []);
      const here = new Set(readPeople().map(onScreen));
      const add = (Array.isArray(incoming) ? incoming : []).map((x) => cleanPerson({ ...x, id: null })).filter((x) => x.name && !here.has(onScreen(x)));
      if (add.length) writeJson(peopleFile, [...readPeople(), ...add]);
    }
    for (const slot of ['logo', 'social']) {
      const f = readdirSafe(stage).find((n) => n.startsWith(`${slot}.`));
      if (!f) continue;
      for (const n of readdirSafe(dirs.brand)) if (n.toLowerCase().startsWith(`${slot}.`)) rmSync(join(dirs.brand, n), { force: true });
      copyFileSync(join(stage, f), join(dirs.brand, f));
    }
    if (manifest.includes?.broll) {
      for (const n of readdirSafe(brollDir)) rmSync(join(brollDir, n), { force: true });
      for (const n of readdirSafe(join(stage, 'broll'))) renameSync(join(stage, 'broll', n), join(brollDir, n));
    }
    const music = readdirSafe(join(stage, 'music'));
    if (music.length) {
      const musicDir = join(dirs.sounds, safeName(brandName.replace(/[\\/:*?"<>|]/g, '_')) || 'brand');
      mkdirSync(musicDir, { recursive: true });
      for (const n of music) renameSync(join(stage, 'music', n), join(musicDir, safeName(String(manifest.musicNames?.[`music/${n}`] || '')) || n));
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
  writeJson(packFile, { name: brandName, createdAt: manifest.createdAt || null, importedAt: Date.now() });
  return { name: brandName };
}

// Video length, cached by name + mtime.
const metaCache = new Map();
function probe(full, mtime) {
  const key = `${full}:${mtime}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height:stream_side_data=rotation',
    '-of', 'json', full], { encoding: 'utf8' });
  let meta = {};
  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams?.[0] || {};
    const rot = Math.abs(Number(s.side_data_list?.find((d) => 'rotation' in d)?.rotation || 0));
    const [w, h] = rot === 90 || rot === 270 ? [s.height, s.width] : [s.width, s.height];
    meta = { duration: Number(j.format?.duration) || 0, width: w, height: h };
  } catch {}
  metaCache.set(key, meta);
  return meta;
}

// Thumbnails are made one or two at a time so a full inbox does not start a dozen ffmpegs.
const thumbQueue = [];
let thumbsRunning = 0;
function thumbnail(full, mtime) {
  const file = join(thumbsDir, `${slugify(basename(full))}-${Math.round(mtime)}.jpg`);
  if (existsSync(file)) return Promise.resolve(file);
  return new Promise((done) => { thumbQueue.push({ full, file, done }); pumpThumbs(); });
}
function pumpThumbs() {
  while (thumbsRunning < 2 && thumbQueue.length) {
    const { full, file, done } = thumbQueue.shift();
    thumbsRunning++;
    const p = spawn('ffmpeg', ['-y', '-v', 'error', '-ss', '0.8', '-i', full, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', file]);
    p.on('error', () => {});
    p.on('close', () => { thumbsRunning--; done(existsSync(file) ? file : null); pumpThumbs(); });
  }
}

// Hover previews: a small H.264 + AAC MP4 of the first 10 seconds, so phone MOVs (often HEVC)
// play in any browser and start at once. Each is made once. A hovered clip jumps the line; the
// rest are made in the background only while the editor is idle.
const PREVIEW_TAG = '720a';
for (const n of readdirSafe(previewsDir)) if (!n.endsWith(`-${PREVIEW_TAG}.mp4`)) rmSync(join(previewsDir, n), { force: true });
const previewJobs = new Map();
const previewQueue = [];
let previewsRunning = 0;
function preview(full, { size, mtimeMs }, urgent = false) {
  const file = join(previewsDir, `${slugify(basename(full))}-${size}-${Math.round(mtimeMs)}-${PREVIEW_TAG}.mp4`);
  if (existsSync(file)) return Promise.resolve(file);
  const queued = previewJobs.get(file);
  if (queued) {
    if (urgent && !queued.item.urgent) {
      queued.item.urgent = true;
      const i = previewQueue.indexOf(queued.item);
      if (i > 0) previewQueue.unshift(...previewQueue.splice(i, 1));
      pumpPreviews();
    }
    return queued.promise;
  }
  let done;
  const promise = new Promise((r) => { done = r; });
  const item = { full, file, done, urgent };
  previewJobs.set(file, { promise, item });
  if (urgent) previewQueue.unshift(item); else previewQueue.push(item);
  pumpPreviews();
  return promise;
}
function pumpPreviews() {
  while (previewsRunning < 2) {
    const i = previewQueue.findIndex((x) => x.urgent || !job);
    if (i < 0) return;
    const [it] = previewQueue.splice(i, 1);
    previewsRunning++;
    const tmp = `${it.file}.part.mp4`;
    const p = spawn('ffmpeg', ['-y', '-v', 'error', '-t', '10', '-i', it.full, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:720,fps=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart', tmp]);
    p.on('error', () => {});
    p.on('close', (code) => {
      previewsRunning--;
      const ok = code === 0 && existsSync(tmp);
      if (ok) renameSync(tmp, it.file); else rmSync(tmp, { force: true });
      previewJobs.delete(it.file);
      it.done(ok ? it.file : null);
      pumpPreviews();
    });
  }
}

// ---------- projects ----------
// A project is one edit: drafts land in outbox/<slug>-v1.mp4, -v2.mp4, -final.mp4,
// -horizontal-v1.mp4, and so on. Records in .webapp/projects keep the Claude session and the
// conversation so notes continue where the edit left off. Projects edited from the terminal
// (outbox files with no record) show up too.

const VERSION_RE = /^(.+?)-((?:horizontal-)?(?:v\d+|final))\.mp4$/i;
const projectFile = (slug) => join(projectsDir, `${slug}.json`);
const loadProject = (slug) => readJson(projectFile(slug), null);
const saveProject = (p) => writeJson(projectFile(p.slug), p);

function versionsBySlug() {
  const map = new Map();
  for (const f of listFolder('outbox')) {
    const m = f.name.match(VERSION_RE);
    if (!m) continue;
    const [, slug, label] = m;
    if (!map.has(slug)) map.set(slug, []);
    map.get(slug).push({ file: f.name, label: label.toLowerCase(), mtime: f.mtime, size: f.size });
  }
  const order = (l) => (l.startsWith('horizontal') ? 1000 : 0) + (l.endsWith('final') ? 500 : Number(l.match(/\d+/)?.[0] || 0));
  for (const list of map.values()) list.sort((a, b) => order(a.label) - order(b.label));
  return map;
}

// What the editor could not do, from the "## Not done" part of the project's VERIFY.md, which the
// app asks for in plain words. Older reports ("Spec items not met") are technical, so they become
// one plain line instead of being shown as written.
function notDone(slug) {
  const text = readText(join(root, 'kit', 'video-projects', slug, 'VERIFY.md'));
  if (!text) return [];
  const plain = [];
  const legacy = [];
  let inside = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) {
      inside = /^not done\s*$/i.test(h[1].trim()) ? plain : /not (met|done)|could ?n[o']?t|missing|skipped|left out/i.test(h[1]) ? legacy : null;
      continue;
    }
    const b = inside && line.match(/^\s*[-*]\s+(.*)$/);
    if (b) inside.push(b[1].trim());
  }
  if (plain.length) return plain.slice(0, 12);
  if (!legacy.length) return [];
  const all = legacy.join(' ');
  const missing = [[/b-?roll/i, 'B-roll'], [/music/i, 'music'], [/screenshot|social/i, 'a social page screenshot'], [/logo/i, 'a logo']]
    .filter(([re]) => re.test(all)).map(([, label]) => label);
  return [
    ...(missing.length ? [`Your style asks for ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')}, but there was none to use. Add them in My brand.`] : []),
    'The editor left a few small style details out. Send a note if something looks off.',
  ];
}

function listProjects() {
  const versions = versionsBySlug();
  const slugs = new Set([...versions.keys()]);
  for (const f of readdirSync(projectsDir)) if (f.endsWith('.json')) slugs.add(f.slice(0, -5));
  return [...slugs].map((slug) => {
    const rec = loadProject(slug) || { slug, history: [], fromTerminal: true };
    const v = versions.get(slug) || [];
    const updated = Math.max(rec.updatedAt || 0, ...v.map((x) => x.mtime));
    const { lastRequest, ...pub } = rec;
    return {
      ...pub, slug, versions: v, updatedAt: updated, title: rec.title || prettyTitle(slug),
      sources: rec.sources || (rec.source ? [rec.source] : terminalSources(slug)), notDone: v.length ? notDone(slug) : [], canRetry: Boolean(lastRequest),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}
// A project edited in the terminal has no record of its clips; match its assets/raw copies
// to inbox names ("IMG_3893_2.MOV" is a copy of "IMG_3893 2.MOV").
function terminalSources(slug) {
  const raw = readdirSafe(join(root, 'kit', 'video-projects', slug, 'assets', 'raw')).filter((n) => kindOf(n) === 'video').map(slugify);
  if (!raw.length) return [];
  return listInbox().files.filter((f) => f.kind === 'video' && raw.includes(slugify(f.name))).map((f) => f.path);
}
const prettyTitle = (slug) => slug.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function nextVersion(slug, horizontal = false) {
  const nums = (versionsBySlug().get(slug) || [])
    .filter((v) => v.label.startsWith('horizontal') === horizontal)
    .map((v) => Number(v.label.match(/v(\d+)/)?.[1] || 0));
  return Math.max(0, ...nums) + 1;
}

function newSlug(fileName) {
  const base = `${slugify(fileName)}-${today()}`;
  let slug = base;
  for (let i = 2; existsSync(projectFile(slug)) || versionsBySlug().has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

// ---------- the editing job (one at a time) ----------

const APP_NOTE = [
  'You are running headless from the free247editor web app. The user sees your progress in the app,',
  'not in a terminal. Do not open videos or files with open/start/xdg-open; the app plays them.',
  'Do not stop to ask questions mid-run: pick sensible defaults from my-style.md, my-rules.md and',
  'CLAUDE.md. If something truly needs the user, finish what you can and ask in your final message.',
  'Your final message is shown to the user as-is: plain words, 3 to 5 short bullets, no file paths',
  'unless they help. Never ask for approval to use the free local pipeline.',
  'When you write VERIFY.md, put anything the style asked for that you could not do under a heading named',
  'exactly "## Not done", one short plain-words bullet each, saying what the user could add or change',
  '(for example: "No B-roll of the showroom yet. Add some in My brand.").',
].join(' ');

const noteFile = join(data, 'app-note.txt');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let job = null; // { id, kind, slug, title, steps, todos, startedAt, proc, sessionId }
const clients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
const publicJob = () => job && {
  id: job.id, kind: job.kind, slug: job.slug, title: job.title, steps: job.steps.slice(-60),
  todos: job.todos, startedAt: job.startedAt, stopping: job.stopping || false,
};

let stateTimer = null;
const pushState = () => { clearTimeout(stateTimer); stateTimer = setTimeout(() => broadcast('state', getState()), 150); };

// Turns a tool call into a step the user can understand.
function describeTool(name, input = {}) {
  const cmd = String(input.command || '');
  const file = String(input.file_path || input.path || '');
  if (name === 'Bash') {
    if (/transcribe/.test(cmd)) return 'Listening to the video and writing down every word';
    if (/new-video/.test(cmd)) return 'Starting a new project';
    if (/hyperframes\s+render|render\b.*--quality/.test(cmd)) return 'Rendering the video (this is the slow part)';
    if (/cut-silence|silence/.test(cmd)) return 'Cutting pauses and dead air';
    if (/cut-mistake|retake/.test(cmd)) return 'Removing mistakes and retakes';
    if (/validate|preflight|lint|check/.test(cmd)) return 'Double-checking the edit';
    if (/outbox/.test(cmd) && /\b(cp|copy|Copy-Item)\b/.test(cmd)) return 'Saving the video to your outbox';
    if (/ffmpeg|ffprobe/.test(cmd)) return input.description || 'Processing the footage';
    return input.description || 'Working';
  }
  if (name === 'Read') {
    if (/my-style|my-rules/.test(file)) return 'Reading your style and rules';
    if (/SKILL\.md|CLAUDE\.md/.test(file)) return 'Reading the editing playbook';
    if (/\.json$/.test(file) && /raw/.test(file)) return 'Reading the transcript';
    return null;
  }
  if (name === 'Write' || name === 'Edit') {
    if (/my-rules\.md$/.test(file)) return 'Saving a new rule';
    if (/my-style\.md$/.test(file)) return 'Updating your style';
    if (/\.html$/.test(file)) return 'Designing captions and motion graphics';
    return 'Building the edit';
  }
  if (name === 'Skill') return 'Opening the editing playbook';
  return null;
}

function addStep(label, kind = 'step') {
  if (!job || !label) return;
  const last = job.steps[job.steps.length - 1];
  if (last && last.label === label && last.kind === kind) return;
  job.steps.push({ label, kind, at: Date.now() });
  broadcast('job', publicJob());
}

function handleEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'init' && UUID_RE.test(ev.session_id || '')) job.sessionId = ev.session_id;
  if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_use') {
        if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
          job.todos = c.input.todos.map((t) => ({ text: t.content || t.activeForm || '', status: t.status }));
          broadcast('job', publicJob());
        } else {
          addStep(describeTool(c.name, c.input));
        }
      } else if (c.type === 'text' && c.text?.trim()) {
        job.lastText = c.text.trim();
        const line = job.lastText.split('\n').find((l) => l.trim())?.trim();
        if (line && line.length < 160) addStep(line.replace(/[*_`#]/g, ''), 'say');
      }
    }
  }
  if (ev.type === 'result') {
    job.result = { text: ev.result || job.lastText || '', error: ev.is_error || ev.subtype !== 'success' };
    if (UUID_RE.test(ev.session_id || '')) job.sessionId = ev.session_id;
  }
}

function startJob({ kind, slug = null, title, prompt, resume = null }) {
  if (job) return { error: 'The editor is already working on something. Wait for it to finish, or stop it.' };
  const s = getSettings();
  writeFileSync(noteFile, APP_NOTE);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', s.permissionMode,
    '--append-system-prompt-file', noteFile];
  if (s.model) args.push('--model', s.model);
  if (resume && UUID_RE.test(resume)) args.push('--resume', resume);
  const rulesBefore = statSafe(join(root, 'my-rules.md'));

  // The prompt goes through stdin so no user text is ever part of a command line. On Windows,
  // claude may be a .cmd shim that needs a shell; every argument above is a fixed or validated value.
  const proc = win
    ? spawn('claude', args.map((a) => (a === noteFile ? `"${a}"` : a)), { cwd: root, shell: true, windowsHide: true })
    : spawn('claude', args, { cwd: root, detached: true });
  const versionsBefore = slug ? (versionsBySlug().get(slug) || []).map((v) => `${v.file}:${v.mtime}`).join() : '';
  job = { id: randomUUID(), kind, slug, title, steps: [], todos: [], startedAt: Date.now(), proc, sessionId: resume, rulesBefore, versionsBefore };
  addStep({ edit: 'Getting your clips ready', style: 'Updating your style', setup: 'Checking this computer', final: 'Getting the final ready', horizontal: 'Planning the YouTube version' }[kind] || 'Reading your notes');
  proc.stdin.end(prompt);

  let buf = '';
  let errText = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line)); } catch {}
    }
  });
  proc.stderr.on('data', (c) => { errText = (errText + c).slice(-4000); });
  proc.on('error', (e) => { errText = e.code === 'ENOENT' ? 'CLAUDE_MISSING' : e.message; });
  proc.on('close', (code) => finishJob(code, errText));
  pushState();
  return { ok: true, id: job.id };
}

function statSafe(f) { try { return statSync(f).mtimeMs; } catch { return 0; } }

function finishJob(code, errText) {
  const j = job;
  if (!j) return;
  job = null;
  let text = j.result?.text || '';
  let error = j.stopping ? false : Boolean(j.result?.error || (code !== 0 && !text));
  if (j.stopping) text = 'Stopped. Nothing after the last saved version was kept.';
  else if (errText === 'CLAUDE_MISSING') text = 'Claude Code was not found on this computer. Open Setup to fix it.';
  else if (error && !text) text = `The editor stopped unexpectedly.\n\n${errText.trim().split('\n').slice(-6).join('\n')}`;

  const ruleSaved = statSafe(join(root, 'my-rules.md')) > (j.rulesBefore || 0);
  const newVersion = Boolean(j.slug) && (versionsBySlug().get(j.slug) || []).map((v) => `${v.file}:${v.mtime}`).join() !== j.versionsBefore;
  if (j.slug) {
    const p = loadProject(j.slug) || { slug: j.slug, history: [] };
    p.sessionId = j.sessionId || p.sessionId;
    p.history.push({ role: 'editor', text, error, stopped: Boolean(j.stopping), at: Date.now(), steps: j.steps.length });
    p.status = error ? 'error' : 'ready';
    p.updatedAt = Date.now();
    saveProject(p);
  }
  if (j.kind === 'style') writeJson(join(data, 'style-reply.json'), { text, error, at: Date.now() });
  if (j.kind === 'setup') { writeJson(join(data, 'setup-reply.json'), { text, error, at: Date.now() }); toolCache = null; }
  broadcast('done', { id: j.id, slug: j.slug, kind: j.kind, error, text, ruleSaved, newVersion });
  pushState();
  setTimeout(nextInQueue, 800);
}

// ---------- the line (queue) ----------
// Requests wait here while the editor is busy. Prompts are built when a request starts, so notes
// queued behind each other get the right next version number and the latest Claude session.

const queueFile = join(data, 'queue.json');
let queue = readJson(queueFile, []);
const saveQueue = () => writeJson(queueFile, queue);
const publicQueue = () => queue.map(({ id, type, slug, title }) => ({ id, type, slug, title }));

function buildJob(req) {
  const p = req.slug ? listProjects().find((x) => x.slug === req.slug) : null;
  if (req.slug && !p) return null;
  const ctx = p ? contextFor(p) : '';
  const resume = p?.sessionId || null;
  const base = { kind: req.type, slug: req.slug || null, title: p?.title || req.title, resume };
  if (req.type === 'edit') return { ...base, prompt: req.prompt, resume: null };
  if (req.type === 'notes') {
    const horizontal = Boolean(req.horizontal);
    const out = `outbox/${req.slug}-${horizontal ? 'horizontal-' : ''}v${nextVersion(req.slug, horizontal)}.mp4`;
    const watching = safeName(req.watching || '');
    return { ...base, prompt: `${ctx}Notes on the latest ${horizontal ? 'horizontal ' : ''}draft of ${req.slug}:\n${req.text}\n\n` +
      `${watching ? `Times in these notes (like "at 0:07") are from outbox/${watching}. ` : ''}` +
      `Apply them, then render and save the next version as ${out}. Follow "Notes become rules" in CLAUDE.md.` };
  }
  if (req.type === 'final') {
    return { ...base, prompt: `${ctx}Approved, final. Render ${req.slug} at final quality to outbox/${req.slug}-final.mp4` +
      `${p.versions.some((v) => v.label.startsWith('horizontal')) ? `, and the horizontal version to outbox/${req.slug}-horizontal-final.mp4` : ''}.` };
  }
  if (req.type === 'horizontal') {
    return { ...base, prompt: `${ctx}Make a horizontal version for YouTube of ${req.slug}, as CLAUDE.md describes (its own 1920x1080 framing and ` +
      `text placement, not a crop). Save it as outbox/${req.slug}-horizontal-v${nextVersion(req.slug, true)}.mp4.` };
  }
  if (req.type === 'style') {
    if (locked()) return null;
    return { ...base, title: 'Your style', prompt: 'Update my-style.md with this change to my style. Keep everything else as it is, ' +
      `and keep the file's existing format. Do not edit any video. The change: ${req.text}` };
  }
  if (req.type === 'setup') {
    return { ...base, title: 'Setup', prompt: [
      'The user clicked "Fix it for me" on the Setup page of the free247editor app.',
      'Follow the "When the user says start" steps in CLAUDE.md, with these changes:',
      'the click is the user\'s OK to install anything setup reports missing, using the install command it prints',
      '(Homebrew on Mac, winget on Windows). If Homebrew or winget itself is missing, stop and explain in plain words how to get it.',
      'If the test render fails, run `npx hyperframes doctor` in kit/video-projects/demo and fix what it reports.',
      'Skip the transcription choice and style setup, and do not open any files.',
      'End with up to 3 short bullets: what you fixed, and anything the user still has to do themselves.',
    ].join(' ') };
  }
  return null;
}

function runRequest(req) {
  const spec = buildJob(req);
  if (!spec) return { error: 'That is not here anymore.' };
  const r = startJob(spec);
  if (r.error) return r;
  if (req.slug) {
    const rec = loadProject(req.slug) || { slug: req.slug, history: [], createdAt: Date.now() };
    rec.status = 'working';
    rec.lastRequest = req;
    rec.updatedAt = Date.now();
    saveProject(rec);
  }
  return r;
}

// Starts now when the editor is free, otherwise waits in line.
function request(req) {
  req.id ||= randomUUID();
  if (req.slug && !req.title) req.title = loadProject(req.slug)?.title || prettyTitle(req.slug);
  if (job && req.type === 'setup') return { error: 'The editor is busy. Try again when it has finished.' };
  if (!job && !queue.length) return { ...runRequest(req), started: true };
  queue.push(req);
  saveQueue();
  if (!job) nextInQueue();
  pushState();
  const ahead = queue.findIndex((q) => q.id === req.id);
  return ahead < 0 ? { ok: true, started: true } : { ok: true, queued: true, ahead: ahead + 1 };
}

function nextInQueue() {
  while (!job && queue.length) {
    const req = queue.shift();
    saveQueue();
    if (!runRequest(req).error) break;
    if (req.slug) { const rec = loadProject(req.slug); if (rec) { rec.status = 'ready'; saveProject(rec); } }
  }
  pushState();
}

function removeFromQueue(id) {
  const req = queue.find((q) => q.id === id);
  if (!req) return false;
  queue = queue.filter((q) => q.id !== id);
  saveQueue();
  if (req.slug) {
    const rec = loadProject(req.slug);
    if (rec) {
      const hasVersions = (versionsBySlug().get(req.slug) || []).length;
      if (req.type === 'edit' && !hasVersions && !rec.lastRequest) rmSync(projectFile(req.slug), { force: true });
      else {
        rec.history = (rec.history || []).filter((m) => m.queuedId !== id);
        if (!queue.some((q) => q.slug === req.slug)) rec.status = 'ready';
        saveProject(rec);
      }
    }
  }
  pushState();
  return true;
}

// Records what the person asked on the project's conversation.
function noteAsked(slug, text, r, req) {
  const rec = loadProject(slug) || { slug, history: [], createdAt: Date.now() };
  rec.history.push({ role: 'you', text, at: Date.now(), ...(r.queued ? { queuedId: req.id } : {}) });
  if (r.queued) rec.status = 'queued';
  rec.updatedAt = Date.now();
  saveProject(rec);
}

function stopJob() {
  if (!job) return;
  job.stopping = true;
  addStep('Stopping…', 'say');
  try {
    if (win) spawnSync('taskkill', ['/pid', String(job.proc.pid), '/T', '/F']);
    else process.kill(-job.proc.pid, 'SIGTERM');
  } catch { try { job.proc.kill(); } catch {} }
}

// A project from the terminal has no session, so a fresh session gets enough context to continue.
function contextFor(p) {
  if (p.sessionId) return '';
  const latest = p.versions?.filter((v) => !v.label.startsWith('horizontal')).at(-1);
  return `This is the existing project "${p.slug}" (kit/video-projects/${p.slug}, drafts in outbox/${p.slug}-v*.mp4` +
    `${latest ? `, latest is outbox/${latest.file}` : ''}). Read its files first to see how it was built. `;
}

// ---------- setup status ----------

let toolCache = null;
function checkTools(force = false) {
  if (toolCache && !force) return toolCache;
  const claudeOk = ok('claude', ['--version']);
  toolCache = {
    node: Number(process.versions.node.split('.')[0]) >= 22,
    git: ok('git', ['--version']),
    ffmpeg: ok('ffmpeg', ['-version']) && ok('ffprobe', ['-version']),
    claude: claudeOk,
    chrome: chromeFound(),
    localWhisper: ok('python3', ['-c', 'import faster_whisper']) || ok('python', ['-c', 'import faster_whisper']),
  };
  return toolCache;
}
// HyperFrames renders with Chrome: an installed Chrome, or the headless copy it downloads to ~/.cache/hyperframes.
function chromeFound() {
  const env = process.env;
  const paths = win
    ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return paths.some((p) => existsSync(p)) || readdirSafe(join(homedir(), '.cache', 'hyperframes', 'chrome')).length > 0;
}
function setupStatus() {
  const t = checkTools();
  return {
    ...t,
    nodeVersion: process.versions.node,
    kit: existsSync(join(root, 'kit', 'node_modules', 'hyperframes')),
    groq: envHasGroq(),
    style: existsSync(join(root, 'my-style.md')),
    rules: existsSync(join(root, 'my-rules.md')),
    testVideo: existsSync(join(dirs.outbox, 'setup-test.mp4')),
    platform: process.platform,
  };
}

function getState() {
  const { files: inbox, folders } = listInbox();
  for (const f of inbox) if (f.kind === 'video') preview(inboxFull(f.path), { size: f.size, mtimeMs: f.mtime });
  const projects = listProjects();
  const used = new Set(projects.flatMap((p) => p.sources));
  for (const f of inbox) f.edited = used.has(f.path);
  return {
    setup: setupStatus(),
    settings: getSettings(),
    inbox,
    folders,
    sounds: listFolder('sounds'),
    outbox: listFolder('outbox').filter((f) => f.kind === 'video'),
    projects,
    brand: brandState(),
    job: publicJob(),
    queue: publicQueue(),
    setupReply: readJson(join(data, 'setup-reply.json'), null),
  };
}

// ---------- setup runner (node setup.mjs) ----------

let setupRun = null;
function runSetup() {
  if (setupRun) return { error: 'Setup is already running.' };
  setupRun = { lines: [], startedAt: Date.now() };
  const p = spawn(process.execPath, [join(root, 'setup.mjs')], { cwd: root });
  const push = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) setupRun.lines.push(line);
    setupRun.lines = setupRun.lines.slice(-200);
    broadcast('setup', { running: true, lines: setupRun.lines });
  };
  p.stdout.on('data', push);
  p.stderr.on('data', push);
  p.on('close', (code) => {
    const lines = setupRun.lines;
    setupRun = null;
    toolCache = null;
    broadcast('setup', { running: false, ok: code === 0, lines });
    pushState();
  });
  return { ok: true };
}

// ---------- style wizard ----------

function styleFromWizard(a) {
  const line = (label, v) => (v ? `- ${label}: ${v}` : null);
  return [
    '# My style', '', `Written with the free247editor app on ${today()}. Rules in my-rules.md win over this.`, '',
    line('Format', a.format), line('Captions', a.captions), line('Caption position', a.position),
    line('Caption colors', a.colors + (a.brandColor ? ` (${a.brandColor})` : '')), line('Hook', a.hook),
    line('Pace', a.pace), line('Graphics', a.graphics), line('Color look', a.color), line('Sound', a.sound),
    a.extra ? `- Also: ${a.extra}` : null, '',
  ].filter((l) => l !== null).join('\n');
}

// ---------- http ----------

async function body(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function serveFile(req, res, file, cache = false) {
  let st; try { st = statSync(file); } catch { res.writeHead(404); return res.end(); }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache ? 'max-age=86400' : 'no-cache' };
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function reveal(full) {
  if (win) spawn('explorer', [`/select,${full}`], { detached: true }).unref();
  else if (process.platform === 'darwin') spawn('open', ['-R', full], { detached: true }).unref();
  else spawn('xdg-open', [dirname(full)], { detached: true }).unref();
}

let port = Number(process.env.PORT) || 4747;
const allowedHost = (h) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h || '');

const server = createServer(async (req, res) => {
  // Only this computer's browser: blocks other sites from reaching the app through DNS tricks.
  if (!allowedHost(req.headers.host)) { res.writeHead(403); return res.end('Forbidden'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !allowedHost(origin.replace(/^https?:\/\//, ''))) { res.writeHead(403); return res.end('Forbidden'); }
  }
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  try {
    // Media and thumbnails: /media/<area>/<name>, /thumb/<area>/<name>
    let m;
    if ((m = path.match(/^\/(media|thumb|preview)\/(inbox|outbox|sounds|brand)\/(?:([^/]+)\/)?([^/]+)$/))) {
      const [, what, area, folder, raw] = m;
      const name = safeName(raw);
      if (!name || (folder && !safeName(folder))) { res.writeHead(400); return res.end(); }
      const full = folder ? join(dirs[area], folder, name) : join(dirs[area], name);
      if (what === 'media') return serveFile(req, res, full);
      const st = statSync(full);
      if (what === 'preview') {
        if (kindOf(name) !== 'video') { res.writeHead(400); return res.end(); }
        const pv = await preview(full, st, true);
        if (!pv) { res.writeHead(404); return res.end(); }
        return serveFile(req, res, pv, true);
      }
      const t = await thumbnail(full, st.mtimeMs);
      if (!t) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, t, true);
    }

    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(getState())}\n\n`);
      if (setupRun) res.write(`event: setup\ndata: ${JSON.stringify({ running: true, lines: setupRun.lines })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (path === '/api/state') return send(res, 200, getState());

    if (path === '/api/upload' && req.method === 'PUT') {
      const to = url.searchParams.get('to');
      const area = ['sounds', 'brand'].includes(to) ? to : 'inbox';
      let name = safeName(url.searchParams.get('name')?.replace(/[\\/:*?"<>|]/g, '_'));
      if (!name) return send(res, 400, { error: 'That file name will not work. Rename it and try again.' });
      const ext = extname(name).toLowerCase();
      let dir = dirs[area];
      let replaceSlot = null;
      if (area === 'brand') {
        // Brand files get fixed names the editor can rely on: logo.png, social.jpg, broll/broll_<category>_07.mov.
        const slot = url.searchParams.get('slot');
        if (slot === 'logo' || slot === 'social') {
          if (kindOf(name) !== 'image') return send(res, 400, { error: 'That needs to be a picture (PNG, JPG or WebP).' });
          name = `${slot}${ext}`; replaceSlot = slot;
        } else if (slot === 'broll') {
          if (kindOf(name) !== 'video') return send(res, 400, { error: `${name} is not a video, so it cannot be B-roll.` });
          const cat = slugify(url.searchParams.get('category') || '') || 'other';
          dir = brollDir;
          const nums = readdirSafe(brollDir).map((n) => n.match(BROLL_RE)).filter((x) => x && x[1].toLowerCase() === cat).map((x) => Number(x[2]));
          name = `broll_${cat}_${String(Math.max(0, ...nums) + 1).padStart(2, '0')}${ext}`;
        } else return send(res, 400, { error: 'Unknown brand slot.' });
      } else {
        const folder = area === 'inbox' && folderName(url.searchParams.get('folder'));
        if (folder) { dir = join(dirs.inbox, folder); mkdirSync(dir, { recursive: true }); }
        name = freeName(dir, name);
      }
      const tmp = join(dir, `.uploading-${randomUUID()}`);
      const out = createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', () => {
        if (replaceSlot) for (const n of readdirSafe(dir)) if (n.toLowerCase().startsWith(`${replaceSlot}.`)) rmSync(join(dir, n), { force: true });
        renameSync(tmp, join(dir, name)); pushState(); send(res, 200, { ok: true, name });
      });
      out.on('error', () => { rmSync(tmp, { force: true }); send(res, 500, { error: 'Could not save the file. Is the disk full?' }); });
      req.on('aborted', () => { out.destroy(); rmSync(tmp, { force: true }); });
      return;
    }

    // ----- brand -----
    if (path === '/api/brand/use-inbox' && req.method === 'POST') {
      const { name, slot } = await body(req);
      const rel = safePath(name);
      const src = rel && inboxFull(rel);
      const n = rel && basename(src);
      if (!src || !existsSync(src)) return send(res, 400, { error: 'That file is not in your inbox anymore.' });
      if (slot === 'person' || slot === 'contact') {
        if (kindOf(n) !== 'text') return send(res, 400, { error: 'That is not a text file.' });
        const found = personFromText(readFileSync(src, 'utf8'));
        if (slot === 'contact') writeJson(brandContactFile, { name: clean([found.title, found.name].filter(Boolean).join(' '), 80), lines: cleanLines(found.lines) });
        else {
          const dupe = readPeople().find((x) => onScreen(x) === onScreen(cleanPerson(found)));
          savePerson({ ...found, id: dupe?.id });
        }
      } else if (slot === 'logo' || slot === 'social') {
        if (kindOf(n) !== 'image') return send(res, 400, { error: 'That is not a picture.' });
        for (const f of readdirSafe(dirs.brand)) if (f.toLowerCase().startsWith(`${slot}.`)) rmSync(join(dirs.brand, f), { force: true });
        copyFileSync(src, join(dirs.brand, `${slot}${extname(n).toLowerCase()}`));
      } else return send(res, 400, { error: 'Unknown brand slot.' });
      pushState();
      return send(res, 200, { ok: true });
    }
    if (path === '/api/people' && req.method === 'POST') {
      try { const person = savePerson(await body(req)); pushState(); return send(res, 200, { ok: true, id: person.id }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (path === '/api/brand/contact' && req.method === 'POST') {
      const b = await body(req);
      const c = { name: clean(b.name, 80), lines: cleanLines(b.lines) };
      if (c.name || c.lines.length) writeJson(brandContactFile, c); else rmSync(brandContactFile, { force: true });
      pushState();
      return send(res, 200, { ok: true });
    }

    // ----- inbox folders -----
    if (path === '/api/folders' && req.method === 'POST') {
      const name = folderName((await body(req)).name);
      if (!name) return send(res, 400, { error: 'Give the folder a name.' });
      if (existsSync(join(dirs.inbox, name))) return send(res, 409, { error: 'There is already something with that name.' });
      mkdirSync(join(dirs.inbox, name));
      pushState();
      return send(res, 200, { ok: true, name });
    }
    if (path === '/api/folders/rename' && req.method === 'POST') {
      const b = await body(req);
      const from = safeName(b.from);
      const to = folderName(b.to);
      if (!from || !to || !statSafeDir(join(dirs.inbox, from))) return send(res, 400, { error: 'That folder is not there anymore.' });
      if (from === to) return send(res, 200, { ok: true, name: to });
      if (existsSync(join(dirs.inbox, to))) return send(res, 409, { error: 'There is already something with that name.' });
      if (busyInbox().some((x) => x.startsWith(`${from}/`))) return send(res, 409, { error: 'A clip in this folder is waiting to be edited. Rename it when that is done.' });
      renameSync(join(dirs.inbox, from), join(dirs.inbox, to));
      remapSources((p) => (p.startsWith(`${from}/`) ? `${to}/${p.slice(from.length + 1)}` : p));
      pushState();
      return send(res, 200, { ok: true, name: to });
    }
    // Moves inbox files into a folder ('' = loose in the inbox).
    if (path === '/api/move' && req.method === 'POST') {
      const b = await body(req);
      const folder = b.folder ? safeName(b.folder) : '';
      if (b.folder && (!folder || !statSafeDir(join(dirs.inbox, folder)))) return send(res, 400, { error: 'That folder is not there anymore.' });
      const rels = [...new Set((Array.isArray(b.paths) ? b.paths : []).map(safePath))].filter((r) => r && existsSync(inboxFull(r)));
      const busy = new Set(busyInbox());
      if (rels.some((r) => busy.has(r))) return send(res, 409, { error: 'One of those clips is waiting to be edited. Move it when that is done.' });
      const destDir = folder ? join(dirs.inbox, folder) : dirs.inbox;
      const moved = {};
      for (const r of rels) {
        const src = inboxFull(r);
        if (dirname(src) === destDir) continue;
        const name = freeName(destDir, basename(src));
        renameSync(src, join(destDir, name));
        moved[r] = folder ? `${folder}/${name}` : name;
      }
      remapSources((p) => moved[p] || p);
      pushState();
      return send(res, 200, { ok: true, count: Object.keys(moved).length });
    }

    // ----- delete (to the Trash) -----
    if (path === '/api/delete' && req.method === 'POST') {
      const { items = [] } = await body(req);
      const busy = new Set(busyInbox());
      const targets = [];
      const records = [];
      const people = [];
      for (const it of Array.isArray(items) ? items : []) {
        if (it?.area === 'inbox') {
          const rel = safePath(it.path);
          if (!rel) continue;
          if ([...busy].some((b) => b === rel || b.startsWith(`${rel}/`))) return send(res, 409, { error: 'One of those clips is waiting to be edited. Delete it when that is done.' });
          targets.push(inboxFull(rel));
        } else if (it?.area === 'logo' || it?.area === 'social') {
          const f = slotFile(it.area);
          if (f) targets.push(join(dirs.brand, f));
        } else if (it?.area === 'broll') {
          const n = safeName(it.path);
          if (n && BROLL_RE.test(n)) targets.push(join(brollDir, n));
        } else if (it?.area === 'sounds') {
          const parts = String(it.path || '').split('/');
          if (parts.length <= 2 && parts.every((x) => safeName(x))) targets.push(join(dirs.sounds, ...parts));
        } else if (it?.area === 'project') {
          const slug = String(it.path || '');
          if (!/^[a-z0-9-]+$/.test(slug)) continue;
          if (job?.slug === slug || queue.some((q) => q.slug === slug)) return send(res, 409, { error: 'That video is being edited or waiting in line. Stop or remove it first.' });
          for (const v of versionsBySlug().get(slug) || []) targets.push(join(dirs.outbox, v.file));
          const kitDir = join(root, 'kit', 'video-projects', slug);
          if (statSafeDir(kitDir)) targets.push(kitDir);
          records.push(slug);
        } else if (it?.area === 'person') {
          people.push(String(it.path || ''));
        }
      }
      try { toTrash(targets); } catch (e) { return send(res, 500, { error: e.message }); }
      for (const slug of records) rmSync(projectFile(slug), { force: true });
      if (people.length) writeJson(peopleFile, readPeople().filter((x) => !people.includes(x.id)));
      pushState();
      return send(res, 200, { ok: true, count: targets.length + people.length });
    }
    if (path === '/api/brand/export' && req.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'Give the brand a name first.' });
      if (!existsSync(styleFile)) return send(res, 400, { error: 'There is no style to share yet.' });
      const q = (k) => url.searchParams.get(k) === '1';
      await exportPack(res, { name, broll: q('broll'), music: q('music'), people: q('people') });
      return;
    }
    if (path === '/api/brand/import' && req.method === 'PUT') {
      if (job?.kind === 'style') return send(res, 409, { error: 'Wait until the style update has finished.' });
      const tmp = join(data, `import-${randomUUID()}.brandpack`);
      try {
        await pipeline(req, createWriteStream(tmp));
        const r = await importPack(tmp);
        pushState();
        return send(res, 200, { ok: true, ...r });
      } catch (e) {
        return send(res, 400, { error: e.message.startsWith('That file') ? e.message : 'Could not read that brand pack. Ask for a fresh copy.' });
      } finally { rmSync(tmp, { force: true }); }
    }
    if (path === '/api/brand/unlock' && req.method === 'POST') { rmSync(packFile, { force: true }); pushState(); return send(res, 200, { ok: true }); }

    if (path === '/api/reveal' && req.method === 'POST') {
      const { area, name, folder } = await body(req);
      if (area === 'kit') { reveal(join(root, 'kit', 'video-projects', slugify(name || ''))); return send(res, 200, { ok: true }); }
      if (!dirs[area]) return send(res, 400, { error: 'Unknown folder' });
      const n = name ? safeName(name) : null;
      const f = folder ? safeName(folder) : null;
      reveal(n ? join(dirs[area], ...(f ? [f] : []), n) : join(dirs[area], '.gitkeep'));
      return send(res, 200, { ok: true });
    }

    // One video from one or more clips. Several clips are parts (and retakes) of the same talk.
    if (path === '/api/edit' && req.method === 'POST') {
      const { files = [], keepOrder = false, name: videoName = '', broll = [], extra = [], instructions = '', contact = null } = await body(req);
      const inInbox = (list) => [...new Set((Array.isArray(list) ? list : []).map(safePath))].filter((n) => n && existsSync(inboxFull(n)));
      const clips = inInbox(files).filter((n) => kindOf(n) === 'video');
      if (!clips.length) return send(res, 400, { error: 'Those clips are not in your inbox anymore.' });
      const title = String(videoName).trim().slice(0, 80) || basename(clips[0]).replace(/\.[^.]+$/, '');
      const slug = newSlug(String(videoName).trim() || basename(clips[0]));
      const choice = contact?.type === 'person' && readPeople().some((x) => x.id === contact.id) ? { type: 'person', id: contact.id } : { type: 'all' };
      const brollNames = inInbox(broll).filter((n) => !clips.includes(n));
      const extraNames = inInbox(extra);
      const list = (ns) => ns.map((n) => `inbox/${n}`).join(', ');
      const prompt = [
        `edit this: ${list(clips)}`,
        clips.length > 1 && (keepOrder
          ? `These ${clips.length} clips are parts of one video. Keep them in exactly this order, and drop retakes and false starts inside them.`
          : `These ${clips.length} clips are parts of one video, filmed as separate takes. Listen to all of them, put them in story order, and drop retakes and false starts. Copy each into assets/raw/ and keep the originals untouched.`),
        `Use the slug "${slug}" exactly, and save the first draft as outbox/${slug}-v1.mp4.`,
        brollNames.length ? `These inbox clips are B-roll for this video: ${list(brollNames)}.` : '',
        extraNames.length ? `Also use these inbox files: ${list(extraNames)}.` : '',
        contactPrompt(choice),
        String(instructions).trim() ? `Notes from me for this video: ${String(instructions).trim()}` : '',
      ].filter(Boolean).join('\n');
      const reqObj = { id: randomUUID(), type: 'edit', slug, title, prompt };
      saveProject({
        slug, title, source: clips[0], sources: clips, broll: brollNames, contact: choice, contactLabel: contactLabel(choice), createdAt: Date.now(), updatedAt: Date.now(),
        status: 'queued', sessionId: null, history: [],
      });
      const r = request(reqObj);
      if (r.error) { rmSync(projectFile(slug), { force: true }); return send(res, 409, r); }
      noteAsked(slug, String(instructions).trim() || (clips.length > 1 ? `Make one video from these ${clips.length} clips.` : 'Edit this video.'), r, reqObj);
      pushState();
      return send(res, 200, { ok: true, slug, queued: Boolean(r.queued) });
    }

    if ((m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/(notes|final|horizontal|rename|retry)$/)) && req.method === 'POST') {
      const [, slug, action] = m;
      const p = listProjects().find((x) => x.slug === slug);
      if (!p) return send(res, 404, { error: 'Project not found.' });
      const b = await body(req);
      if (action === 'rename') {
        const rec = loadProject(slug) || { slug, history: [] };
        rec.title = String(b.title || '').trim().slice(0, 80) || prettyTitle(slug);
        saveProject(rec); pushState();
        return send(res, 200, { ok: true });
      }
      let reqObj, said;
      if (action === 'retry') {
        const last = loadProject(slug)?.lastRequest;
        if (!last) return send(res, 400, { error: 'There is nothing to try again. Send a note instead.' });
        reqObj = { ...last, id: randomUUID() };
        said = 'Try again.';
      } else if (action === 'notes') {
        const text = String(b.text || '').trim();
        if (!text) return send(res, 400, { error: 'Write a note first.' });
        reqObj = { type: 'notes', slug, text, horizontal: Boolean(b.horizontal), watching: safeName(b.watching || '') || null };
        said = text;
      } else if (action === 'final') {
        reqObj = { type: 'final', slug };
        said = 'Approved! Make the final version.';
      } else {
        reqObj = { type: 'horizontal', slug };
        said = 'Make a horizontal version for YouTube.';
      }
      reqObj.id ||= randomUUID();
      const r = request(reqObj);
      if (r.error) return send(res, 409, r);
      noteAsked(slug, said, r, reqObj);
      pushState();
      return send(res, 200, { ok: true, queued: Boolean(r.queued) });
    }

    if (path === '/api/stop' && req.method === 'POST') { stopJob(); return send(res, 200, { ok: true }); }
    if (path === '/api/queue/remove' && req.method === 'POST') {
      const { id } = await body(req);
      return removeFromQueue(String(id || '')) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'That already started or was removed.' });
    }

    if (path === '/api/doc/brand-rules' && req.method === 'GET') return send(res, 200, { text: readText(brandRulesFile) });
    if ((m = path.match(/^\/api\/doc\/(style|rules)$/))) {
      const file = join(root, m[1] === 'style' ? 'my-style.md' : 'my-rules.md');
      if (req.method === 'GET') {
        const extra = m[1] === 'style' ? { reply: readJson(join(data, 'style-reply.json'), null) } : {};
        return send(res, 200, { text: readText(file), ...extra });
      }
      if (req.method === 'PUT') {
        if (m[1] === 'style' && locked()) return send(res, 423, { error: 'Your style comes from your brand pack, so it cannot be changed here.' });
        const { text } = await body(req, 1 << 21);
        if (typeof text !== 'string') return send(res, 400, { error: 'Nothing to save.' });
        if (existsSync(file)) writeFileSync(`${file}.bak`, readFileSync(file));
        writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
        pushState();
        return send(res, 200, { ok: true });
      }
    }

    if (path === '/api/style/wizard' && req.method === 'POST') {
      if (locked()) return send(res, 423, { error: 'Your style comes from your brand pack, so it cannot be changed here.' });
      const answers = await body(req);
      if (existsSync(styleFile)) writeFileSync(`${styleFile}.bak`, readFileSync(styleFile));
      writeFileSync(styleFile, styleFromWizard(answers));
      pushState();
      return send(res, 200, { ok: true });
    }

    if (path === '/api/style/ask' && req.method === 'POST') {
      if (locked()) return send(res, 423, { error: 'Your style comes from your brand pack, so it cannot be changed here.' });
      const { text } = await body(req);
      if (!String(text || '').trim()) return send(res, 400, { error: 'Describe the change first.' });
      const r = request({ type: 'style', title: 'Your style', text: String(text).trim() });
      return send(res, r.error ? 409 : 200, r);
    }

    if (path === '/api/setup/run' && req.method === 'POST') { const r = runSetup(); return send(res, r.error ? 409 : 200, r); }
    if (path === '/api/setup/fix' && req.method === 'POST') {
      if (!checkTools().claude) return send(res, 400, { error: 'Claude Code has to be installed first. Follow the step on this page.' });
      const r = request({ type: 'setup', title: 'Setup' });
      return send(res, r.error ? 409 : 200, r);
    }
    if (path === '/api/setup/recheck' && req.method === 'POST') { checkTools(true); pushState(); return send(res, 200, { ok: true }); }

    if (path === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      const s = getSettings();
      if (PERMISSION_MODES.includes(b.permissionMode)) s.permissionMode = b.permissionMode;
      if (MODELS.includes(b.model)) s.model = b.model;
      writeJson(settingsFile, s);
      pushState();
      return send(res, 200, { ok: true });
    }

    // The Groq key is written straight into .env and never sent back to the page.
    if (path === '/api/settings/groq' && req.method === 'POST') {
      const { key } = await body(req);
      const k = String(key || '').trim();
      if (k && !/^[A-Za-z0-9_\-]{20,200}$/.test(k)) return send(res, 400, { error: 'That does not look like a Groq key. It usually starts with gsk_.' });
      const envFile = join(root, '.env');
      let env = readText(envFile) ?? readText(join(root, '.env.example')) ?? '';
      env = /^\s*GROQ_API_KEY\s*=.*$/m.test(env) ? env.replace(/^\s*GROQ_API_KEY\s*=.*$/m, `GROQ_API_KEY=${k}`) : `${env.trimEnd()}\nGROQ_API_KEY=${k}\n`;
      writeFileSync(envFile, env);
      pushState();
      return send(res, 200, { ok: true });
    }

    // Static files
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = path === '/' ? 'index.html' : path.slice(1);
      const full = resolve(pub, rel);
      if (full.startsWith(pub) && existsSync(full) && statSync(full).isFile()) return serveFile(req, res, full);
      return serveFile(req, res, join(pub, 'index.html'));
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

// Live updates when files change outside the app (Finder, terminal Claude).
for (const dir of [dirs.outbox, dirs.sounds, dirs.brand, brollDir]) {
  try { watch(dir, () => pushState()); } catch {}
}
try { watch(dirs.inbox, { recursive: true }, () => pushState()); } catch { try { watch(dirs.inbox, () => pushState()); } catch {} }
try { watch(root, (_, name) => { if (['my-style.md', 'my-rules.md', 'my-people.json'].includes(name)) pushState(); }); } catch {}

// A run that was cut off by closing the app is marked so the page does not spin forever.
for (const f of readdirSync(projectsDir)) {
  const p = readJson(join(projectsDir, f), null);
  if (p?.status === 'working') { p.status = 'interrupted'; saveProject(p); }
}

function openBrowser(link) {
  if (process.argv.includes('--no-open')) return;
  const opener = win ? ['cmd', ['/c', 'start', '', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

function listen() {
  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE' || port >= 4760) throw e;
    // Already open (double-clicked twice)? Show that one instead of running a second editor.
    const link = `http://localhost:${port}`;
    const r = await fetch(`${link}/api/state`).then((x) => x.json()).catch(() => null);
    if (r?.setup) {
      console.log(`free247editor is already running at ${link}. Opening it.`);
      openBrowser(link);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    port++;
    listen();
  });
  server.listen(port, '127.0.0.1', () => {
    const link = `http://localhost:${port}`;
    console.log(`\nfree247editor is open at ${link}\nKeep this window open while you edit. Close it to stop the app.\n`);
    openBrowser(link);
    // Requests still in line from last time carry on.
    if (queue.length) setTimeout(nextInQueue, 1500);
  });
}
listen();

const shutdown = () => { if (job) stopJob(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
