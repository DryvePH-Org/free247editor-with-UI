#!/usr/bin/env python3
"""Render the clean raw edit: keep-segments joined with hard cuts, voice denoised.

Usage: render_cuts.py <prepped.mp4> <keep.json> <edited.mp4> [--no-denoise]
keep.json: [[start_s, end_s], ...] in source time, in playback order.
Also writes <edited>.cuts.json: cut points on the edited timeline (safe chunk boundaries).
No transitions, graphics, music or effects: only 10 ms audio fades so cuts don't click.
"""
import json, subprocess, sys

FPS = 30
snap = lambda t: round(t * FPS) / FPS  # frame-exact cuts keep audio and video the same length per segment

src, keep_path, out = sys.argv[1:4]
denoise = "--no-denoise" not in sys.argv
segs = [(snap(s), snap(e)) for s, e in json.load(open(keep_path))]
assert segs and all(e - s >= 1 / FPS for s, e in segs), "every segment needs start < end"

parts, labels = [], ""
for i, (s, e) in enumerate(segs):
    d = e - s
    parts.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}]")
    parts.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS,"
                 f"afade=t=in:d=0.01,afade=t=out:st={max(d - 0.01, 0):.4f}:d=0.01[a{i}]")
    labels += f"[v{i}][a{i}]"
parts.append(f"{labels}concat=n={len(segs)}:v=1:a=1[v][acat]")
parts.append("[acat]" + ("highpass=f=80,afftdn=nf=-25" if denoise else "anull") + "[a]")

subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
                "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
                "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out], check=True)

cuts, t = [], 0.0
for s, e in segs[:-1]:
    t += e - s
    cuts.append(round(t, 4))
json.dump({"cuts": cuts, "duration": round(t + segs[-1][1] - segs[-1][0], 4)}, open(out + ".cuts.json", "w"))
print(f"{out}: {len(segs)} segments, {len(cuts)} cuts, {t + segs[-1][1] - segs[-1][0]:.2f}s")
