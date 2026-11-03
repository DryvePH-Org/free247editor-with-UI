#!/usr/bin/env node
// Free voiceover on this computer with Kokoro (kokoro-js): no Python, no account, no upload.
// The voice model downloads once (about 90 MB) on the first run; after that it works offline.
//
//   node tools/voiceover.mjs "<line>" <out.wav> [--voice af_heart] [--speed 1]
//   node tools/voiceover.mjs --list
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts, positionals: [text, out] } = parseArgs({
  allowPositionals: true,
  options: { voice: { type: 'string', default: 'af_heart' }, speed: { type: 'string', default: '1' }, list: { type: 'boolean' } },
});
if (!opts.list && (!text?.trim() || !out)) {
  console.error('Usage: node tools/voiceover.mjs "<line>" <out.wav> [--voice af_heart] [--speed 1]   (or --list)');
  process.exit(1);
}

let KokoroTTS, TextSplitterStream, RawAudio;
try {
  ({ KokoroTTS, TextSplitterStream } = await import('kokoro-js'));
  ({ RawAudio } = await import('@huggingface/transformers'));
} catch {
  console.error('The voiceover tool is not installed. Run `npm install` in the free247editor folder, or run `node setup.mjs` again.');
  process.exit(1);
}

// After the model loads, end by falling off the script: process.exit() then crashes onnxruntime ("mutex lock failed").
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
if (opts.list) {
  for (const [id, v] of Object.entries(tts.voices)) console.log(`${id.padEnd(12)} ${v.name.padEnd(9)} ${v.language}  ${v.gender}  grade ${v.overallGrade}`);
} else if (!(opts.voice in tts.voices)) {
  console.error(`No voice "${opts.voice}". Run: node tools/voiceover.mjs --list`);
  process.exitCode = 1;
} else {
  // One sentence at a time: a single generate() call silently cuts text past about 500 sounds.
  // The splitter is closed up front, or kokoro-js 1.2.0 waits forever for more text.
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const parts = [];
  for await (const { audio } of tts.stream(splitter, { voice: opts.voice, speed: Number(opts.speed) || 1 })) parts.push(audio.audio);
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  await new RawAudio(all, 24000).save(resolve(out));
  console.log(`Saved ${out} (${(all.length / 24000).toFixed(1)}s, voice ${opts.voice})`);
}
