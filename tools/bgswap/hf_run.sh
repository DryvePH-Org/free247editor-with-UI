#!/bin/bash
# Run every chunk through ONE Higgsfield model, one job at a time (one concurrent job per model).
# Usage: hf_run.sh <model> <chunks_dir> <out_dir> <log.md> -- <higgsfield params, e.g. --prompt "..." --mode video-edit ...>
# One instance per model; different models may run at the same time.
# Never pays twice: a downloaded chunk is skipped, and a submitted job's id is kept in
# <out_dir>/chunk_XX.pending, so after an interruption the run waits on that job instead of submitting again.
# Stops at the first job that does not complete.
set -euo pipefail
model="$1"; chunks="$2"; out="$3"; log="$4"; shift 4; [[ "${1:-}" == "--" ]] && shift
mkdir -p "$out"
for c in "$chunks"/chunk_*.mp4; do
  name=$(basename "$c"); dst="$out/$name"; pending="$out/${name%.mp4}.pending"
  [[ -s "$dst" ]] && { echo "skip $name (already downloaded)"; continue; }
  if [[ -s "$pending" ]]; then
    id=$(cat "$pending"); echo "resuming $name ($id)"
  else
    # Each part's own length, rounded up: Kling otherwise makes (and charges for) its 10 s default.
    dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$c" | python3 -I -c 'import math,sys; print(math.ceil(float(sys.stdin.read())))')
    # The upload id saved by "Check prices" avoids a second upload (the CLI gives up uploads after ~60 s).
    ref="$c"; [[ -s "${c%.mp4}.upload" ]] && ref=$(cat "${c%.mp4}.upload")
    # Own step so a refusal stops here with Higgsfield's own message, not a JSON parse error.
    res=$(higgsfield generate create "$model" "$@" --duration "$dur" --video-references "$ref" --json)
    id=$(python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0])' <<< "$res")
    echo "$id" > "$pending"
    echo "| $(date '+%F %T') | $model | $name | $id | submitted |" >> "$log"
  fi
  # wait exits non-zero on a failed job; read the job itself then, so we still know its status.
  higgsfield generate wait "$id" --timeout 60m --interval 10s --json > "$out/${name%.mp4}.job.json" ||
    higgsfield generate get "$id" --json > "$out/${name%.mp4}.job.json"
  read -r status url < <(python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1])); print(j.get("status"), j.get("result_url") or "-")' "$out/${name%.mp4}.job.json")
  echo "| $(date '+%F %T') | $model | $name | $id | $status |" >> "$log"
  if [[ "$status" != completed || "$url" == - ]]; then
    # Forget the job only when it is really over; a job still running must be waited on, never paid for twice.
    [[ "$status" =~ ^(failed|nsfw|canceled|cancelled|completed)$ ]] && rm -f "$pending"
    echo "Higgsfield's $model job for ${name%.mp4} ended: $status (failed jobs are refunded). Try again or pick the other model." >&2; exit 1
  fi
  curl -sSfL -o "$dst.part" "$url" && mv "$dst.part" "$dst" && rm -f "$pending"
  echo "done $name ($id)"
done
