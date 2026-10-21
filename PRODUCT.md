# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who film themselves: presenters and sales agents who record short talking-head videos on their phone and want a finished, post-ready video with as little effort as possible. They are not editors and not technical; they should never need to open a terminal, read code, or learn editing terms.

Each person works for one brand and always films for that brand. The team as a whole makes videos for several brands or clients.

The repo owner sets up and maintains the tool and rolls it out to the team.

## Product Purpose

free247editor is a personal AI video editor. A presenter drops in a raw video and gets back a cut, captioned, branded edit (silences and mistakes removed, captions, motion graphics, zoom-ins, sound). They give notes in plain words, in English, Tagalog, or Taglish, the way they would to a human editor, and get the next version. Lasting notes become rules the editor follows on every future video.

Success means both, equally:
- **Fewest steps to post:** drop a video, get something post-ready, make almost no decisions.
- **Brand consistency:** every video for a brand looks the same, whoever filmed it.

## Positioning

Claude Code does the editing on the presenter's own computer, driven by the project's CLAUDE.md and the Herk Edit Kit engine (HyperFrames + GSAP), so the edit follows a written style and a growing set of learned rules rather than a fixed template. The web app is a friendly front end to that same pipeline: it runs `claude -p` in the repo, so the terminal and the app produce identical edits. Software is free; the only cost is each person's own Claude plan.

## Operating Context

- Each teammate installs free247editor on their own laptop (Mac or Windows) and uses their own Claude plan.
- The app runs locally (`node app/server.mjs`, or double-click `Open Editor.command` / `Open Editor.bat`) at `http://localhost:4747` and is not reachable from other devices.
- Workflow: drop a phone video (MOV/MP4) in the app or `inbox/`, start the edit (10 to 30 minutes), watch the draft, send notes, repeat, then approve to render the final. Optional horizontal 16:9 version for YouTube.
- Folders: `inbox/` raw footage and extras (logos, CTA text), `outbox/` drafts and finals (`<slug>-v1.mp4`, `-final.mp4`), `my-sounds/` music and effects the user owns, `my-style.md` the style, `my-rules.md` learned rules.
- Transcription is free: a Groq key (recommended for Taglish) or local faster-whisper.

## Capabilities and Constraints

- One style (`my-style.md`) and one rule set (`my-rules.md`) per install. This fits the team because each person films for one brand. Keeping a brand consistent across several teammates' laptops currently means copying the same style file to each; there is no shared brand-style mechanism yet (open decision).
- Never posts, uploads, or sends a video anywhere. Never calls paid services (ElevenLabs, Kie.ai, others) without asking. Never downloads music or footage it has no rights to.
- The Groq key lives only in `.env` on the user's computer and is never shown or logged.
- Footage, renders, style, rules, sounds, keys, and app state (`.webapp/`) stay local and are never committed.
- `kit/` is installed by setup and must not be edited.
- Interface language is English; notes may be written in English, Tagalog, or Taglish.
- One edit runs at a time per computer.

## Brand Commitments

- Name: free247editor (lowercase).
- Voice: plain words, no editing or coding jargon, friendly and direct, as a human editor would talk.
- The editing engine is Herk Edit Kit by Nate Herk (MIT). Its AI Automation Society brand assets are not licensed for reuse.
- Not affiliated with Anthropic, Nate Herk, or HeyGen.

## Evidence on Hand

- Real raw footage, a logo, and CTA text in `inbox/`, and one finished promo with two drafts in `outbox/` (private, gitignored; not for public use).
- A detailed, real style spec in `my-style.md` (private, gitignored).
- `outbox/setup-test.mp4`, the setup test render.
- No testimonials, user counts, case studies, or benchmarks exist. Do not invent them.

## Product Principles

1. **The presenter only films.** Every decision the tool can make from the style and rules, it makes; ask the person only what truly needs them.
2. **The brand outranks the individual.** A brand's videos should be interchangeable in look, regardless of who recorded them.
3. **Talk like an editor, not a tool.** Notes in, versions out, in the person's own words and language.
4. **Everything stays on the person's computer.** Nothing is posted, uploaded, or paid for without explicit permission.
5. **Learn once, apply always.** A preference given twice becomes a rule, so no one repeats themselves.

## Accessibility & Inclusion

Users are non-technical and may be on Mac or Windows laptops, sometimes with weak internet; the app must work offline once installed. Copy stays in plain English, and notes are accepted in Taglish.
