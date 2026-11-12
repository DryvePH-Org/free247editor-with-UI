#!/usr/bin/env python3
"""Split the edited video into generation chunks at edit cuts or natural pauses, never mid-word.

Usage: chunks.py <edited.mp4> <out_dir> [--max 30] [--min 4]
Each chunk ends at the latest edit cut (from <edited>.cuts.json) that fits; if none fits, at the
quietest 150 ms of speech in the back half of the allowed window (a breath between words).
Loudness-relative, so it works for quiet or noisy recordings alike.
Writes out_dir/chunk_01.mp4 ... and out_dir/chunks.json ([{file, start, end}]).
"""
import json, os, re, subprocess, sys

FPS = 30
snap = lambda t: round(t * FPS) / FPS


def arg(name, default):
    return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def plan(cuts, env, total, mx, mn):
    """cuts: edit cut times; env: [(t, dB)] loudness every 50 ms (already smoothed)."""
    ends, start = [], 0.0
    while total - start > mx:
        lo, hi = start + mn, min(start + mx, total - mn)  # leftover must stay >= mn
        ok = [c for c in cuts if lo <= c <= hi]
        if ok:
            start = max(ok)
        else:
            window = [(db, t) for t, db in env if (lo + hi) / 2 <= t <= hi] or [(db, t) for t, db in env if lo <= t <= hi]
            if not window:
                raise SystemExit(f"cannot split between {lo:.1f}s and {hi:.1f}s")
            start = min(window)[1]
        ends.append(snap(start))
    return list(zip([0.0] + ends, ends + [total]))


def loudness(src):
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", src, "-vn", "-af",
                          "aresample=16000,asetnsamples=800,astats=metadata=1:reset=1,"
                          "ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    t = [float(x) for x in re.findall(r"pts_time:([\d.]+)", err)]
    db = [-120.0 if v == "-inf" else float(v) for v in re.findall(r"RMS_level=(-?[\d.]+|-inf)", err)]
    # 150 ms rolling max: a point only counts as quiet if its neighbours are quiet too (a real breath, not a consonant gap)
    return [(t[i], max(db[max(i - 1, 0):i + 2])) for i in range(len(db))]


if __name__ == "__main__" and sys.argv[1] == "--selftest":
    env = [(k / 20, -60.0 if k in (500, 1000) else -20.0) for k in range(1300)]  # quiet at 25 s and 50 s, total 65 s
    assert plan([28, 50], env, 65, 30, 4) == [(0, 28), (28, 50), (50, 65)]        # prefers edit cuts
    assert plan([], env, 65, 30, 4) == [(0, 25), (25, 50), (50, 65)]             # else the quiet moments
    assert plan([], env, 20, 30, 4) == [(0, 20)]
    assert all(e - s >= 4 for s, e in plan([29], env, 33, 30, 4))               # never leaves a < 4 s tail
    print("selftest ok"); sys.exit()

src, out_dir = sys.argv[1:3]
mx, mn = arg("--max", 30), arg("--min", 4)
os.makedirs(out_dir, exist_ok=True)
trc = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer",
                               "-of", "default=nw=1:nk=1", src], text=True).strip()
if trc in ("arib-std-b67", "smpte2084"):  # Kling refuses HDR ("HDR video is not supported") and refunds
    raise SystemExit("This video is still in iPhone HDR colors, which Higgsfield refuses. Make the clean video again so it is converted to normal colors.")
total = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]))
cuts = json.load(open(src + ".cuts.json"))["cuts"] if os.path.exists(src + ".cuts.json") else []

chunks = []
for i, (s, e) in enumerate(plan(cuts, loudness(src), total, mx, mn), 1):
    f = os.path.join(out_dir, f"chunk_{i:02d}.mp4")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{s}", "-i", src, "-t", f"{e - s}",
                    # bitrate cap keeps a 30 s chunk near 16 MB: the Higgsfield CLI gives up an upload after ~60 s,
                    # so 35 MB chunks failed on a ~4 Mbps home upload ("Failed to upload media bytes")
                    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-maxrate", "4M", "-bufsize", "8M",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", f], check=True)
    chunks.append({"file": f, "start": round(s, 4), "end": round(e, 4)})
    print(f"chunk_{i:02d}: {s:7.2f} -> {e:7.2f}  ({e - s:.2f}s)")
json.dump(chunks, open(os.path.join(out_dir, "chunks.json"), "w"), indent=1)
