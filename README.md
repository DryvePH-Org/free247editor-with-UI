# free247editor

A free, open-source personal video editor that runs inside Claude.

Drop in a raw video and say **"edit this"**. You get back a cut, captioned edit with motion
graphics, zoom-ins, and sound. Then give notes in plain words (English, Tagalog, Taglish),
the way you would to a human editor. Lasting notes become rules it follows on every
future edit, so it learns your style.

## Setup (once)

### One prompt

Open Claude Code in any folder (terminal: `claude`, or the Code tab in the Claude desktop app)
and paste:

```text
Set up free247editor for me. Clone https://github.com/riecodes/free247editor.git into my
Documents folder (install Git first if it is missing, after asking me). Then follow the
"start" steps in its CLAUDE.md: run node setup.mjs from that folder, install anything it
reports missing after asking me, help me choose free transcription (a Groq key I paste into
.env myself, or local faster-whisper), open the test video, and walk me through style setup.
When you finish, tell me the full path of the inbox folder and remind me to open Claude in
the free247editor folder from now on.
```

From then on, open Claude in the `free247editor` folder so it reads its `CLAUDE.md`.

### Step by step

1. **Get it.** `git clone https://github.com/riecodes/free247editor.git`, or use
   *Code > Download ZIP* on GitHub and unzip it.
2. **Open the folder in Claude Code.** In a terminal: `cd free247editor` then `claude`.
   Or, in the Claude desktop app, open the Code tab and choose the folder.
3. **Type `start`.** Claude checks your computer, installs what is missing (with your OK),
   renders a test video, and asks a few questions about your style.

## The app (easiest)

After setup, double-click **Open Editor** in the `free247editor` folder (`Open Editor.command` on Mac,
`Open Editor.bat` on Windows), or run `node app/server.mjs`. A page opens in your browser where you:

- drop in all the clips for one video (retakes too); the editor puts them in story order
- keep each video's clips in a folder, and move clips between folders
- delete any clip, folder, brand file, sound or video, one by one or all at once (they go to the Trash)
- say who each video is for: all sales (ends with the brand contact) or one sales person
- watch the progress step by step, and line up more videos while it works
- play each version (v1, v2, ...) and type notes, with the time where you paused
- see what the editor could not do yet (for example "no B-roll"), and add it
- click **Approve and make final**, or make a YouTube (horizontal) version
- add your logo, brand contact, sales people, social page screenshot, B-roll library, and music in **My brand**
- share your brand with teammates as one `.brandpack` file, so their videos match yours
- pick or change your style, and see or edit your rules
- check setup, let the editor fix what is missing, and save your free Groq key

The app runs only on your computer (it is not reachable from other devices) and uses your Claude plan,
just like the chat. Keep its window open while you edit. On Mac, if double-clicking is blocked the
first time, right-click **Open Editor.command** and choose *Open*.

## Editing in the Claude chat

1. Put a raw video in the `inbox` folder, or drag it into the Claude chat.
2. Say **"edit this"**.
3. Watch the draft from `outbox`, tell Claude what to change, and repeat until you say "final".

Vertical 9:16 for Reels, TikTok, and Shorts by default. Ask for a horizontal version for
YouTube and it gets its own framing and text placement.

## What it does

| | |
| --- | --- |
| Cuts | Removes dead air, breaths, false starts, and retakes |
| Captions | Word by word, bold key words, key-word pills, or subtitles, in your position and colors |
| Hook | Big text in the first 3 seconds, if you want it |
| Motion graphics | Animated cards, pop-up clips, and overlays (HyperFrames + GSAP) |
| Camera | Zoom-ins and reframing that keep your face clear |
| Color | Natural, warm, cool, black and white, or orange and teal |
| Sound | Sound effects and a music bed from files you put in `my-sounds` |
| Learning | Your notes are saved as rules in `my-rules.md` and applied every time |

## What you need

- **Claude Code** with a paid Claude plan. Editing uses a lot of usage; Pro works, Max is
  better if you edit often.
- **Node.js 22+, Git, FFmpeg, and Chrome.** Setup tells you what is missing and Claude can
  install it for you.
- **Transcription, free either way:** a free [Groq](https://console.groq.com/keys) key
  (fast, best for Taglish), or [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  on your own computer (`pip install faster-whisper`, needs Python).
- About 1 GB of disk space.

Tested on Windows 11 (setup, test render, transcription, and the cutting tools). The editing
engine is cross-platform, so macOS and Linux should work, but they are not tested yet.

## Costs

The software is free. You pay only for your Claude plan. Groq's free tier covers normal
use. Claude will never call a paid service (ElevenLabs, Kie.ai, or others) without asking.

## Not included

- An exported CapCut project. You get the MP4 plus the editable HyperFrames project in
  `kit/video-projects/<name>`; open it in HyperFrames Studio with `npx hyperframes preview`.
- Stock music or footage. Bring your own into `my-sounds` and `inbox`.
- Posting. It never uploads your videos anywhere.

## Folders

```
free247editor/
  CLAUDE.md          how Claude runs your editor
  Open Editor.*      double-click to open the app
  app/               the app (a local web page)
  setup.mjs          one-time setup (safe to re-run)
  tools/             free transcription
  inbox/             your raw videos
  outbox/            drafts and finals
  my-style.md        your style (created at setup, stays private)
  my-rules.md        rules learned from your notes (stays private)
  my-sounds/         your music and sound effects
  my-brand/          logo, social screenshot, B-roll library, brand rules
  my-people.json     sales people a video can be for (stays private)
  kit/               the editing engine (installed by setup)
```

Your footage, renders, style, rules, and key are in `.gitignore` and never leave your computer.

## Updating the engine

Setup installs a pinned version of the engine. To move to a newer one, change `KIT_COMMIT` in
`setup.mjs`, move any projects you want to keep out of `kit/video-projects`, delete `kit/`, and
type `start` again. Your style, rules, inbox, and outbox are untouched.

## Credits

The editing engine is [Herk Edit Kit](https://github.com/nateherkai/herk-edit-kit) by
Nate Herk (MIT), built on [HyperFrames](https://github.com/heygen-com/hyperframes) and
[GSAP](https://gsap.com/). Setup downloads it from its own repository; it is not copied
here. The AI Automation Society brand assets inside that kit belong to their owner and are
not licensed for reuse.

The app uses [Phosphor Icons](https://phosphoricons.com) (MIT) and the fonts Bricolage Grotesque and
Permanent Marker (SIL Open Font License), stored in `app/public` so it works offline.

free247editor is not affiliated with Anthropic, Nate Herk, or HeyGen.

## License

MIT. See [LICENSE](LICENSE).
