#!/usr/bin/env python3
"""Measure how far a generated clip's picture is shifted from the source clip (lip-sync check).

Usage: sync.py <source_chunk.mp4> <generated.mp4> [--crop x,y,w,h]   (crop as fractions of the frame)
Compares frame-to-frame motion of the person. A static replaced background adds ~no motion, so the
two signals line up even though the rooms differ.
Prints offset in ms: positive = generated picture is LATE (trim that much off its start).
"""
import re, subprocess, sys

RATE = 100  # samples per second for the comparison


def motion(path, crop):
    x, y, w, h = crop
    vf = (f"crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},scale=64:64,format=gray,tblend=all_mode=difference,"
          "signalstats,metadata=print:key=lavfi.signalstats.YAVG")
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-vf", vf, "-an", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    t = [float(v) for v in re.findall(r"pts_time:([\d.]+)", err)]
    v = [float(v) for v in re.findall(r"YAVG=([\d.]+)", err)]
    pts = list(zip(t, v))
    # resample to a fixed RATE grid (step-hold), so 24fps and 30fps clips compare directly
    out, j = [], 0
    for k in range(int(pts[-1][0] * RATE)):
        while j + 1 < len(pts) and pts[j + 1][0] <= k / RATE:
            j += 1
        out.append(pts[j][1])
    return out


def best_lag(a, b, lo, hi, maxlag=0.6, minlen=1.0):
    """Lag (s) of b vs a over a[lo:hi] seconds that maximizes correlation; returns (lag, corr)."""
    best = (0.0, -2.0)
    for L in range(-int(maxlag * RATE), int(maxlag * RATE) + 1):
        i0, i1 = max(int(lo * RATE), -L), min(int(hi * RATE), len(b) - L, len(a))
        if i1 - i0 < minlen * RATE:
            continue
        xs, ys = a[i0:i1], b[i0 + L:i1 + L]
        n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
        cov = sum((p - mx) * (q - my) for p, q in zip(xs, ys))
        vx = sum((p - mx) ** 2 for p in xs); vy = sum((q - my) ** 2 for q in ys)
        c = cov / ((vx * vy) ** 0.5 or 1)
        if c > best[1]:
            best = (L / RATE, c)
    return best


def measure(src, gen, crop=(0.2, 0.15, 0.6, 0.7)):
    a, b = motion(src, crop), motion(gen, crop)
    d = min(len(a), len(b)) / RATE
    whole = best_lag(a, b, 0.1, d - 0.1)
    first = best_lag(a, b, 0.1, d / 2)
    second = best_lag(a, b, d / 2, d - 0.1)
    return {"offset_ms": round(whole[0] * 1000), "match": round(whole[1], 2),
            "drift_ms": round((second[0] - first[0]) * 1000)}


if __name__ == "__main__":
    if sys.argv[1] == "--selftest":
        import random
        random.seed(1); a = [random.random() for _ in range(800)]
        assert best_lag(a, [0.0] * 5 + a, 0.5, 7)[0] == 0.05  # b late by 5 samples = +50 ms
        print("selftest ok"); sys.exit()
    crop = tuple(map(float, sys.argv[sys.argv.index("--crop") + 1].split(","))) if "--crop" in sys.argv else (0.2, 0.15, 0.6, 0.7)
    print(measure(sys.argv[1], sys.argv[2], crop))
