import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEdit, describeMarks, describeParts, describeSounds, markStillArgs, partVideoFilter, partsBetween, place, renderArgs, sliceEdit, spliceParts } from './editor.mjs';

const edit = {
  width: 1080, height: 1920,
  sources: [
    { id: 's1', file: 'outbox/a-v1.mp4', duration: 20, width: 1080, height: 1920, audio: true },
    { id: 's2', file: 'kit/video-projects/a/editor/src/s2.mp4', duration: 5, width: 1920, height: 1080 },
    { id: 's3', kind: 'sound', file: 'my-sounds/sfx/whoosh-1.wav', duration: 2, audio: true },
    { id: 's4', kind: 'sound', file: 'my-sounds/song.mp3', duration: 60, audio: true },
  ],
  parts: [], marks: [],
};

test('cleanEdit clamps numbers and keeps good parts', () => {
  const r = cleanEdit(edit, { parts: [{ src: 's1', in: -2, out: 99, zoom: 9, x: 2, y: -1 }], marks: [] });
  assert.deepEqual(r.parts, [{ src: 's1', in: 0, out: 20, zoom: 3, x: 1, y: 0, volume: 1 }]);
  assert.deepEqual(cleanEdit(edit, { parts: [{ src: 's1', in: 1, out: 2, volume: 9 }] }).parts[0], { src: 's1', in: 1, out: 2, zoom: 1, x: 0.5, y: 0.5, volume: 5 });
});

test('cleanEdit rejects bad input', () => {
  assert.ok(cleanEdit(edit, { parts: [{ src: 'nope', in: 0, out: 1 }] }).error);
  assert.ok(cleanEdit(edit, { parts: [{ src: 's1', in: 3, out: 3 }] }).error);
  assert.ok(cleanEdit(edit, { parts: [{ src: 's1', in: '0', out: 1 }] }).error);
  assert.ok(cleanEdit(edit, { parts: 'x' }).error);
  assert.ok(cleanEdit(edit, { parts: Array(201).fill({ src: 's1', in: 0, out: 1 }) }).error);
  assert.ok(cleanEdit(edit, { parts: [], marks: Array(51).fill({ start: 0, end: 1, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }) }).error);
});

test('cleanEdit sound clips: ids kept or made unique, clamped, checked', () => {
  const parts = [{ src: 's1', in: 0, out: 4 }];
  const r = cleanEdit(edit, { parts, audio: [
    { id: 'x1', src: 's3', in: -1, out: 9, at: -3, volume: 7 },
    { id: 'x1', src: 's1', in: 0, out: 1, at: 2 },
    { src: 's4', in: 5, out: 10, at: 1, volume: 0.5 },
  ] });
  assert.deepEqual(r.audio, [
    { id: 'x1', src: 's3', in: 0, out: 2, at: 0, volume: 5 },
    { id: 'a2', src: 's1', in: 0, out: 1, at: 2, volume: 1 },
    { id: 'a3', src: 's4', in: 5, out: 10, at: 1, volume: 0.5 },
  ]);
  assert.ok(cleanEdit(edit, { parts, audio: [{ src: 'nope', in: 0, out: 1, at: 0 }] }).error);
  assert.ok(cleanEdit(edit, { parts, audio: [{ src: 's3', in: 1, out: 1, at: 0 }] }).error);
  assert.ok(cleanEdit(edit, { parts, audio: Array(51).fill({ src: 's3', in: 0, out: 1, at: 0 }) }).error);
  assert.ok(cleanEdit(edit, { parts: [{ src: 's3', in: 0, out: 1 }] }).error, 'a sound file is not a part');
  // A source without sound cannot be a sound clip; no audio sent keeps what is saved.
  assert.ok(cleanEdit({ ...edit, sources: [{ ...edit.sources[0], audio: false }] }, { parts, audio: [{ src: 's1', in: 0, out: 1, at: 0 }] }).error);
  assert.deepEqual(cleanEdit({ ...edit, audio: r.audio }, { parts }).audio, r.audio);
});

test('cleanEdit marks: clamped to the output length and frame, note cut to 300', () => {
  const r = cleanEdit(edit, {
    parts: [{ src: 's1', in: 0, out: 4 }],
    marks: [{ start: 1, end: 10, box: { x: 0.8, y: 0.1, w: 0.5, h: 0.2 }, note: `a\nb${'x'.repeat(400)}` }],
  });
  assert.equal(r.marks[0].end, 4);
  assert.equal(r.marks[0].box.w.toFixed(2), '0.20');
  assert.equal(r.marks[0].note.length, 300);
  assert.ok(!r.marks[0].note.includes('\n'));
  assert.ok(cleanEdit(edit, { parts: [{ src: 's1', in: 0, out: 4 }], marks: [{ start: 2, end: 1, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }).error);
});

test('place: zoom >= 1 never shows an empty edge', () => {
  assert.deepEqual(place(1080, 1620, 0, true), { cropAt: 0, padAt: 0, len: 1080 });
  assert.deepEqual(place(1080, 1620, 1, true), { cropAt: 540, padAt: 0, len: 1080 });
  assert.deepEqual(place(1080, 540, 0.5, false), { cropAt: 0, padAt: 270, len: 540 });
});

test('part filter: zoom in crops, zoom out pads black', () => {
  const s1 = edit.sources[0];
  assert.equal(partVideoFilter(s1, { zoom: 1.5, x: 0.5, y: 0.5 }, 1080, 1920),
    'scale=1620:2880,crop=1080:1920:270:480,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS');
  assert.match(partVideoFilter(s1, { zoom: 0.5, x: 0.5, y: 0.5 }, 1080, 1920), /scale=540:960,crop=540:960:0:0,pad=1080:1920:270:480:color=black/);
});

test('renderArgs: 2-part edit with zoom, an added clip without sound', () => {
  const e = { ...edit, parts: [{ src: 's1', in: 2, out: 6, zoom: 1.5, x: 0.5, y: 0.5 }, { src: 's2', in: 0, out: 3, zoom: 1, x: 0.5, y: 0.5 }] };
  const args = renderArgs(e, { files: { s1: '/o/a.mp4', s2: '/p/s2.mp4' }, audio: { s1: true, s2: false }, hardware: true, out: '/o/out.mp4' });
  assert.deepEqual(args.slice(0, 12), ['-ss', '2.000', '-t', '4.000', '-i', '/o/a.mp4', '-ss', '0.000', '-t', '3.000', '-i', '/p/s2.mp4']);
  const g = args[args.indexOf('-filter_complex') + 1].split(';');
  assert.equal(g[0], '[0:v]scale=1620:2880,crop=1080:1920:270:480,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v0]');
  assert.match(g[1], /^\[0:a\]aformat=.*apad=whole_dur=4\.000\[a0\]$/);
  assert.equal(g[2], '[1:v]scale=3414:1920,crop=1080:1920:1166:0,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v1]');
  assert.match(g[3], /^anullsrc=r=48000:cl=stereo,atrim=end=3\.000,.*\[a1\]$/);
  assert.equal(g[4], '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
  assert.ok(args.includes('h264_videotoolbox') && args.includes('+faststart') && args.at(-1) === '/o/out.mp4');
  assert.ok(renderArgs(e, { files: { s1: 'a', s2: 'b' }, audio: {}, hardware: false, out: 'o' }).includes('libx264'));
});

test('renderArgs mix: a muted part plus 2 overlapping sound clips, one starting past the end', () => {
  const e = { ...edit,
    parts: [{ src: 's1', in: 0, out: 4, zoom: 1, x: 0.5, y: 0.5, volume: 0 }, { src: 's1', in: 10, out: 12, zoom: 1, x: 0.5, y: 0.5, volume: 1.5 }],
    audio: [{ id: 'a1', src: 's4', in: 5, out: 15, at: 1.5, volume: 0.8 }, { id: 'a2', src: 's3', in: 0, out: 2, at: 2, volume: 1 }, { id: 'a3', src: 's3', in: 0, out: 2, at: 6, volume: 1 }] };
  const args = renderArgs(e, { files: { s1: 'v.mp4', s3: 'w.wav', s4: 'm.mp3' }, audio: { s1: 1, s3: 2, s4: 2 }, hardware: true, out: 'o.mp4' });
  // the long clip is cut to what fits before the video ends (6 - 1.5 s); the clip at 6 s is dropped
  assert.deepEqual(args.slice(12, 24), ['-ss', '5.000', '-t', '4.500', '-i', 'm.mp3', '-ss', '0.000', '-t', '2.000', '-i', 'w.wav']);
  assert.equal(args.filter((a) => a === '-i').length, 4);
  const g = args[args.indexOf('-filter_complex') + 1].split(';');
  assert.match(g[1], /^\[0:a\]pan=stereo\|c0=c0\|c1=c0,aformat=.*apad=whole_dur=4\.000,volume=0\[a0\]$/, 'mono is spread to both sides');
  assert.match(g[3], /,volume=1\.5\[a1\]$/);
  assert.equal(g[4], '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][base]');
  assert.match(g[5], /^\[2:a\].*volume=0\.8,adelay=1500:all=1\[s0\]$/);
  assert.match(g[6], /^\[3:a\].*adelay=2000:all=1\[s1\]$/);
  assert.equal(g[7], '[base][s0][s1]amix=inputs=3:duration=first:normalize=0[mix]');
  assert.equal(g[8], '[mix]alimiter=limit=0.95:level=0:latency=1[a]', 'mixed or boosted sound is limited, not clipped');
  assert.equal(g.length, 9);
});

test('old edit lists without volume or audio render as before', () => {
  const e = { ...edit, parts: [{ src: 's1', in: 0, out: 2, zoom: 1, x: 0.5, y: 0.5 }] };
  const g = renderArgs(e, { files: { s1: 'v.mp4' }, audio: { s1: true }, hardware: false, out: 'o' }).join(' ');
  assert.ok(!g.includes('volume=') && !g.includes('amix') && !g.includes('alimiter') && g.includes('concat=n=1:v=1:a=1[v][a]'));
});

test('describe parts and sound clips for the AI', () => {
  const e = { ...edit, parts: [{ src: 's1', in: 0, out: 2, zoom: 1, x: 0.5, y: 0.5, volume: 0 }, { src: 's1', in: 2, out: 3, zoom: 1, x: 0.5, y: 0.5, volume: 1.2 }],
    audio: [{ id: 'a1', src: 's4', in: 0, out: 5, at: 1, volume: 0.5 }, { id: 'a2', src: 's3', in: 0, out: 1, at: 3 }] };
  assert.match(describeParts(e), /0:00\.0–0:02\.0 sound muted; 2\) .* sound at 120%$/);
  assert.equal(describeSounds(e), '1) sound of my-sounds/song.mp3 0:00.0–0:05.0 placed at 0:01.0, volume 50%');
});

test('mark still and mark lines', () => {
  const m = { start: 1, end: 3, box: { x: 0.6, y: 0.1, w: 0.3, h: 0.2 }, note: 'glitch' };
  const a = markStillArgs('v.mp4', m, 'm.jpg');
  assert.equal(a[1], '2.000');
  assert.match(a[a.indexOf('-vf') + 1], /^drawbox=x=iw\*0\.6000:y=ih\*0\.1000:w=iw\*0\.3000:h=ih\*0\.2000:color=red/);
  assert.match(describeMarks([m], (n) => `marks/mark-${n}.jpg`)[0], /0:01\.0 to 0:03\.0.*60% from the left.*glitch.*marks\/mark-1\.jpg/);
});

test('fix one part: slice the marked stretch, then splice the fixed piece back', () => {
  const parts = [{ src: 's1', in: 0, out: 4, zoom: 1.5, x: 0.5, y: 0.5, volume: 1 }, { src: 's2', in: 1, out: 4, zoom: 1, x: 0.5, y: 0.5, volume: 0 }];
  // 3..5 on the output is 3..4 of part 1 and 1..2 of part 2, zoom and volume kept
  assert.deepEqual(partsBetween(parts, 3, 5).map((p) => [p.src, p.in, p.out, p.zoom]), [['s1', 3, 4, 1.5], ['s2', 1, 2, 1]]);
  assert.deepEqual(partsBetween(parts, 3.98, 5).map((p) => p.src), ['s2'], 'a sliver under 0.05 s is dropped');
  const sl = sliceEdit({ ...edit, parts, audio: [{ id: 'a1' }], marks: [{}] }, 3, 5);
  assert.equal(sl.audio.length + sl.marks.length, 0);
  const fixed = { src: 's9', in: 0, out: 2, zoom: 1, x: 0.5, y: 0.5, volume: 1 };
  const out = spliceParts(parts, 3, 5, fixed);
  assert.deepEqual(out.map((p) => [p.src, p.in, p.out]), [['s1', 0, 3], ['s9', 0, 2], ['s2', 2, 4]]);
  assert.equal(out.reduce((s, p) => s + p.out - p.in, 0), 7, 'same length as before');
});
