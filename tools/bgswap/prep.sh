#!/bin/bash
# Usage: prep.sh <input video> <output.mp4>
# Makes an SDR H.264 1080x1920 30fps MP4 with the original audio. Never touches the input.
set -euo pipefail
in="$1"; out="$2"
[[ "$(cd "$(dirname "$in")" && pwd)/$(basename "$in")" != "$(cd "$(dirname "$out")" && pwd)/$(basename "$out")" ]] || { echo "refusing to overwrite the input" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
src="$in"
# default=nw=1:nk=1, not csv: csv adds a trailing comma on iPhone files (side data), so HDR was never detected
trc=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of default=nw=1:nk=1 "$in")
if [[ "$trc" == arib-std-b67 || "$trc" == smpte2084 ]]; then
  # iPhone HDR (HLG/PQ): Apple's converter tone-maps to SDR; brew ffmpeg has no zscale, and a plain convert looks grey.
  echo "HDR ($trc) detected, tone-mapping to SDR with avconvert"
  avconvert -s "$in" -p Preset1920x1080 -o "$tmp/sdr.mov" >/dev/null
  src="$tmp/sdr.mov"
fi
ffmpeg -hide_banner -loglevel error -y -i "$src" -map 0:v:0 -map 0:a:0 \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
  -c:v libx264 -preset medium -crf 16 -profile:v high -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$out"
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact "$out"
