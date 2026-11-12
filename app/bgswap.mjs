// Background replacement for clean raw videos, with the Higgsfield CLI. Every paid step starts only from a
// button the user confirmed with the price shown. The background check itself is an editor job in server.mjs.
//
// Work folder: kit/video-projects/<slug>/bgswap/
//   photo.*              the user's background photo          check.json, prompt.txt, background_9x16.png  from the check
//   plate.png            angle-matched empty room (optional)  chunks/  the clean video split at pauses
//   runs/<model>-<res>/  gen/ (downloads), final.mp4, boundaries/, sync_report.json
//   generation_log.md    every setting, prompt and job id      state.json  what the app shows
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODELS = {
  kling: { id: 'kling4_0', name: 'Kling 4.0', args: ['--mode', 'video-edit'] },
  seedance: { id: 'seedance_2_5', name: 'Seedance 2.5', args: ['--mode', 'video_edit', '--generate_audio', 'false'] },
};
export const RESOLUTIONS = ['720p', '1080p'];
// Longest part, in seconds (Kling and Seedance allow 3-30 s); fewer parts mean fewer joins.
// Changing this re-splits a video on its next "Get prices".
const PART_MAX = 30;
const PLATE_MODEL = 'nano_banana_2_1';
const PLATE_PROMPT = 'Image 1 shows the camera: its position, height, angle and lens. Image 2 shows a room. Make a photo of the ' +
  'empty room from image 2, taken from exactly the camera position, height, angle and lens of image 1, with the main seat where ' +
  'the person sits in image 1. Keep the room\'s furniture, walls, objects and light. No people. No coffee table or other objects ' +
  'in front of the seat. Photorealistic, natural phone-camera look.';

const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

// Runs a command without a shell; resolves stdout, rejects with the last error line.
function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.trim()); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' && cmd === 'higgsfield'
      ? 'The Higgsfield tool is not installed. In a terminal run: npm i -g @higgsfield/cli, then higgsfield auth login.' : e.message)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(plainError(err || out)))));
  });
}
function plainError(text) {
  if (/workspace/i.test(text)) return 'Higgsfield has no workspace picked. In a terminal run: higgsfield workspace list, then higgsfield workspace set <id>.';
  if (/auth|login|token|401/i.test(text)) return 'Higgsfield is not signed in. In a terminal run: higgsfield auth login.';
  if (/credit|balance|insufficient/i.test(text)) return 'Not enough Higgsfield credits for this.';
  return text.trim().split('\n').filter(Boolean).pop() || 'Higgsfield did not answer.';
}
// The CLI gives up an upload after ~60 s, so a slow moment on home internet fails it; try up to 3 times.
async function upload(file) {
  for (let i = 1; ; i++) {
    try { return (await run('higgsfield', ['upload', 'create', file])).trim().split('\n').pop(); } catch (e) { if (i === 3) throw e; }
  }
}
const credits = (text) => Number(String(text).match(/([\d.]+)\s*credits/)?.[1] ?? NaN);

export function createBgSwap({ root, onChange }) {
  const tools = join(root, 'tools', 'bgswap');
  const dirOf = (slug) => join(root, 'kit', 'video-projects', slug, 'bgswap');
  const load = (slug) => readJson(join(dirOf(slug), 'state.json'), {});
  const save = (slug, st) => { mkdirSync(dirOf(slug), { recursive: true }); writeFileSync(join(dirOf(slug), 'state.json'), JSON.stringify(st, null, 2)); onChange(); };
  const update = (slug, fn) => { const st = load(slug); fn(st); save(slug, st); return st; };
  const live = new Set(); // `${slug}/${key}` runs with a process right now
  const busy = new Map(); // slug -> what a free step is doing now ("Getting prices")
  const log = (slug, text) => { mkdirSync(dirOf(slug), { recursive: true }); writeFileSync(join(dirOf(slug), 'generation_log.md'), `${readText(join(dirOf(slug), 'generation_log.md'))}${text}\n`); };
  const reference = (slug) => (existsSync(join(dirOf(slug), 'plate.png')) ? 'plate.png' : 'background_9x16.png');

  async function task(slug, label, fn) {
    if (busy.has(slug)) throw new Error(`Still busy: ${busy.get(slug)}.`);
    busy.set(slug, label); update(slug, (st) => { delete st.error; });
    try { await fn(); } catch (e) { update(slug, (st) => { st.error = e.message; }); } finally { busy.delete(slug); onChange(); }
  }

  // What the page shows. Runs left "running" by a closed app become "interrupted".
  function view(slug) {
    const d = dirOf(slug);
    if (!existsSync(d)) return null;
    const st = load(slug);
    for (const [key, r] of Object.entries(st.runs || {})) if (r.status === 'running' && !live.has(`${slug}/${key}`)) r.status = 'interrupted';
    return {
      photo: st.photo || null, check: readJson(join(d, 'check.json'), null), prompt: readText(join(d, 'prompt.txt')).trim(),
      reference: existsSync(join(d, reference(slug))) ? reference(slug) : null, plate: existsSync(join(d, 'plate.png')),
      quote: (st.partMax === PART_MAX && st.quote) || null, runs: /* prices for an older split are stale */ st.runs || {}, busy: busy.get(slug) || null, error: st.error || null, stamp: st.stamp || 0,
    };
  }

  function photoSaved(slug, name) {
    const d = dirOf(slug);
    for (const f of ['check.json', 'prompt.txt', 'background_9x16.png', 'plate.png']) rmSync(join(d, f), { force: true });
    for (const f of readdirSync(d)) if (/^photo\./.test(f) && f !== name) rmSync(join(d, f), { force: true });
    update(slug, (st) => { st.photo = name; st.stamp = Date.now(); delete st.quote; delete st.refUpload; });
  }

  // Splits the clean video, uploads chunks and the reference once, and quotes every model x quality.
  // Quotes use the real chunk files (Seedance prices from the video's length) and each chunk's --duration, rounded up
  // (Kling prices from --duration, which defaults to 10 s whatever the video's length).
  const prices = (slug, source) => task(slug, 'Getting prices', async () => {
    const d = dirOf(slug), ref = reference(slug);
    if (!existsSync(join(d, ref))) throw new Error('Check the background first.');
    let st = load(slug);
    if (st.source !== source.name || !st.chunks?.length || st.partMax !== PART_MAX) {
      // Unfinished runs hold parts of the old split, which would mix into the new one. Never drop a paid job in flight.
      const unfinished = Object.keys(st.runs || {}).filter((k) => st.runs[k].status !== 'done');
      for (const k of unfinished) {
        const gen = join(d, 'runs', k, 'gen');
        if (live.has(`${slug}/${k}`) || (existsSync(gen) && readdirSync(gen).some((f) => f.endsWith('.pending'))))
          throw new Error(`${MODELS[st.runs[k].model].name} ${st.runs[k].res} still has a job going. Let it finish (press Continue) first.`);
      }
      for (const k of unfinished) rmSync(join(d, 'runs', k), { recursive: true, force: true });
      update(slug, (s) => { for (const k of unfinished) delete s.runs[k]; });
      rmSync(join(d, 'chunks'), { recursive: true, force: true });
      await run('python3', ['-I', join(tools, 'chunks.py'), source.path, join(d, 'chunks'), '--max', String(PART_MAX), '--min', '4']);
      const chunks = readJson(join(d, 'chunks', 'chunks.json'), []);
      for (const c of chunks) c.upload = await upload(c.file);
      st = update(slug, (s) => { s.source = source.name; s.sourcePath = source.path; s.chunks = chunks; s.partMax = PART_MAX; });
    }
    const refUpload = await upload(join(d, ref));
    const balance = credits(await run('higgsfield', ['account', 'status']));
    const rows = [];
    for (const [model, m] of Object.entries(MODELS)) {
      for (const res of RESOLUTIONS) {
        const perChunk = [];
        for (const c of st.chunks) {
          perChunk.push(credits(await run('higgsfield', ['generate', 'cost', m.id, '--prompt', 'quote', ...m.args, '--resolution', res, '--duration', String(Math.ceil(c.end - c.start)),
            '--aspect_ratio', '9:16', '--video-references', c.upload, '--image-references', refUpload])));
        }
        rows.push({ model, name: m.name, res, perChunk, total: Math.round(perChunk.reduce((a, b) => a + b, 0) * 100) / 100 });
      }
    }
    const seconds = st.chunks.reduce((a, c) => a + c.end - c.start, 0);
    update(slug, (s) => { s.refUpload = refUpload; s.refFor = ref; s.quote = { at: Date.now(), balance, rows, seconds, chunks: st.chunks.length }; });
  });

  // A frame of the clean video shows the model the camera angle to match.
  const cameraFrame = (slug, source) => run('ffmpeg', ['-y', '-v', 'error', '-ss', '2', '-i', source.path, '-frames:v', '1', '-q:v', '2',
    join(dirOf(slug), 'camera_frame.jpg')]);
  const plateArgs = (slug) => ['--prompt', PLATE_PROMPT, '--aspect_ratio', '9:16', '--resolution', '2k',
    '--image-references', join(dirOf(slug), 'camera_frame.jpg'), '--image-references', join(dirOf(slug), load(slug).photo)];
  const platePrice = async (slug, source) => {
    if (!load(slug).photo) throw new Error('Add a background photo first.');
    await cameraFrame(slug, source);
    return credits(await run('higgsfield', ['generate', 'cost', PLATE_MODEL, ...plateArgs(slug)]));
  };

  // An empty room photographed from the video's own camera angle (the user confirmed the price).
  const makePlate = (slug, source) => task(slug, 'Making an angle-matched background', async () => {
    const d = dirOf(slug);
    await cameraFrame(slug, source);
    const out = await run('higgsfield', ['generate', 'create', PLATE_MODEL, ...plateArgs(slug), '--json']);
    const id = JSON.parse(out)[0];
    log(slug, `\n## Angle-matched background ${new Date().toISOString()}\n- model ${PLATE_MODEL}, 2k, 9:16, job ${id}\n- prompt: ${PLATE_PROMPT}`);
    const job = JSON.parse(await run('higgsfield', ['generate', 'wait', id, '--timeout', '20m', '--json']));
    if (job.status !== 'completed' || !job.result_url) throw new Error(`The background job ended: ${job.status}.`);
    await run('curl', ['-sSfL', '-o', join(d, 'plate.png'), job.result_url]);
    rmSync(join(d, 'check.json'), { force: true });
    update(slug, (s) => { s.stamp = Date.now(); delete s.quote; delete s.refUpload; });
  });

  // One process per model+quality, each one job at a time (hf_run.sh); different models run side by side.
  function startRun(slug, key, { onDone }) {
    const st = load(slug), r = st.runs[key], m = MODELS[r.model], d = dirOf(slug), dir = join(d, 'runs', key);
    mkdirSync(join(dir, 'gen'), { recursive: true });
    for (const c of st.chunks) if (c.upload) writeFileSync(c.file.replace(/\.mp4$/, '.upload'), c.upload); // hf_run.sh reuses these
    live.add(`${slug}/${key}`);
    update(slug, (s) => { Object.assign(s.runs[key], { status: 'running', error: null }); });
    const prompt = readText(join(d, 'prompt.txt')).trim();
    run('bash', [join(tools, 'hf_run.sh'), m.id, join(d, 'chunks'), join(dir, 'gen'), join(d, 'generation_log.md'), '--',
      '--prompt', prompt, ...m.args, '--resolution', r.res, '--aspect_ratio', '9:16', '--image-references', st.refUpload], {
      onLine: (l) => { if (/^done |^skip /.test(l)) update(slug, (s) => { s.runs[key].done = readdirSync(join(dir, 'gen')).filter((f) => /^chunk_\d+\.mp4$/.test(f)).length; }); },
    }).then(async () => {
      await run('python3', ['-I', join(tools, 'assemble.py'), st.sourcePath, join(d, 'chunks', 'chunks.json'), join(dir, 'gen'), join(dir, 'final.mp4')]);
      const file = onDone(r.model, join(dir, 'final.mp4'));
      update(slug, (s) => Object.assign(s.runs[key], {
        status: 'done', version: file, report: readJson(join(dir, 'sync_report.json'), []),
        boundaries: readdirSync(join(dir, 'boundaries')).filter((f) => f.endsWith('.jpg')).sort(),
      }));
    }).catch((e) => update(slug, (s) => Object.assign(s.runs[key], { status: 'error', error: e.message })))
      .finally(() => { live.delete(`${slug}/${key}`); onChange(); });
  }

  function generate(slug, picks, prompt, opts) {
    const st = load(slug);
    if (!st.quote || !st.refUpload || st.refFor !== reference(slug) || st.partMax !== PART_MAX) throw new Error('Get prices first.');
    const clean = picks.filter((p) => MODELS[p.model] && RESOLUTIONS.includes(p.res));
    if (!clean.length) throw new Error('Pick at least one model.');
    if (String(prompt || '').trim()) writeFileSync(join(dirOf(slug), 'prompt.txt'), String(prompt).trim().slice(0, 4000));
    const text = readText(join(dirOf(slug), 'prompt.txt')).trim();
    if (!text) throw new Error('There is no prompt yet. Check the background first.');
    for (const p of clean) {
      const key = `${p.model}-${p.res}`;
      if (live.has(`${slug}/${key}`)) continue;
      const row = st.quote.rows.find((x) => x.model === p.model && x.res === p.res);
      log(slug, `\n## ${MODELS[p.model].name} ${p.res} ${new Date().toISOString()}\n- source ${st.source}, reference ${reference(slug)} (upload ${st.refUpload})` +
        `\n- settings: ${MODELS[p.model].args.join(' ')} --resolution ${p.res} --aspect_ratio 9:16\n- quoted ${row?.total ?? '?'} credits for ${st.chunks.length} chunks\n- prompt: ${text}\n\n| time | model | chunk | job id | status |\n|---|---|---|---|---|`);
      const gen = join(dirOf(slug), 'runs', key, 'gen');
      // A stopped run may still have paid jobs in flight; starting over would pay for them twice.
      if (existsSync(gen) && readdirSync(gen).some((f) => f.endsWith('.pending'))) throw new Error(`${MODELS[p.model].name} ${p.res} was stopped mid-way. Press Continue on it instead.`);
      rmSync(gen, { recursive: true, force: true }); // a new run starts clean
      update(slug, (s) => { s.runs ||= {}; s.runs[key] = { model: p.model, res: p.res, done: 0, total: st.chunks.length }; });
      startRun(slug, key, opts);
    }
  }

  // Redo one chunk (the user confirmed its price) or continue an interrupted run. Downloaded chunks are kept.
  function again(slug, key, chunk, opts) {
    const r = load(slug).runs?.[key];
    if (!r) throw new Error('That run is not here anymore.');
    if (load(slug).partMax !== PART_MAX) throw new Error('The video gets cut into shorter parts now. Click Get prices first, then Generate.');
    if (live.has(`${slug}/${key}`)) throw new Error('That run is still going.');
    if (chunk) {
      if (!/^chunk_\d{2}$/.test(chunk)) throw new Error('Unknown chunk.');
      rmSync(join(dirOf(slug), 'runs', key, 'gen', `${chunk}.mp4`), { force: true });
    }
    startRun(slug, key, opts);
  }

  return { dirOf, view, photoSaved, prices, platePrice, makePlate, generate, again };
}
