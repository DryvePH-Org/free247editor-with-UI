#!/usr/bin/env python3
"""Stitch generated chunks into the final video with the user's own (edited) audio, in sync.

Usage: assemble.py <edited.mp4> <chunks.json> <gen_dir> <final.mp4> [--crop x,y,w,h]
gen_dir holds the downloaded generations named like the source chunks (chunk_01.mp4, ...).
Per chunk: measure picture offset vs the source chunk for each part between the edit's cut points
(<edited>.cuts.json), shift each part on its own (models sometimes add or drop time around a cut, and the
cut hides the shift), force 30fps 1080x1920, fit to the source chunk's exact length, drop generated audio. Then concat, lay the edited audio on top, and
save a still from each side of every boundary to <final dir>/boundaries/.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sync import measure, motion, best_lag, RATE  # noqa: E402

edited, chunks_json, gen_dir, final = sys.argv[1:5]
crop = tuple(map(float, sys.argv[sys.argv.index("--crop") + 1].split(","))) if "--crop" in sys.argv else (0.2, 0.15, 0.6, 0.7)
out_dir = os.path.dirname(os.path.abspath(final))
work, bdir = os.path.join(out_dir, "work_assemble"), os.path.join(out_dir, "boundaries")
os.makedirs(work, exist_ok=True); os.makedirs(bdir, exist_ok=True)
cuts_file = edited + ".cuts.json"
cuts = json.load(open(cuts_file))["cuts"] if os.path.exists(cuts_file) else []
ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]

report, norm = [], []
for c in json.load(open(chunks_json)):
    name = os.path.basename(c["file"])
    gen = os.path.join(gen_dir, name)
    dur = c["end"] - c["start"]
    a, b = motion(c["file"], crop), motion(gen, crop)
    lag = best_lag(a, b, 0.1, min(len(a), len(b)) / RATE - 0.1)[0]
    bounds = [0.0] + [x - c["start"] for x in cuts if c["start"] + 0.05 < x < c["end"] - 0.05] + [dur]
    lags = []
    for s0, s1 in zip(bounds, bounds[1:]):
        L, corr = best_lag(a, b, s0 + 0.05, s1 - 0.05, maxlag=1.5, minlen=0.4)
        if corr >= 0.6: lag = L  # weak match -> keep the previous part's shift
        lags.append(round(lag * 30) / 30)  # whole frames, so every part keeps its exact length
    # picture late by L -> take generated [s0+L, s1+L); 2 s of cloned frames on each end cover the edges.
    # Bounds sit half a frame early so each trim falls between frames.
    h = 0.5 / 30
    parts = "".join(f"[s{i}]trim=start={s0 + L + 2 - h:.4f}:end={s1 + L + 2 - h:.4f},setpts=PTS-STARTPTS[p{i}];"
                    for i, (s0, s1, L) in enumerate(zip(bounds, bounds[1:], lags)))
    k = len(lags)
    n = os.path.join(work, name)
    subprocess.run(ff + ["-i", gen, "-an", "-filter_complex",
                   "[0:v]fps=30,scale=1080:1920:flags=lanczos,setsar=1,tpad=start_mode=clone:start_duration=2:"
                   f"stop_mode=clone:stop_duration=2,split={k}" + "".join(f"[s{i}]" for i in range(k)) + ";" + parts
                   + "".join(f"[p{i}]" for i in range(k)) + f"concat=n={k}:v=1:a=0,tpad=stop_mode=clone:stop_duration=1,"
                   f"trim=duration={dur},setpts=PTS-STARTPTS,format=yuv420p[v]", "-map", "[v]",
                   "-c:v", "libx264", "-preset", "medium", "-crf", "16", n], check=True)
    norm.append(n)
    m = measure(c["file"], n, crop)  # what is left after the fix
    flag = []
    if abs(m["drift_ms"]) > 40: flag.append("DRIFTS (lips slide out of sync inside the chunk)")
    if m["match"] < 0.5: flag.append("LOW MATCH (motion differs from source, check face/gestures)")
    report.append({"chunk": name, **m, "shifts_ms": [round(x * 1000) for x in lags], "flags": flag})
    print(f"{name}: offset {m['offset_ms']:+d} ms, drift {m['drift_ms']:+d} ms, match {m['match']}  {' '.join(flag)}")

lst = os.path.join(work, "list.txt")
open(lst, "w").write("".join(f"file '{p}'\n" for p in norm))
subprocess.run(ff + ["-f", "concat", "-safe", "0", "-i", lst, "-i", edited, "-map", "0:v", "-map", "1:a",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final], check=True)

for i in range(len(norm) - 1):
    a, b = norm[i], norm[i + 1]
    pair = os.path.join(bdir, f"boundary_{i + 1:02d}_{i + 2:02d}.jpg")
    subprocess.run(ff + ["-sseof", "-0.1", "-i", a, "-i", b, "-filter_complex",
                         "[0:v]scale=540:960,trim=end_frame=1[x];[1:v]scale=540:960,trim=end_frame=1[y];[x][y]hstack",
                         "-frames:v", "1", pair], check=True)
json.dump(report, open(os.path.join(out_dir, "sync_report.json"), "w"), indent=1)
print("final:", subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
      "format=duration:stream=codec_name,width,height,r_frame_rate", "-of", "compact", final], text=True))
