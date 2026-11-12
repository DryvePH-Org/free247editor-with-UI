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
  closeSync, copyFileSync, cpSync, createReadStream, lstatSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createBgSwap } from './bgswap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'app', 'public');
// my-brand/ holds what every video for the brand uses: logo.*, social.* (a screenshot of the social
// page), broll/broll_<category>_<nn>.*, images/ (reusable brand pictures), brand.json (colors, gradients,
// font moods, feel, about the company) with fonts/ (the font shelf), brand-rules.md and pack.json
// (present = style comes from a brand pack).
// my-styles/ holds extra named styles learned from sample videos, one folder each (see listStyles).
const dirs = { inbox: join(root, 'inbox'), outbox: join(root, 'outbox'), sounds: join(root, 'my-sounds'), brand: join(root, 'my-brand'), styles: join(root, 'my-styles') };
const brollDir = join(dirs.brand, 'broll');
const imagesDir = join(dirs.brand, 'images');
const fontsDir = join(dirs.brand, 'fonts');
// Sales people a video can be for (personal, optional in a brand pack), and the brand contact for all-sales videos.
const peopleFile = join(root, 'my-people.json');
const brandContactFile = join(dirs.brand, 'contact.json');
const data = join(root, '.webapp');
const projectsDir = join(data, 'projects');
const thumbsDir = join(data, 'thumbs');
const previewsDir = join(data, 'previews');
for (const d of [...Object.values(dirs), brollDir, imagesDir, fontsDir, projectsDir, thumbsDir, previewsDir]) mkdirSync(d, { recursive: true });

const win = process.platform === 'win32';
// Double-click launchers start without the user's shell profile, so add the usual install places.
const extraPath = win ? [] : [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), join(homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin'];
process.env.PATH = [...new Set([...process.env.PATH.split(delimiter), ...extraPath])].join(delimiter);

const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const PERMISSION_MODES = ['auto', 'bypassPermissions'];
const bg = createBgSwap({ root, onChange: () => pushState() });
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
// mainStyleName is the name the person gave my-style.md in the app ('' = "My style", or the brand pack's name).
// brandCheck: before each draft is saved, the editor checks it against My brand (off unless turned on).
const getSettings = () => ({ permissionMode: 'auto', model: '', mainStyleName: '', brandCheck: false, ...readJson(settingsFile, {}) });

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
// my-sounds/sfx/ holds sound effects named <kind>-<n> (whoosh-1.wav). Any other sound under 15 seconds is an
// effect too (added with the app's button, it lands outside sfx/); everything longer is music.
const SFX_FOLDER = 'sfx';
const SFX_MAX_SECONDS = 15;
const isEffect = (f) => f.folder === SFX_FOLDER || (f.kind === 'audio' &&
  (probe(join(dirs.sounds, ...(f.folder ? [f.folder] : []), f.name), f.mtime).duration || Infinity) < SFX_MAX_SECONDS);
const musicFiles = () => listFolder('sounds').filter((f) => f.kind === 'audio' && !isEffect(f));
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const FONT = new Set(['.ttf', '.otf', '.woff', '.woff2']);
function kindOf(name) {
  const e = extname(name).toLowerCase();
  if (VIDEO.has(e)) return 'video';
  if (FONT.has(e)) return 'font';
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
  return { id: /^[a-z0-9-]{6,40}$/.test(p?.id || '') ? p.id : randomUUID().slice(0, 8), title, name: clean(p?.name, 60), pronoun, lines: cleanLines(p?.lines), fb: clean(p?.fb, 200) };
}
// Their own Facebook page shows as one more line in the contact part.
const contactLines = (p) => [...p.lines, ...(p.fb ? [{ label: 'FACEBOOK', value: p.fb }] : [])];
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
  let fb = '';
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    const m = l.match(/^([^:]{1,30}):\s*(.+)$/);
    if (m && /^(fb|facebook)( page)?$/i.test(m[1].trim())) fb = m[2].trim();
    else if (m) lines.push({ label: m[1].trim(), value: m[2].trim() });
    else if (!name) name = l;
  }
  const t = name.match(/^(MISS|MS\.?|MA'?AM|SIR|MR\.?)\s+(.+)$/i);
  const title = t ? ({ MS: 'MS.', MR: 'MR.', MAAM: "MA'AM" }[t[1].toUpperCase().replace(/[.']/g, '')] || t[1].toUpperCase()) : '';
  return { title, name: t ? t[2] : name, lines, fb };
}
const readBrandContact = () => { const c = readJson(brandContactFile, null); return c && (c.name || c.lines?.length) ? c : null; };

// ---------- brand look: colors, gradients, the font shelf, the feel, and about the company ----------
// brand.json holds the words; the font files sit in fonts/. fonts maps a file name to its mood ("Big bold").
const brandLookFile = join(dirs.brand, 'brand.json');
const HEX_RE = /^#[0-9a-f]{6}$/i;
const ANGLES = [180, 90, 135, 45];
const cleanText = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
function cleanLook(b) {
  const list = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
  const fonts = {};
  for (const [file, mood] of Object.entries(b?.fonts && typeof b.fonts === 'object' ? b.fonts : {})) {
    if (safeName(file) && kindOf(file) === 'font') fonts[file] = clean(mood, 40);
  }
  return {
    colors: list(b?.colors, 12).map((c) => ({ label: clean(c?.label, 40), hex: String(c?.hex || '').toLowerCase() })).filter((c) => HEX_RE.test(c.hex)),
    gradients: list(b?.gradients, 8).map((g) => ({ label: clean(g?.label, 40), from: String(g?.from || '').toLowerCase(), to: String(g?.to || '').toLowerCase(), angle: ANGLES.includes(Number(g?.angle)) ? Number(g.angle) : 180 }))
      .filter((g) => HEX_RE.test(g.from) && HEX_RE.test(g.to)),
    fonts, feel: cleanText(b?.feel, 2000), about: cleanText(b?.about, 6000),
  };
}
const readLook = () => cleanLook(readJson(brandLookFile, {}));
const fontFiles = () => readdirSafe(fontsDir).filter((n) => kindOf(n) === 'font').sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
// What a branded copy needs: at least a color or a font to brand with.
const lookReady = (l = readLook()) => l.colors.length > 0 || fontFiles().length > 0;

// What the editor is told about the end of one video.
function contactPrompt(choice) {
  if (choice?.type === 'person') {
    const p = readPeople().find((x) => x.id === choice.id);
    if (p) {
      return `This video is for one sales person. Contact part: "Look for ${onScreen(p)}"` +
        `${contactLines(p).length ? `, then ${contactLines(p).map((l) => `${l.label}: ${l.value}`).join('; ')}` : ''}. ` +
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

// ---------- learned styles ----------
// my-styles/<id>/ is one named style learned from a sample video: meta.json { name, createdAt, reply },
// source.* (the sample), and once learned, style.md plus storyboard frames 01.jpg… described in storyboard.json.

const STYLE_ID_RE = /^[a-z0-9-]{1,60}$/;
const styleDir = (id) => join(dirs.styles, id);
function listStyles() {
  return readdirSafe(dirs.styles).filter((id) => STYLE_ID_RE.test(id) && statSafeDir(styleDir(id))).map((id) => {
    const dir = styleDir(id);
    const meta = readJson(join(dir, 'meta.json'), {});
    const names = readdirSafe(dir);
    const board = readJson(join(dir, 'storyboard.json'), null);
    // Frames Claude described in storyboard.json, or else every numbered frame in the folder.
    const frames = (Array.isArray(board) ? board : names.filter((n) => /^\d+\.jpe?g$/i.test(n)).sort().map((file) => ({ file })))
      .filter((f) => safeName(f?.file) && names.includes(f.file) && kindOf(f.file) === 'image')
      .map((f) => ({ file: f.file, at: Number.isFinite(Number(f.at)) && f.at !== null ? Number(f.at) : null, note: clean(f.note, 240), mtime: statSafe(join(dir, f.file)) }));
    return {
      id, name: clean(meta.name, 60) || id, createdAt: meta.createdAt || statSafe(dir), ready: existsSync(join(dir, 'style.md')),
      source: names.find((n) => n.startsWith('source.') && kindOf(n) === 'video') || null, frames, reply: meta.reply || null,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}
// A free folder id made from a style name: "Fast promo" -> fast-promo, then fast-promo-2, ...
function newStyleId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'style';
  let id = base;
  for (let i = 2; existsSync(styleDir(id)); i++) id = `${base}-${i}`;
  return id;
}
const findStyle = (id) => (STYLE_ID_RE.test(String(id || '')) && listStyles().find((x) => x.id === id)) || null;
// What the editor is told when a video uses a learned style.
function stylePrompt(id) {
  const st = findStyle(id);
  return st?.ready ? `Style for this video: "${st.name}". Use my-styles/${st.id}/style.md in place of my-style.md, and make it look like ` +
    `the storyboard frames in my-styles/${st.id}/ (described in its storyboard.json), as CLAUDE.md says.` : '';
}

function brandState() {
  const style = readText(styleFile);
  const broll = readdirSafe(brollDir).filter((n) => kindOf(n) === 'video').map((name) => {
    const full = join(brollDir, name);
    const st = statSync(full);
    preview(full, st);
    return { name, category: name.match(BROLL_RE)?.[1]?.toLowerCase() || 'other', size: st.size, mtime: st.mtimeMs, ...probe(full, st.mtimeMs) };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const images = readdirSafe(imagesDir).filter((n) => kindOf(n) === 'image').map((name) => {
    const st = statSync(join(imagesDir, name));
    return { name, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sounds = musicFiles();
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
    broll, images, people: people.map((p) => ({ ...p, onScreen: onScreen(p) })), contact, needs, has,
    categories: [...new Set([...(styleCats.length ? styleCats : DEFAULT_CATEGORIES), ...broll.map((b) => b.category)])],
    pack: readJson(packFile, null),
    brandRules: Boolean(readText(brandRulesFile)?.trim()),
    look: (() => { const l = readLook(); return { ...l, fonts: fontFiles().map((name) => ({ name, mood: l.fonts[name] || '', mtime: statSafe(join(fontsDir, name)) })), ready: lookReady(l) }; })(),
    sizes: { broll: broll.reduce((s, b) => s + b.size, 0), images: images.reduce((s, b) => s + b.size, 0), music: sounds.reduce((s, f) => s + f.size, 0) },
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
  /^images\/\d+\.(png|jpe?g|webp|gif|svg)$/i, /^brand\.json$/, /^fonts\/\d+\.(ttf|otf|woff2?)$/i,
  /^styles\/[a-z0-9-]{1,60}\/(style\.md|meta\.json|storyboard\.json|\d+\.jpe?g)$/i,
];

async function exportPack(res, { name, broll, music, images, styles, people }) {
  const entries = [];
  const add = (path, file) => existsSync(file) && entries.push({ path, file, size: statSync(file).size, mtime: statSync(file).mtimeMs });
  add('style.md', styleFile);
  add('contact.json', brandContactFile);
  add('brand.json', brandLookFile);
  if (people) add('people.json', peopleFile);
  const rules = [readText(brandRulesFile), readText(join(root, 'my-rules.md'))].filter((t) => t?.trim()).join('\n\n');
  const logo = slotFile('logo');
  const social = slotFile('social');
  if (logo) add(`logo${extname(logo).toLowerCase()}`, join(dirs.brand, logo));
  if (social) add(`social${extname(social).toLowerCase()}`, join(dirs.brand, social));
  if (broll) for (const n of readdirSafe(brollDir)) if (BROLL_RE.test(n) && kindOf(n) === 'video') add(`broll/${n}`, join(brollDir, n));
  const musicNames = {};
  if (music) {
    musicFiles().forEach((f, i) => {
      const path = `music/${String(i + 1).padStart(2, '0')}${extname(f.name).toLowerCase()}`;
      musicNames[path] = f.name;
      add(path, f.folder ? join(dirs.sounds, f.folder, f.name) : join(dirs.sounds, f.name));
    });
  }
  // Pictures travel as images/01.png and get their real names back from the manifest, like music.
  const imageNames = {};
  if (images) {
    readdirSafe(imagesDir).filter((n) => kindOf(n) === 'image').forEach((n, i) => {
      const path = `images/${String(i + 1).padStart(2, '0')}${extname(n).toLowerCase()}`;
      imageNames[path] = n;
      add(path, join(imagesDir, n));
    });
  }
  // Fonts travel as fonts/01.ttf and get their real names back from the manifest, so brand.json still matches.
  const fontNames = {};
  fontFiles().forEach((n, i) => {
    const path = `fonts/${String(i + 1).padStart(2, '0')}${extname(n).toLowerCase()}`;
    fontNames[path] = n;
    add(path, join(fontsDir, n));
  });
  // Learned styles go without their sample video: the editor only needs style.md and the storyboard.
  if (styles) {
    for (const st of listStyles().filter((x) => x.ready)) {
      for (const n of ['style.md', 'meta.json', 'storyboard.json', ...st.frames.map((f) => f.file)]) add(`styles/${st.id}/${n}`, join(styleDir(st.id), n));
    }
  }
  const manifest = Buffer.from(JSON.stringify({ format: 1, name, createdAt: Date.now(), includes: { broll, music, images, styles, people }, musicNames, imageNames, fontNames }, null, 2));
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
  mkdirSync(join(stage, 'images'), { recursive: true });
  mkdirSync(join(stage, 'fonts'), { recursive: true });
  try {
    for (const e of entries) {
      if (e.name === 'pack.json') continue;
      const dest = join(stage, e.name.toLowerCase());
      mkdirSync(dirname(dest), { recursive: true });
      if (e.size) await pipeline(createReadStream(tmp, { start: e.start, end: e.start + e.size - 1 }), createWriteStream(dest));
      else writeFileSync(dest, '');
    }
    for (const d of [dirs.brand, brollDir, imagesDir, fontsDir]) mkdirSync(d, { recursive: true });
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
    // The team's pictures join this computer's; a picture with the same name is replaced by the pack's.
    for (const n of readdirSafe(join(stage, 'images'))) {
      const real = safeName(String(manifest.imageNames?.[`images/${n}`] || ''));
      renameSync(join(stage, 'images', n), join(imagesDir, real && kindOf(real) === 'image' ? real : n));
    }
    // The team's brand look replaces this one; its fonts join this computer's (same name = the pack's).
    if (has('brand.json')) writeJson(brandLookFile, cleanLook(readJson(join(stage, 'brand.json'), {})));
    for (const n of readdirSafe(join(stage, 'fonts'))) {
      const real = safeName(String(manifest.fontNames?.[`fonts/${n}`] || ''));
      renameSync(join(stage, 'fonts', n), join(fontsDir, real && kindOf(real) === 'font' ? real : n));
    }
    // The team's learned styles join this computer's. One with the same id is replaced (the old one goes
    // to the Trash), unless it is being learned or used right now.
    for (const id of readdirSafe(join(stage, 'styles'))) {
      const from = join(stage, 'styles', id);
      if (!STYLE_ID_RE.test(id) || !existsSync(join(from, 'style.md'))) continue;
      if (job?.styleId === id || queue.some((q) => q.styleId === id)) continue;
      if (statSafeDir(styleDir(id))) { try { toTrash([styleDir(id)]); } catch { continue; } }
      renameSync(from, styleDir(id));
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
  writeJson(packFile, { name: brandName, createdAt: manifest.createdAt || null, importedAt: Date.now() });
  return { name: brandName };
}

// A clip stored with non-square pixels (for example a tall video squeezed into 1920x1080 plus a stretch
// flag) looks right in players but comes out flat or thin in tools that use the raw pixels. Re-save it in
// the background with square pixels at the shape players show, keeping the long side.
function squarePixels(full) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'json', full], { encoding: 'utf8' });
  let s; try { s = JSON.parse(r.stdout).streams?.[0]; } catch { return; }
  const [n, d] = String(s?.sample_aspect_ratio || '1:1').split(':').map(Number);
  if (!s?.width || !s.height || !n || !d || n === d) return;
  const shape = (s.width * n) / d / s.height;
  const long = Math.max(s.width, s.height);
  const even = (x) => Math.round(x / 2) * 2;
  const [w, h] = shape < 1 ? [even(long * shape), long] : [long, even(long / shape)];
  const tmp = join(dirname(full), `.squaring-${randomUUID()}`);
  const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', full, '-map', '0:v:0', '-map', '0:a?', '-c:a', 'copy',
    '-vf', `scale=${w}:${h}:flags=lanczos,setsar=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', '-f', 'mp4', tmp]);
  p.on('error', () => {});
  p.on('close', (code) => { if (code === 0 && existsSync(full)) { renameSync(tmp, full); pushState(); } else rmSync(tmp, { force: true }); });
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

const VERSION_RE = /^(.+?)-((?:horizontal-|bg-[a-z0-9]+-)?(?:v\d+|final))\.mp4$/i;
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
  const order = (l) => (l.startsWith('horizontal') ? 1000 : l.startsWith('bg-') ? 2000 : 0) + (l.endsWith('final') ? 500 : Number(l.match(/\d+/)?.[0] || 0));
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

// Preview first: a 5-second sample <slug>-preview.mp4 and storyboard frames <slug>-preview-01.jpg… in outbox/.
const PREVIEW_RE = /^(.+?)-preview(?:-(\d+)\.jpe?g|\.mp4)$/i;
function previewsBySlug() {
  const map = new Map();
  for (const f of listFolder('outbox')) {
    const m = f.name.match(PREVIEW_RE);
    if (!m) continue;
    const p = map.get(m[1]) || { video: null, frames: [], mtime: 0 };
    if (m[2]) p.frames.push(f.name); else p.video = f.name;
    p.mtime = Math.max(p.mtime, f.mtime);
    map.set(m[1], p);
  }
  for (const p of map.values()) p.frames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return map;
}

function listProjects() {
  const versions = versionsBySlug();
  const previews = previewsBySlug();
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
      preview: previews.get(slug) || null, bg: rec.clean ? bg.view(slug) : null,
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

function cleanSource(slug) {
  const vs = (versionsBySlug().get(slug) || []).filter((v) => /^(v\d+|final)$/.test(v.label));
  const v = vs.find((x) => x.label === 'final') || vs.at(-1);
  if (!v) return null;
  const kept = join(root, 'kit', 'video-projects', slug, `edited-${v.label}.mp4`);
  return { name: v.file, path: existsSync(kept) ? kept : join(dirs.outbox, v.file) };
}
// A finished background run becomes the next <slug>-bg-<model>-vN.mp4 in the outbox.
function saveBgVersion(slug, model, file) {
  const nums = (versionsBySlug().get(slug) || []).map((v) => v.label.match(new RegExp(`^bg-${model}-v(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  const name = `${slug}-bg-${model}-v${Math.max(0, ...nums) + 1}.mp4`;
  copyFileSync(file, join(dirs.outbox, name));
  return name;
}

function nextVersion(slug, horizontal = false) {
  const nums = (versionsBySlug().get(slug) || [])
    .filter((v) => !v.label.startsWith('bg-') && v.label.startsWith('horizontal') === horizontal)
    .map((v) => Number(v.label.match(/v(\d+)/)?.[1] || 0));
  return Math.max(0, ...nums) + 1;
}

// ---------- quick edits (ffmpeg on this computer, no AI) ----------
// Cut a part out of a draft, or put a clip in between, saved as the next version. The AI never sees
// these, so each one is remembered on the project and handed to it with the next note or final.

const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
function ffmpeg(args) {
  return new Promise((done) => {
    const p = spawn('ffmpeg', ['-y', '-v', 'error', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => done(false));
    p.on('close', (code) => { if (code) console.error(err.slice(-800)); done(code === 0); });
  });
}
function streamsOf(full) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,sample_rate', '-of', 'json', full], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).streams || []; } catch { return []; }
}
const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4'];

async function quickEdit(slug, from, edit) {
  const v = (versionsBySlug().get(slug) || []).find((x) => x.file === from);
  if (!v) return { error: 'That version is not here anymore.' };
  if (job?.slug === slug || queue.some((q) => q.slug === slug)) return { error: 'The editor is working on this video. Try again when it has finished.' };
  const src = join(dirs.outbox, from);
  const { duration: dur, width: W, height: H } = probe(src, v.mtime);
  if (!dur || !W) return { error: 'Could not read that video.' };
  const horizontal = v.label.startsWith('horizontal');
  const out = `${slug}-${horizontal ? 'horizontal-' : ''}v${nextVersion(slug, horizontal)}.mp4`;
  const tmp = join(dirs.outbox, `.quick-${randomUUID()}.mp4`);
  let args, said, line;
  if (edit.cut) {
    const a = Math.max(0, Number(edit.cut[0]) || 0);
    const b = Math.min(dur, Number(edit.cut[1]) || 0);
    if (!(b - a >= 0.1)) return { error: 'Pick where the cut ends after where it starts.' };
    if (dur - (b - a) < 0.5) return { error: 'That would cut the whole video.' };
    const keep = `not(between(t,${a.toFixed(3)},${b.toFixed(3)}))`;
    args = ['-i', src, '-vf', `select='${keep}',setpts=N/FRAME_RATE/TB`, '-af', `aselect='${keep}',asetpts=N/SR/TB`, ...ENCODE, tmp];
    said = `Cut ${clock(a)} to ${clock(b)}.`;
    line = `cut ${clock(a)}–${clock(b)} out of outbox/${from}, saved as outbox/${out}`;
  } else {
    const at = Math.min(dur, Math.max(0, Number(edit.at) || 0));
    const clip = edit.clip;
    const cm = probe(clip, statSafe(clip));
    if (!cm.duration || !cm.width) return { error: 'That clip is not a video this computer can read.' };
    const ss = streamsOf(src);
    const fps = ss.find((s) => s.codec_type === 'video')?.r_frame_rate || '30';
    const sr = ss.find((s) => s.codec_type === 'audio')?.sample_rate || '48000';
    const vf = `fps=${fps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS`;
    const af = `aformat=sample_rates=${sr}:channel_layouts=stereo,asetpts=PTS-STARTPTS`;
    // The clip fills the frame (cropped, not letterboxed), and plays whole with its own sound.
    let g = `[1:v]scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${vf}[cv];`
      + (streamsOf(clip).some((s) => s.codec_type === 'audio') ? `[1:a]${af}[ca];` : `anullsrc=r=${sr}:cl=stereo,atrim=0:${cm.duration.toFixed(3)},${af}[ca];`);
    const order = [];
    if (at > 0.05) { g += `[0:v]trim=0:${at.toFixed(3)},${vf}[v0];[0:a]atrim=0:${at.toFixed(3)},${af}[a0];`; order.push('[v0][a0]'); }
    order.push('[cv][ca]');
    if (at < dur - 0.05) { g += `[0:v]trim=${at.toFixed(3)},${vf}[v2];[0:a]atrim=${at.toFixed(3)},${af}[a2];`; order.push('[v2][a2]'); }
    g += `${order.join('')}concat=n=${order.length}:v=1:a=1[v][a]`;
    args = ['-i', src, '-i', clip, '-filter_complex', g, '-map', '[v]', '-map', '[a]', ...ENCODE, tmp];
    const rel = relative(root, clip).split('\\').join('/');
    said = `Put ${basename(clip)} in at ${clock(at)}.`;
    line = `put ${rel} in at ${clock(at)} of outbox/${from} (the whole clip, with its own sound, then the video continues), saved as outbox/${out}`;
  }
  if (!await ffmpeg(args)) { rmSync(tmp, { force: true }); return { error: 'Could not make the new version. Try again, or send it as a note.' }; }
  renameSync(tmp, join(dirs.outbox, out));
  const rec = loadProject(slug) || { slug, history: [], fromTerminal: true };
  rec.history.push({ role: 'you', text: said, at: Date.now() },
    { role: 'editor', text: `Done on this computer, no AI used. It's saved as ${out.match(VERSION_RE)[2].replace('horizontal-', 'YouTube ')}.`, at: Date.now() });
  rec.quickEdits = [...(rec.quickEdits || []), line];
  rec.updatedAt = Date.now();
  saveProject(rec);
  pushState();
  return { ok: true, file: out };
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

const CLEAN_NOTE = 'This is a clean raw edit: follow "Clean raw edit" in CLAUDE.md (cuts and voice cleanup only, nothing added). ';
const noteFile = join(data, 'app-note.txt');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let job = null; // { id, kind, slug, title, steps, todos, startedAt, proc, sessionId }
const clients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
const publicJob = () => job && {
  id: job.id, kind: job.kind, slug: job.slug, styleId: job.styleId, title: job.title, steps: job.steps.slice(-60),
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
    if (/my-styles[\\/].*\.jpe?g$/i.test(file)) return 'Studying the frames';
    if (/my-style|my-rules/.test(file)) return 'Reading your style and rules';
    if (/SKILL\.md|CLAUDE\.md/.test(file)) return 'Reading the editing playbook';
    if (/\.json$/.test(file) && /raw/.test(file)) return 'Reading the transcript';
    return null;
  }
  if (name === 'Write' || name === 'Edit') {
    if (/my-rules\.md$/.test(file)) return 'Saving a new rule';
    if (/my-style\.md$/.test(file)) return 'Updating your style';
    if (/my-styles[\\/].*storyboard\.json$/.test(file)) return 'Making the storyboard';
    if (/my-styles[\\/].*style\.md$/.test(file)) return 'Writing down the style';
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

function startJob({ kind, slug = null, styleId = null, title, prompt, resume = null }) {
  if (job) return { error: 'The editor is already working on something. Wait for it to finish, or stop it.' };
  const s = getSettings();
  const brandCheck = s.brandCheck && ['edit', 'notes', 'horizontal'].includes(kind);
  writeFileSync(noteFile, brandCheck ? `${APP_NOTE} Brand check is on: follow "Brand check" in CLAUDE.md before you save each draft.` : APP_NOTE);
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
  job = { id: randomUUID(), kind, slug, styleId, title, steps: [], todos: [], startedAt: Date.now(), proc, sessionId: resume, rulesBefore, versionsBefore };
  addStep({ go: 'Building the full edit', edit: 'Getting your clips ready', style: 'Updating your style', learn: 'Watching your sample video', setup: 'Checking this computer', final: 'Getting the final ready', horizontal: 'Planning the YouTube version', bgcheck: 'Looking at your background photo' }[kind] || 'Reading your notes');
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
    if (!error && newVersion && ['notes', 'final', 'horizontal', 'go'].includes(j.kind)) delete p.quickEdits;
    p.updatedAt = Date.now();
    saveProject(p);
  }
  if (j.kind === 'style') writeJson(join(data, 'style-reply.json'), { text, error, at: Date.now(), styleId: j.styleId || null });
  if (j.kind === 'learn' && j.styleId) {
    const f = join(styleDir(j.styleId), 'meta.json');
    if (existsSync(f)) writeJson(f, { ...readJson(f, {}), reply: { text, error, at: Date.now() } });
  }
  if (j.kind === 'setup') { writeJson(join(data, 'setup-reply.json'), { text, error, at: Date.now() }); toolCache = null; }
  broadcast('done', { id: j.id, slug: j.slug, styleId: j.styleId, kind: j.kind, error, text, ruleSaved, newVersion });
  pushState();
  setTimeout(nextInQueue, 800);
}

// ---------- the line (queue) ----------
// Requests wait here while the editor is busy. Prompts are built when a request starts, so notes
// queued behind each other get the right next version number and the latest Claude session.

const queueFile = join(data, 'queue.json');
let queue = readJson(queueFile, []);
const saveQueue = () => writeJson(queueFile, queue);
const publicQueue = () => queue.map(({ id, type, slug, styleId, title }) => ({ id, type, slug, styleId, title }));

function buildJob(req) {
  const p = req.slug ? listProjects().find((x) => x.slug === req.slug) : null;
  if (req.slug && !p) return null;
  const quick = p?.quickEdits?.length ? `Since the last render the user made quick edits in the app with ffmpeg, which are not in the project files yet: ` +
    `${p.quickEdits.join('; ')}. Redo them in the project first so they carry into this render. ` : '';
  const ctx = p ? `${p.clean ? CLEAN_NOTE : ''}${contextFor(p)}${p.style && stylePrompt(p.style) ? `${stylePrompt(p.style)} ` : ''}${quick}` : '';
  const resume = p?.sessionId || null;
  const base = { kind: req.type, slug: req.slug || null, styleId: req.styleId || null, title: p?.title || req.title, resume };
  if (req.type === 'edit') return { ...base, prompt: req.prompt, resume: null };
  // Still at the preview: notes make a new preview, and "looks good" builds the full first draft.
  if (req.type === 'notes' && p.preview && !p.versions.length) {
    return { ...base, prompt: `${ctx}Notes on the preview of ${req.slug}:\n${req.text}\n\nApply them and make a new preview, as "Preview first" in CLAUDE.md says. ` +
      'Do not render the full draft yet.' };
  }
  if (req.type === 'go') {
    return { ...base, prompt: `${ctx}The preview of ${req.slug} looks good. Finish the full edit as planned, render it, and save the first draft as ` +
      `outbox/${req.slug}-v1.mp4. Then follow steps 6 and 7 of "Editing" in CLAUDE.md.` };
  }
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
    const st = req.styleId ? findStyle(req.styleId) : null;
    if (req.styleId ? !st?.ready : locked()) return null;
    const file = st ? `my-styles/${st.id}/style.md` : 'my-style.md';
    return { ...base, title: st ? st.name : 'Your style', prompt: `Update ${file} with this change to ${st ? `the "${st.name}" style` : 'my style'}. ` +
      `Keep everything else as it is, and keep the file's existing format. Do not edit any video. The change: ${req.text}` };
  }
  if (req.type === 'learn') {
    const st = findStyle(req.styleId);
    if (!st?.source) return null;
    return { ...base, title: `Learning “${st.name}”`, prompt: `Learn a new style called "${st.name}" from the sample video my-styles/${st.id}/${st.source}. ` +
      `Follow "Learning a style from a video" in CLAUDE.md, working in my-styles/${st.id}/.` };
  }
  if (req.type === 'bgcheck') {
    const src = cleanSource(req.slug);
    const photo = bg.view(req.slug)?.photo;
    if (!src || !photo) return null;
    return { ...base, resume: null, prompt: `Background check for ${req.slug}: follow "Background check" in CLAUDE.md. The clean video is ` +
      `outbox/${src.name}. The photo is kit/video-projects/${req.slug}/bgswap/${photo}. Work in kit/video-projects/${req.slug}/bgswap/.` };
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
    // Optional: background replacement only. Succeeds when installed, signed in and a workspace is picked.
    higgsfield: ok('higgsfield', ['account', 'status']),
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
    sounds: listFolder('sounds').filter((f) => !isEffect(f)),
    sfx: listFolder('sounds').filter((f) => f.kind === 'audio' && isEffect(f)).map((f) => ({ name: f.name, folder: f.folder || '' })),
    outbox: listFolder('outbox').filter((f) => f.kind === 'video'),
    projects,
    brand: brandState(),
    styles: listStyles(),
    job: publicJob(),
    queue: publicQueue(),
    setupReply: readJson(join(data, 'setup-reply.json'), null),
    // The page loads new code right away, but this server keeps running the old code until it restarts.
    outdated: statSafe(selfFile) !== selfMtime,
  };
}
const selfFile = fileURLToPath(import.meta.url);
const selfMtime = statSafe(selfFile);

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
    if ((m = path.match(/^\/(media|thumb|preview)\/(inbox|outbox|sounds|brand|styles)\/(?:([^/]+)\/)?([^/]+)$/))) {
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
      // A named event, not an SSE comment: the page can see it and reconnects when pings stop (e.g. after sleep).
      const ping = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 25000);
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
      let squareAfter = false;
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
          squareAfter = true;
        } else if (slot === 'image') {
          if (kindOf(name) !== 'image') return send(res, 400, { error: `${name} is not a picture (PNG, JPG or WebP).` });
          dir = imagesDir;
          name = freeName(imagesDir, name);
        } else if (slot === 'font') {
          if (kindOf(name) !== 'font') return send(res, 400, { error: `${name} is not a font file (TTF, OTF, WOFF or WOFF2).` });
          dir = fontsDir;
          name = freeName(fontsDir, name);
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
        if (squareAfter) squarePixels(join(dir, name));
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
    // Each panel saves only its own part (colors and feel, the font moods, or about the company).
    if (path === '/api/brand/look' && req.method === 'POST') {
      const b = await body(req);
      const cur = readLook();
      const next = cleanLook({ ...cur, ...Object.fromEntries(['colors', 'gradients', 'fonts', 'feel', 'about'].filter((k) => k in b).map((k) => [k, b[k]])) });
      writeJson(brandLookFile, next);
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
      const versions = [];
      const people = [];
      const fontsGone = [];
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
        } else if (it?.area === 'images') {
          const n = safeName(it.path);
          if (n && kindOf(n) === 'image' && existsSync(join(imagesDir, n))) targets.push(join(imagesDir, n));
        } else if (it?.area === 'font') {
          const n = safeName(it.path);
          if (n && kindOf(n) === 'font' && existsSync(join(fontsDir, n))) { targets.push(join(fontsDir, n)); fontsGone.push(n); }
        } else if (it?.area === 'sounds') {
          const parts = String(it.path || '').split('/');
          if (parts.length <= 2 && parts.every((x) => safeName(x))) targets.push(join(dirs.sounds, ...parts));
        } else if (it?.area === 'project') {
          const slug = String(it.path || '');
          if (!/^[a-z0-9-]+$/.test(slug)) continue;
          if (job?.slug === slug || queue.some((q) => q.slug === slug)) return send(res, 409, { error: 'That video is being edited or waiting in line. Stop or remove it first.' });
          for (const v of versionsBySlug().get(slug) || []) targets.push(join(dirs.outbox, v.file));
          const pv = previewsBySlug().get(slug);
          for (const n of pv ? [pv.video, ...pv.frames].filter(Boolean) : []) targets.push(join(dirs.outbox, n));
          const kitDir = join(root, 'kit', 'video-projects', slug);
          if (statSafeDir(kitDir)) targets.push(kitDir);
          records.push(slug);
        } else if (it?.area === 'version') {
          const n = safeName(it.path);
          const vm = n?.match(VERSION_RE);
          if (!vm || !existsSync(join(dirs.outbox, n))) continue;
          if (job?.slug === vm[1] || queue.some((q) => q.slug === vm[1])) return send(res, 409, { error: 'That video is being edited or waiting in line. Delete versions when that is done.' });
          targets.push(join(dirs.outbox, n));
          versions.push([vm[1], n]);
        } else if (it?.area === 'person') {
          people.push(String(it.path || ''));
        } else if (it?.area === 'style') {
          const st = findStyle(it.path);
          if (!st) continue;
          if (job?.styleId === st.id || queue.some((q) => q.styleId === st.id)) return send(res, 409, { error: 'That style is being learned or used right now. Delete it when that is done.' });
          targets.push(styleDir(st.id));
        }
      }
      try { toTrash(targets); } catch (e) { return send(res, 500, { error: e.message }); }
      for (const slug of records) rmSync(projectFile(slug), { force: true });
      for (const [slug, file] of versions) {
        const rec = loadProject(slug);
        if (!rec?.quickEdits) continue;
        // Forget a quick edit whose version is gone, so the next render does not redo it,
        // unless a kept quick edit was made on top of it.
        const gone = `outbox/${file}`;
        rec.quickEdits = rec.quickEdits.filter((l) => !l.endsWith(`saved as ${gone}`) || rec.quickEdits.some((o) => o.includes(`of ${gone}`)));
        saveProject(rec);
      }
      if (people.length) writeJson(peopleFile, readPeople().filter((x) => !people.includes(x.id)));
      if (fontsGone.length) { const l = readLook(); for (const n of fontsGone) delete l.fonts[n]; writeJson(brandLookFile, l); }
      pushState();
      return send(res, 200, { ok: true, count: targets.length + people.length });
    }
    if (path === '/api/brand/export' && req.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'Give the brand a name first.' });
      if (!existsSync(styleFile)) return send(res, 400, { error: 'There is no style to share yet.' });
      const q = (k) => url.searchParams.get(k) === '1';
      await exportPack(res, { name, broll: q('broll'), music: q('music'), images: q('images'), styles: q('styles'), people: q('people') });
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
      const { files = [], keepOrder = false, name: videoName = '', broll = [], extra = [], instructions = '', contact = null, style = '', music = '', sfx = true, assets = [], preview = false, clean = false } = await body(req);
      const inInbox = (list) => [...new Set((Array.isArray(list) ? list : []).map(safePath))].filter((n) => n && existsSync(inboxFull(n)));
      const clips = inInbox(files).filter((n) => kindOf(n) === 'video');
      if (!clips.length) return send(res, 400, { error: 'Those clips are not in your inbox anymore.' });
      const title = String(videoName).trim().slice(0, 80) || basename(clips[0]).replace(/\.[^.]+$/, '');
      const slug = newSlug(String(videoName).trim() || basename(clips[0]));
      const choice = contact?.type === 'person' && readPeople().some((x) => x.id === contact.id) ? { type: 'person', id: contact.id } : { type: 'all' };
      const learned = findStyle(style);
      const styleUse = learned?.ready && clean !== true ? learned : null;
      const brollNames = inInbox(broll).filter((n) => !clips.includes(n));
      const extraNames = inInbox(extra);
      const list = (ns) => ns.map((n) => `inbox/${n}`).join(', ');
      // Brand pictures and sounds the user attached, each with an optional "what it's for" note.
      const soundPath = (rel) => { const p = safePath(rel); return p && existsSync(join(dirs.sounds, ...p.split('/'))) ? `my-sounds/${p}` : null; };
      const assetLines = (Array.isArray(assets) ? assets : []).map((a) => {
        const ref = String(a?.ref || '');
        const note = String(a?.note || '').trim().slice(0, 200);
        let path = null;
        if (ref.startsWith('image:')) { const n = safeName(ref.slice(6)); if (n && kindOf(n) === 'image' && existsSync(join(imagesDir, n))) path = `my-brand/images/${n}`; }
        else if (ref.startsWith('sound:')) path = soundPath(ref.slice(6));
        return path ? `- ${path}${note ? ` — for: ${note}` : ''}` : null;
      }).filter(Boolean);
      // Background music: '' = editor decides (default), 'none' = no music, 'track:<path>' = use that track.
      let musicLine = '';
      const mus = String(music || '');
      if (mus === 'none') musicLine = 'Do not add any background music to this video. Keep the voice (and any sound effects) only.';
      else if (mus.startsWith('track:')) { const p = soundPath(mus.slice(6)); if (p) musicLine = `Use ${p} as the background music bed for this video, kept quiet under the voice.`; }
      const sfxLine = sfx === false
        ? 'Do not add any sound effects to this video.'
        : 'Add sound effects so the video feels lively, even if the style says voice only: a whoosh, pop, ding or similar on cuts, ' +
          'transitions, text cards, stickers and graphics, always quieter than the voice. Use effects from my-sounds/sfx/ (named by kind, like whoosh-2.wav) and any other sound in my-sounds/ under 15 seconds, when there are any; ' +
          'otherwise make simple ones with FFmpeg.';
      const multi = clips.length > 1 && (keepOrder
          ? `These ${clips.length} clips are parts of one video. Keep them in exactly this order, and drop retakes and false starts inside them.`
          : `These ${clips.length} clips are parts of one video, filmed as separate takes. Listen to all of them, put them in story order, and drop retakes and false starts. Copy each into assets/raw/ and keep the originals untouched.`);
      const notes = String(instructions).trim() ? `Notes from me for this video: ${String(instructions).trim()}` : '';
      // Clean raw: cuts and voice cleanup only, so none of the look, sound or contact choices apply.
      const prompt = (clean === true ? [
        `edit this: ${list(clips)}`, multi,
        `Clean raw edit: follow "Clean raw edit" in CLAUDE.md. Use the slug "${slug}" exactly, and save the first draft as outbox/${slug}-v1.mp4.`,
        notes,
      ] : [
        `edit this: ${list(clips)}`,
        multi,
        preview === true
          ? `Use the slug "${slug}" exactly. Preview first: follow "Preview first" in CLAUDE.md. Save the 5-second sample as outbox/${slug}-preview.mp4 ` +
            `and the storyboard frames as outbox/${slug}-preview-01.jpg, -02.jpg, and so on. Do not render the full draft until I say it looks good.`
          : `Use the slug "${slug}" exactly, and save the first draft as outbox/${slug}-v1.mp4.`,
        brollNames.length ? `These inbox clips are B-roll for this video: ${list(brollNames)}.` : '',
        extraNames.length ? `Also use these inbox files: ${list(extraNames)}.` : '',
        assetLines.length ? `Use these brand assets in this video, each for the purpose noted:\n${assetLines.join('\n')}` : '',
        musicLine,
        sfxLine,
        contactPrompt(choice),
        styleUse ? stylePrompt(styleUse.id) : '',
        notes,
      ]).filter(Boolean).join('\n');
      const reqObj = { id: randomUUID(), type: 'edit', slug, title, prompt, styleId: styleUse?.id || null };
      saveProject({
        slug, title, source: clips[0], sources: clips, broll: brollNames, contact: choice, contactLabel: clean === true ? null : contactLabel(choice), clean: clean === true,
        style: styleUse?.id || null, styleName: styleUse?.name || null, createdAt: Date.now(), updatedAt: Date.now(),
        status: 'queued', sessionId: null, history: [], previewFirst: preview === true && clean !== true,
      });
      const r = request(reqObj);
      if (r.error) { rmSync(projectFile(slug), { force: true }); return send(res, 409, r); }
      noteAsked(slug, String(instructions).trim() || (clips.length > 1 ? `Make one video from these ${clips.length} clips.` : 'Edit this video.'), r, reqObj);
      pushState();
      return send(res, 200, { ok: true, slug, queued: Boolean(r.queued) });
    }

    if ((m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/(notes|final|horizontal|rename|retry|go)$/)) && req.method === 'POST') {
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
      } else if (action === 'go') {
        if (!p.preview || p.versions.length) return send(res, 400, { error: 'There is no preview waiting for this video.' });
        reqObj = { type: 'go', slug };
        said = 'Looks good. Make the full edit.';
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

    if ((m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/cut$/)) && req.method === 'POST') {
      const { from, start, end } = await body(req);
      const r = await quickEdit(m[1], safeName(from || ''), { cut: [start, end] });
      return send(res, r.error ? 409 : 200, r);
    }
    // The clip arrives as the request body and is kept in the project, where the AI can find it later.
    if ((m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/insert$/)) && req.method === 'PUT') {
      const name = safeName(url.searchParams.get('name')?.replace(/[\\/:*?"<>|]/g, '_'));
      if (!name || kindOf(name) !== 'video') return send(res, 400, { error: 'That needs to be a video file.' });
      if (!versionsBySlug().has(m[1])) return send(res, 404, { error: 'Project not found.' });
      const dir = join(root, 'kit', 'video-projects', m[1], 'assets', 'added');
      mkdirSync(dir, { recursive: true });
      const clip = join(dir, freeName(dir, name));
      try { await pipeline(req, createWriteStream(clip)); } catch { rmSync(clip, { force: true }); return send(res, 500, { error: 'Could not save the clip. Is the disk full?' }); }
      const r = await quickEdit(m[1], safeName(url.searchParams.get('from') || ''), { at: url.searchParams.get('at'), clip });
      if (r.error) rmSync(clip, { force: true });
      return send(res, r.error ? 409 : 200, r);
    }

    // ---------- background replacement (clean raw videos) ----------
    if ((m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/bg\/photo$/)) && req.method === 'PUT') {
      const p = listProjects().find((x) => x.slug === m[1]);
      if (!p?.clean) return send(res, 404, { error: 'Background replacement is for clean raw videos.' });
      const ext = extname(String(url.searchParams.get('name') || '')).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return send(res, 400, { error: 'That needs to be a JPG, PNG or WebP photo.' });
      const dir = bg.dirOf(m[1]);
      mkdirSync(dir, { recursive: true });
      const name = `photo${ext}`;
      try { await pipeline(req, createWriteStream(join(dir, name))); } catch { return send(res, 500, { error: 'Could not save the photo. Is the disk full?' }); }
      bg.photoSaved(m[1], name);
      return send(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/bg\/(check|prices|plate-price|plate|generate|again)$/)) && req.method === 'POST') {
      const [, slug, action] = m;
      const p = listProjects().find((x) => x.slug === slug);
      if (!p?.clean) return send(res, 404, { error: 'Background replacement is for clean raw videos.' });
      const src = cleanSource(slug);
      if (!src) return send(res, 400, { error: 'There is no clean version yet.' });
      const b = await body(req);
      try {
        if (action === 'check') {
          const reqObj = { type: 'bgcheck', slug };
          const r = request(reqObj);
          if (r.error) return send(res, 409, r);
          noteAsked(slug, 'Check my background photo.', r, reqObj);
          return send(res, 200, { ok: true, queued: Boolean(r.queued) });
        }
        if (action === 'prices') { bg.prices(slug, src); return send(res, 200, { ok: true }); }
        if (action === 'plate-price') return send(res, 200, { credits: await bg.platePrice(slug, src) });
        if (action === 'plate') { bg.makePlate(slug, src); return send(res, 200, { ok: true }); }
        const opts = { onDone: (model, file) => saveBgVersion(slug, model, file) };
        if (action === 'generate') bg.generate(slug, Array.isArray(b.picks) ? b.picks.slice(0, 4) : [], b.prompt, opts);
        else bg.again(slug, String(b.key || ''), b.chunk ? String(b.chunk) : null, opts);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 409, { error: e.message }); }
    }
    // Pictures from the background work folder: the photo, the reference, and the boundary stills.
    if ((m = path.match(/^\/bgfile\/([a-z0-9-]+)\/((?:runs\/[a-z]+-\d+p\/boundaries\/)?[a-z0-9_.]+\.(?:jpe?g|png|webp))$/))) {
      return serveFile(req, res, join(bg.dirOf(m[1]), ...m[2].split('/')));
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
        const reply = readJson(join(data, 'style-reply.json'), null);
        const extra = m[1] === 'style' ? { reply: reply?.styleId ? null : reply } : {};
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
      const { text, styleId = null } = await body(req);
      const st = styleId ? findStyle(styleId) : null;
      if (styleId && !st?.ready) return send(res, 404, { error: 'That style is not here anymore.' });
      if (!st && locked()) return send(res, 423, { error: 'Your style comes from your brand pack, so it cannot be changed here.' });
      if (!String(text || '').trim()) return send(res, 400, { error: 'Describe the change first.' });
      const r = request({ type: 'style', styleId: st?.id || null, title: st ? st.name : 'Your style', text: String(text).trim() });
      return send(res, r.error ? 409 : 200, r);
    }

    if (path === '/api/style/rename' && req.method === 'POST') {
      const s = getSettings();
      s.mainStyleName = clean((await body(req)).name, 60);
      writeJson(settingsFile, s);
      pushState();
      return send(res, 200, { ok: true });
    }

    // A sample video becomes a new named style: save it in my-styles/<id>/, then the editor studies it.
    if (path === '/api/styles/learn' && req.method === 'PUT') {
      const name = clean(url.searchParams.get('name'), 60);
      const ext = extname(String(url.searchParams.get('file') || '')).toLowerCase();
      if (!name) return send(res, 400, { error: 'Give the style a name first.' });
      if (!VIDEO.has(ext)) return send(res, 400, { error: 'That needs to be a video (MP4 or MOV).' });
      const id = newStyleId(name);
      mkdirSync(styleDir(id), { recursive: true });
      const tmp = join(styleDir(id), `.uploading-${randomUUID()}`);
      try { await pipeline(req, createWriteStream(tmp)); } catch {
        rmSync(styleDir(id), { recursive: true, force: true });
        return send(res, 500, { error: 'Could not save the video. Is the disk full?' });
      }
      renameSync(tmp, join(styleDir(id), `source${ext}`));
      writeJson(join(styleDir(id), 'meta.json'), { name, createdAt: Date.now() });
      const r = request({ type: 'learn', styleId: id, title: `Learning “${name}”` });
      pushState();
      return send(res, r.error ? 409 : 200, { ...r, id });
    }
    if ((m = path.match(/^\/api\/styles\/([a-z0-9-]+)(?:\/(rename|retry|duplicate))?$/))) {
      const st = findStyle(m[1]);
      if (!st) return send(res, 404, { error: 'That style is not here anymore.' });
      const busyHere = job?.styleId === st.id || queue.some((q) => q.styleId === st.id);
      if (!m[2] && req.method === 'GET') {
        const reply = readJson(join(data, 'style-reply.json'), null);
        return send(res, 200, { text: readText(join(styleDir(st.id), 'style.md')), reply: reply?.styleId === st.id ? reply : null });
      }
      if (m[2] === 'rename' && req.method === 'POST') {
        const name = clean((await body(req)).name, 60);
        if (!name) return send(res, 400, { error: 'Give the style a name.' });
        if (busyHere) return send(res, 409, { error: 'Wait until the editor is done with this style.' });
        const f = join(styleDir(st.id), 'meta.json');
        writeJson(f, { ...readJson(f, {}), name });
        const doc = join(styleDir(st.id), 'style.md');
        const text = readText(doc);
        if (text) writeFileSync(doc, text.replace(/^# .*$/m, `# ${name}`));
        pushState();
        return send(res, 200, { ok: true });
      }
      // A full copy (sample video and storyboard too) under a new name, so it works as a backup.
      // A branded copy then has the editor swap its colors, gradients and fonts for the brand look.
      if (m[2] === 'duplicate' && req.method === 'POST') {
        if (busyHere) return send(res, 409, { error: 'Wait until the editor is done with this style.' });
        const branded = Boolean((await body(req)).branded);
        if (branded && !lookReady()) return send(res, 400, { error: 'Add your brand colors or fonts in My brand first.' });
        const name = clean(`${st.name.slice(0, 51)} (${branded ? 'brand' : 'copy'})`, 60);
        const id = newStyleId(name);
        try {
          cpSync(styleDir(st.id), styleDir(id), { recursive: true });
        } catch {
          rmSync(styleDir(id), { recursive: true, force: true });
          return send(res, 500, { error: 'Could not copy the style. Is the disk full?' });
        }
        const f = join(styleDir(id), 'meta.json');
        writeJson(f, { ...readJson(f, {}), name, createdAt: Date.now() });
        const doc = join(styleDir(id), 'style.md');
        const text = readText(doc);
        if (text) writeFileSync(doc, text.replace(/^# .*$/m, `# ${name}`));
        const r = branded ? request({ type: 'style', styleId: id, title: name, text: 'Brand this copied style. Follow "Branding a copied style" in CLAUDE.md.' }) : {};
        pushState();
        return send(res, 200, { ok: true, id, name, queued: r.queued, ahead: r.ahead });
      }
      if (m[2] === 'retry' && req.method === 'POST') {
        if (busyHere) return send(res, 409, { error: 'The editor is already on this style.' });
        const r = request({ type: 'learn', styleId: st.id, title: `Learning “${st.name}”` });
        pushState();
        return send(res, r.error ? 409 : 200, r);
      }
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
      if (typeof b.brandCheck === 'boolean') s.brandCheck = b.brandCheck;
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
for (const dir of [dirs.outbox, dirs.sounds, dirs.brand, brollDir, dirs.styles]) {
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
// Closing the Terminal window sends SIGHUP. The edit runs in its own process group, so without this it kept
// running unseen after the app closed, and a restarted app could start a second edit on the same video.
process.on('SIGHUP', shutdown);
