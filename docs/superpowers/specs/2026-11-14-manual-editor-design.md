# Manual editor (CapCut-style) — design

Date: 2026-11-14. The user said "go start" (no more questions), so the calls below are Claude's unless marked "user".

## Why
The user wants to fix videos by hand before (or instead of) the AI: reposition/zoom the main video so defects
(mostly at the edges of background-replaced Kling/Seedance videos) are cropped out, cut parts, add clips — like CapCut.
Then press **Auto edit** to have the AI do the full styled edit on what is on screen (user). They also want to **mark**
a defect or any spot on the video (a box drawn on the frame, over a time range, plus a note) for the AI to fix (user).
Users are beginners on a team (keep words plain, no jargon). Mac M1 8 GB is the main machine; Windows teammates exist.

## Non-goals
Keyframed/animated zoom inside one part (one zoom + position per part is enough; split into more parts to change it),
overlay tracks (picture-in-picture), text/stickers/music in the editor (that is the AI's job), undo history beyond the
browser session, multi-user editing.

## Model: an edit list (EDL)
One main track of **parts**, played in order. Saved per project in `kit/video-projects/<slug>/editor/edit.json`:

```json
{
  "from": "outbox file name the editor was opened on, or null for raw inbox clips",
  "sources": [{ "id": "s1", "file": "editor/src/s1.mp4", "label": "IMG_3893.MOV", "duration": 64.2, "width": 1080, "height": 1920 }],
  "parts":   [{ "src": "s1", "in": 0, "out": 12.4, "zoom": 1.0, "x": 0.5, "y": 0.5 }],
  "marks":   [{ "start": 3.2, "end": 5.0, "box": { "x": 0.6, "y": 0.1, "w": 0.3, "h": 0.2 }, "note": "glitch on the wall" }],
  "width": 1080, "height": 1920
}
```
- `in`/`out`: seconds in that source. `zoom`: 0.5–3 (1 = fill the frame). `x`,`y`: the point of the source shown at the
  frame centre, 0–1 (0.5,0.5 = centred). With zoom ≥ 1 the server clamps so no empty edge shows; under 1 the empty edge is black.
- Every source is first made browser-friendly (H.264, SDR, the output size): raw inbox clips via `tools/bgswap/prep.sh`
  when on macOS (it tone-maps iPhone HDR), plain ffmpeg elsewhere; outbox versions are used as they are (no copy).
  Output size = the size of the first source after prep (1080x1920 vertical normally).
- Marks: times are on the **output** timeline (after cuts). Box is 0–1 of the output frame.

## Server API (app/server.mjs; render logic in a new app/editor.mjs with a node:test file)
| Call | Does |
|---|---|
| `POST /api/edit` with `manual: true` (plus all the usual options) | Creates the project **without** queueing the AI. Saves the chosen options on the project as `pendingEdit` (options, not a built prompt). Status `manual`. Starts making the sources (prep) in the background. Returns `{ ok, slug }`. |
| `POST /api/projects/:slug/editor/open` `{ from }` | Starts (or restarts) the edit list from outbox version `from`: one source, one full-length part. |
| `GET /api/projects/:slug/editor` | `{ ready, preparing: "text"|null, error, from, sources:[{id,label,duration,width,height,url,strip}], parts, marks, width, height, canAuto: "pending"|"form" }`. `url` plays the source (Range requests). `strip` is a filmstrip image (one frame per second, 96 px tall, tiled in one row, cached) for the timeline. |
| `PUT /api/projects/:slug/editor` `{ parts, marks }` | Saves the edit list (validated: known sources, 0 ≤ in < out ≤ duration, zoom/x/y in range, ≤ 200 parts, ≤ 50 marks, note ≤ 300 chars). |
| `PUT /api/projects/:slug/editor/source?name=` (body = file) or `POST …/editor/source` `{ inbox: "path" }` | Adds a clip source (uploaded, kept in `assets/added/`, or from the inbox), prepped like the others. Returns the source. |
| `POST /api/projects/:slug/editor/render` | Renders the edit list in one ffmpeg pass to the next `<slug>-vN.mp4` (same naming as quick edits). Writes a still for each mark with its box drawn (`editor/marks/mark-N.jpg`). Records history and a `quickEdits` line, like quickEdit does. Returns `{ ok, file }`. |
| `POST /api/projects/:slug/editor/auto` `{ file, options? }` | Sends version `file` to the AI with the marks. If the project has `pendingEdit`: queue it on **this** project, the source being `outbox/<file>`, saving the draft as the next version number. Otherwise `options` (the same fields as the new-video form) is required and it starts a **new** project whose source is `outbox/<file>`. |

- Encoding: `h264_videotoolbox` (Mac hardware, fast) when ffmpeg has it, else libx264 `-preset veryfast`. Keep `+faststart`.
- The prompt for `/api/edit` is built by one shared function so `manual`, `auto` and the normal path agree; sources can be
  inbox paths or `outbox/<file>`; the first draft name is the next free version number, not always `-v1`.
- Auto edit prompts add: "This video was adjusted by hand in the app's editor (cuts, zoom, position, added clips). Treat it as
  one clip and keep those choices; do not undo the zoom or put cut parts back." and, when there are marks, one line per mark:
  time range, box as % of the frame, the note, and the still's path.
- CLAUDE.md gets a short "Marks and hand-adjusted videos" section saying the same (fix each mark in its box and time:
  crop/zoom, cover, blur or a graphic, whatever the note asks).
- The old "Cut a part out" / "Add a clip here" quick tools are replaced by the editor: remove their UI; keep `/cut` and
  `/insert` only if something else still uses them, else delete them and `quickEdit` (the editor render records `quickEdits` the same way).

## Editor screen (app/public/app.js + app.css) — "like CapCut"
- Route `#/edit/<slug>`. Dark editor layout: player on top (9:16 frame centered), a toolbar, then the timeline.
- Player: plays the parts in order (seek each source to `in`, switch at `out`), with the selected part's zoom/position
  applied live via CSS transform inside an overflow-hidden frame. Drag on the player to move the picture; slider and
  mouse wheel to zoom; "Reset" button. What you see = what Save renders.
- Timeline: playhead, time ruler, parts as blocks showing the filmstrip; click to select, Split at playhead (S key),
  Delete (Del key), drag a part's edges to trim, drag to reorder. Zoom-the-timeline slider. A marks lane above the parts.
- Add clip: from the inbox list or upload; it goes in at the playhead.
- Mark: a "Mark a spot" tool — draw a box on the player; the mark covers the selected time range (default: 2 s from the
  playhead, edges draggable on the marks lane); type a note. Marks show as boxes on the player while inside their time.
- Autosave the edit list (debounced PUT). Buttons: **Save as new version** (render), **Auto edit** (render first if there are
  unsaved changes, then auto; if `canAuto` is "form", open the existing new-video options form for it).
- Entry points: "Open in editor" button under the player on a project page (opens the selected version), and on the new-video
  form a checkbox "Adjust it myself first (zoom, cuts, clips)". Keyboard: Space play/pause, S split, Del delete, ←/→ step.
- Plain words everywhere, as in the rest of the app. Works at laptop width; usable (not perfect) on a phone.

## Round 2 (user notes, 2026-11-14): tool grid + sound
User: the side "Size and position" panel "looks like a modal I cannot close" → make the tools "grid style buttons";
add an audio editor: cut and place audio, extract audio, mute the original audio, volume lower/higher.

Edit list additions (server validates, renders, describes; browser edits):
- `parts[].volume`: 0–2 (1 = as recorded, 0 = muted). Applies to that part's own sound. Default 1.
- `audio: [{ id, src, in, out, at, volume }]` — sound clips on one sound lane, mixed over the parts' sound (never replacing
  it). `src` is any source with sound (a video clip's sound, or a sound file); `in`/`out` seconds in the source; `at` = start
  on the output timeline (≥ 0; the part past the video's end is dropped at render); `volume` 0–2. Max 50. Overlaps are allowed.
- Sound-file sources: `POST …/editor/source { sound: "<path under my-sounds/>" }` and the upload route also accept
  .mp3/.wav/.m4a/.aac. A sound source has `kind: "sound"` (video sources `kind: "video"`), no `strip`, not usable as a part.
- Every source with sound gets `wave`: a waveform image URL (cached, same px-per-second as the filmstrip, 48 px tall,
  transparent background, light colour) for drawing sound clips and the parts' sound.
- `GET …/editor` also returns `sounds`: the my-sounds list (`path`, `name`, `duration`, `kind: "music"|"sfx"`) so the screen can offer them.
- Render: each sound clip is its own input (`-ss in -t len`), `volume`, `adelay` to `at`, then `amix` with the parts' sound
  (`normalize=0`, length = the video's). Part volume = a `volume` filter on that part's sound.
- `describeParts` mentions volume/mute; a new line lists the sound clips (file, times, where placed, volume) for the AI.

Screen:
- "Extract audio" (CapCut's meaning): copies the selected part's sound to a sound clip at the same place and mutes the
  part. Sound clips: select, split at playhead, delete, trim edges, drag to move along the time, volume, mute.
- Tool grid replaces the side panel: square icon+label buttons that change with what is selected (a part, a sound clip, a
  mark, nothing). Zoom and Volume open a compact slider row inside the grid area with a Done button. No card that
  looks like a dialog. "Add sound" lists my-sounds (music and effects) and Upload.

## Speed (separate track)
Measured on this machine before any default changes: HyperFrames render with default (8 GB = low-memory mode: 1 worker,
screenshot capture), `--no-low-memory-mode --workers 2`, `--gpu`, `--quality draft`. The winner goes into CLAUDE.md's
render step for drafts; finals keep quality.
