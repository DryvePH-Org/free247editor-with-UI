// The hand editor's edit list: one track of parts played in order, sound clips mixed over them, and marks for the AI.
// Pure helpers only (no files, no processes), so they can be tested on their own.

export const MAX_PARTS = 200;
export const MAX_MARKS = 50;
export const MAX_SOUNDS = 50;
export const MAX_NOTE = 300;
export const MAX_VOLUME = 5; // 500%: quiet phone recordings need a big boost
export const FPS = 30;
const RATE = 48000;

const clampNum = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const evenDown = (n) => Math.floor(n / 2) * 2;
const sec = (t) => Number(t).toFixed(3);
export const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
export const totalLength = (parts) => parts.reduce((s, p) => s + (p.out - p.in), 0);

const hasSound = (s) => s.kind === 'sound' || Boolean(s.audio);

// Checks parts, marks and sound clips from the browser against the edit's sources. Numbers are clamped into
// range; anything that cannot be fixed by clamping is an error in plain words. No audio sent keeps the saved ones.
export function cleanEdit(edit, { parts, marks = [], audio = edit.audio || [] } = {}) {
  if (!Array.isArray(parts) || !Array.isArray(marks) || !Array.isArray(audio)) return { error: 'The edit was not readable. Reload the page.' };
  if (parts.length > MAX_PARTS) return { error: `Keep it to ${MAX_PARTS} parts or fewer.` };
  if (marks.length > MAX_MARKS) return { error: `Keep it to ${MAX_MARKS} marks or fewer.` };
  if (audio.length > MAX_SOUNDS) return { error: `Keep it to ${MAX_SOUNDS} sound clips or fewer.` };
  const byId = new Map(edit.sources.map((s) => [s.id, s]));
  const outParts = [];
  for (const p of parts) {
    const s = byId.get(p?.src);
    if (!s || s.kind === 'sound') return { error: 'A part uses a clip that is not in this edit. Reload the page.' };
    const inT = clampNum(p.in, 0, s.duration);
    const outT = clampNum(p.out, 0, s.duration);
    const zoom = clampNum(p.zoom ?? 1, 0.5, 3);
    const x = clampNum(p.x ?? 0.5, 0, 1);
    const y = clampNum(p.y ?? 0.5, 0, 1);
    const volume = clampNum(p.volume ?? 1, 0, MAX_VOLUME);
    if ([inT, outT, zoom, x, y, volume].includes(null)) return { error: 'A part has a time or zoom that is not a number. Reload the page.' };
    if (outT - inT < 0.05) return { error: 'A part is too short. Make each part longer than a split second.' };
    outParts.push({ src: s.id, in: inT, out: outT, zoom, x, y, volume });
  }
  const total = totalLength(outParts);
  const outMarks = [];
  for (const m of marks) {
    const start = clampNum(m?.start, 0, total);
    const end = clampNum(m?.end, 0, total);
    const b = m?.box || {};
    const bx = clampNum(b.x, 0, 1);
    const by = clampNum(b.y, 0, 1);
    if ([start, end, bx, by].includes(null)) return { error: 'A mark has a time or box that is not a number. Reload the page.' };
    const bw = clampNum(b.w, 0, 1 - bx);
    const bh = clampNum(b.h, 0, 1 - by);
    if (bw === null || bh === null) return { error: 'A mark has a box that is not a number. Reload the page.' };
    if (!(end > start)) return { error: 'A mark has to end after it starts.' };
    if (bw < 0.01 || bh < 0.01) return { error: 'A mark box is too small. Draw it a little bigger.' };
    outMarks.push({ start, end, box: { x: bx, y: by, w: bw, h: bh }, note: String(m.note ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_NOTE) });
  }
  const outAudio = [];
  const ids = new Set();
  for (const a of audio) {
    const s = byId.get(a?.src);
    if (!s || !hasSound(s)) return { error: 'A sound clip uses a sound that is not in this edit. Reload the page.' };
    const inT = clampNum(a.in, 0, s.duration);
    const outT = clampNum(a.out, 0, s.duration);
    const at = clampNum(a.at, 0, 86400);
    const volume = clampNum(a.volume ?? 1, 0, MAX_VOLUME);
    if ([inT, outT, at, volume].includes(null)) return { error: 'A sound clip has a time or volume that is not a number. Reload the page.' };
    if (outT - inT < 0.05) return { error: 'A sound clip is too short. Make it longer than a split second.' };
    // The screen names clips; a missing or repeated name gets a new one so each stays unique.
    let id = /^[\w-]{1,40}$/.test(String(a.id ?? '')) && !ids.has(a.id) ? a.id : null;
    for (let n = outAudio.length + 1; !id; n++) if (!ids.has(`a${n}`) && !audio.some((x) => x?.id === `a${n}`)) id = `a${n}`;
    ids.add(id);
    outAudio.push({ id, src: s.id, in: inT, out: outT, at, volume });
  }
  return { parts: outParts, marks: outMarks, audio: outAudio };
}

// Where a scaled picture (size S) sits in the frame (size F) along one axis, with point p (0-1) of
// the picture at the frame centre. clamp: slide it back so no empty edge shows (zoom >= 1).
export function place(F, S, p, clamp) {
  let off = F / 2 - p * S;
  if (clamp) off = Math.min(0, Math.max(F - S, off));
  const cropAt = evenDown(Math.max(0, -off));
  const padAt = evenDown(Math.max(0, off));
  return { cropAt, padAt, len: evenDown(Math.min(S - cropAt, F - padAt)) };
}

// Video filter for one part: scale to fill the frame times zoom, crop to the frame, black edges if smaller.
export function partVideoFilter(src, part, W, H) {
  const s = Math.max(W / src.width, H / src.height) * part.zoom;
  const SW = even(src.width * s);
  const SH = even(src.height * s);
  const h = place(W, SW, part.x, part.zoom >= 1);
  const v = place(H, SH, part.y, part.zoom >= 1);
  const pad = h.len < W || v.len < H ? `,pad=${W}:${H}:${h.padAt}:${v.padAt}:color=black` : '';
  return `scale=${SW}:${SH},crop=${h.len}:${v.len}:${h.cropAt}:${v.cropAt}${pad},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS`;
}

// h264_videotoolbox is the Mac's hardware encoder: several times faster than libx264 on an M1.
export const encoderArgs = (hardware) => [
  ...(hardware ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-allow_sw', '1', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']),
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4',
];

// ffmpeg arguments that render the whole edit in one pass. Each part is its own input, cut with
// input seeking (fast, frame-accurate when re-encoding), so a reordered part never makes ffmpeg hold
// many decoded frames while it waits. files: source id -> path; audio: source id -> its number of sound channels (0 = none).
export function renderArgs(edit, { files, audio, hardware, out }) {
  const W = edit.width;
  const H = edit.height;
  const byId = new Map(edit.sources.map((s) => [s.id, s]));
  const inputs = [];
  const graph = [];
  const order = [];
  // Mono goes to both sides at full level; the default upmix puts it 3 dB lower.
  const stereo = (id) => (audio[id] === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '');
  edit.parts.forEach((p, i) => {
    const src = byId.get(p.src);
    const d = sec(p.out - p.in);
    inputs.push('-ss', sec(p.in), '-t', d, '-i', files[p.src]);
    graph.push(`[${i}:v]${partVideoFilter(src, p, W, H)}[v${i}]`);
    const vol = p.volume ?? 1;
    const af = `aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_dur=${d}${vol !== 1 ? `,volume=${vol}` : ''}`;
    graph.push(audio[p.src] ? `[${i}:a]${stereo(p.src)}${af}[a${i}]` : `anullsrc=r=${RATE}:cl=stereo,atrim=end=${d},${af}[a${i}]`);
    order.push(`[v${i}][a${i}]`);
  });
  // Sound clips play over the parts' sound, each from its own input, delayed to its place. Past the end they are dropped.
  const total = totalLength(edit.parts);
  const clips = (edit.audio || []).filter((a) => a.at < total - 0.01);
  // Boosted or mixed sound can go past full scale; a limiter stops the crackle and leaves normal levels alone.
  const limit = clips.length || edit.parts.some((p) => (p.volume ?? 1) > 1);
  const last = limit ? 'mix' : 'a';
  graph.push(`${order.join('')}concat=n=${edit.parts.length}:v=1:a=1[v][${clips.length ? 'base' : last}]`);
  clips.forEach((a, k) => {
    const j = edit.parts.length + k;
    inputs.push('-ss', sec(a.in), '-t', sec(Math.min(a.out - a.in, total - a.at)), '-i', files[a.src]);
    graph.push(`[${j}:a]${stereo(a.src)}aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${a.volume ?? 1},` +
      `adelay=${Math.round(a.at * 1000)}:all=1[s${k}]`);
  });
  if (clips.length) graph.push(`[base]${clips.map((_, k) => `[s${k}]`).join('')}amix=inputs=${clips.length + 1}:duration=first:normalize=0[${last}]`);
  if (limit) graph.push('[mix]alimiter=limit=0.95:level=0:latency=1[a]');
  return [...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]', ...encoderArgs(hardware), out];
}

// A still of the rendered video in the middle of a mark, with its box drawn in red.
export function markStillArgs(video, m, still) {
  const { x, y, w, h } = m.box;
  return ['-ss', sec((m.start + m.end) / 2), '-i', video, '-frames:v', '1',
    '-vf', `drawbox=x=iw*${x.toFixed(4)}:y=ih*${y.toFixed(4)}:w=iw*${w.toFixed(4)}:h=ih*${h.toFixed(4)}:color=red:t=8,scale=-2:960`, '-q:v', '3', still];
}

const pct = (v) => `${Math.round(v * 100)}%`;
const loudness = (v = 1) => (v === 0 ? ' sound muted' : v !== 1 ? ` sound at ${pct(v)}` : '');

// One line per part for the AI, which never sees the edit list: source file, times, zoom, centre and sound.
export function describeParts(edit) {
  const byId = new Map(edit.sources.map((s) => [s.id, s]));
  return edit.parts.map((p, i) => `${i + 1}) ${byId.get(p.src).file} ${clock(p.in)}–${clock(p.out)}` +
    `${p.zoom !== 1 || p.x !== 0.5 || p.y !== 0.5 ? ` zoomed ${p.zoom.toFixed(2)}x centred at ${pct(p.x)} across, ${pct(p.y)} down` : ''}${loudness(p.volume)}`).join('; ');
}

// The sound clips mixed over the parts' sound, for the AI: file, times in it, where it starts, volume. Ones past the end are not in the video.
export function describeSounds(edit) {
  const byId = new Map(edit.sources.map((s) => [s.id, s]));
  const total = totalLength(edit.parts);
  return (edit.audio || []).filter((a) => a.at < total - 0.01).map((a, i) => `${i + 1}) sound of ${byId.get(a.src).file} ${clock(a.in)}–${clock(a.out)} placed at ${clock(a.at)}, ` +
    `volume ${pct(a.volume ?? 1)}`).join('; ');
}

// One line per mark for the AI: the time on the rendered video, the box as % of the frame, the note, the still.
export function describeMarks(marks, stillPath) {
  return marks.map((m, i) => `- Mark ${i + 1}, ${clock(m.start)} to ${clock(m.end)}: a box ${pct(m.box.x)} from the left, ${pct(m.box.y)} from the top, ` +
    `${pct(m.box.w)} wide and ${pct(m.box.h)} tall. Note: ${m.note || '(none, fix what looks wrong in the box)'}. Still: ${stillPath(i + 1)}`);
}

// "Fix with AI" on a mark: the parts that play between output times a and b, trimmed to them. Slivers under
// 0.05 s are dropped, the shortest part the edit list allows.
export function partsBetween(parts, a, b) {
  const out = [];
  let t = 0;
  for (const p of parts) {
    const len = p.out - p.in;
    const s = Math.max(a, t);
    const e = Math.min(b, t + len);
    if (e - s >= 0.05) out.push({ ...p, in: p.in + (s - t), out: p.in + (e - t) });
    t += len;
  }
  return out;
}
// Just the marked stretch, with no sound clips (they stay on the timeline, so the piece must not carry them too).
export const sliceEdit = (edit, a, b) => ({ ...edit, parts: partsBetween(edit.parts, a, b), audio: [], marks: [] });
// The fixed piece goes back in place of a..b.
export const spliceParts = (parts, a, b, part) => [...partsBetween(parts, 0, a), part, ...partsBetween(parts, b, Infinity)];
