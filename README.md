# clawd-clipper

Mines impactful, shareable **10–40 second clips** out of finished
[slop.computer](https://slop.computer) episodes, ranked by predicted
shareability.

Point it at an episode slug (e.g. `binji-x`). It resolves the episode on
mainnet, downloads the finished video from IPFS, re-transcribes it with
word-level timestamps, asks Claude to mine the most shareable dialog moments,
cuts each one into a standalone `.mp4`, and writes a ranked gallery.

```
yarn clip binji-x
open out/binji-x/index.html
```

It reads the same public artifacts the slug page reads (the on-chain manifest +
IPFS video/transcript/chat). Run it **standalone** as a dev / back-catalog tool,
or let the **relay drive it**: `slop-computer-live`'s `/admin/generate-clips`
button spawns this CLI with `--vertical --publish --stitch`, which pins the 9:16
clips to IPFS, folds a `clips` field into the manifest, and hands back a new CID
to sign — so clips show up at the bottom of `slop.computer/<slug>` as part of the
normal publish flow (see [`docs/clips-publishing-plan.md`](docs/clips-publishing-plan.md)).

## How it works

```
slug ──contract──▶ manifest ──IPFS──▶ video.mp4 (3 GB)
                       │                    │
                       │ meta (title,       ▼
                       │ desc, chapters)   whisper-1  ──▶ word-timed transcript
                       │       │                                  │
                       └───────┴──────────────┬───────────────────┘
                                              ▼
                                    Claude picks the most
                                   shareable moments, each as
                                   verbatim start/end QUOTES
                                              │
                            quotes anchored to real word timestamps
                                   (no hallucinated cut points)
                                              ▼
                            ffmpeg cuts 10–40s clips + .srt
                                              ▼
                          out/<slug>/index.{json,html} (ranked)
```

The pipeline, stage by stage (`src/`):

1. **`resolve.ts`** — `slug → SlopComputer.getEpisodeBySlug` (mainnet, via
   Alchemy) → manifest `ipfs://…` → manifest JSON. Gives the video CID, the
   transcript CID, and the AI-generated `meta` (title / one-liner /
   description / topics / chapters). `--manifest <cid>` skips the chain.
2. **`download.ts`** — streams the (multi-GB) `.mp4` from the IPFS gateway to
   `out/<slug>/source.mp4`. Cached.
3. **`transcribe.ts`** — extracts mono 16 kHz audio, splits it into ≤10-min
   chunks (OpenAI's 25 MB limit), and runs **`whisper-1`** with
   `verbose_json` + word/segment timestamps. whisper-1 is used because it's
   the OpenAI model that returns word-level timing; `gpt-4o-transcribe` does
   not. Chunk offsets are added back so all times are full-episode-relative.
   Cached to `transcript.json`.
4. **`candidates.ts`** — feeds the word-timed transcript (and the episode's
   existing AI meta as a hint) to Claude and asks for 12–20 candidate clips.
   Crucially, the model returns **verbatim start/end quotes**, never
   timestamps.
5. **`anchor.ts`** — locates each quote in the word-timed transcript and reads
   off the real start/end times. This is the same hallucination-proof trick
   slop's `meta-ai.ts` uses for chapters: a quote that can't be found is
   dropped, never faked, so a clip's boundaries are always real spoken words.
6. **`clips.ts`** — snaps each edge to a natural beat (the enclosing sentence
   boundary via whisper's punctuation, walking across continuation segments,
   with a silence-gap fallback) so clips don't begin/end mid-phrase; pads,
   clamps to 10–40 s (a length-cap trim also lands on a boundary), de-overlaps
   (keeps the higher-scored clip), then `ffmpeg`-cuts each window (re-encoded
   for frame-accurate boundaries), **burns in the karaoke captions** (8), and
   writes a clip-relative `.srt`.
7. **`judge.ts`** — an **adversarial re-rank**. One batched second-opinion call
   that sees only each clip's actual words (not the selection model's title /
   reason / score, so it can't be anchored by the pitch), assumes the clip is
   watched *cold while scrolling*, finds the single biggest reason it would
   flop, and re-scores it stingily. The final rank blends the two scores
   (`finalScore = 0.35·pick + 0.65·judge`). One extra model call per episode
   (not one per clip), cached to `judge.json`, skippable with `--no-judge`.
8. **`refine.ts` + `ass.ts`** — captions, **better than raw STT**. whisper hears
   a crypto/AI show through a generic ear (`GPT 4 0`, `Clawd` vs `Claude Code`
   vs the model `Claude`, mangled proper nouns). One batched Claude call — fed
   the episode's own AI meta plus a domain glossary (`refine.ts`) — returns only
   the **edits** it wants to make, as spans of source-word indices to replace.
   Everything it doesn't touch passes through unchanged, and an out-of-range or
   overlapping edit is dropped individually, so word-level **timing is never
   faked** (the same anchor-to-real-words discipline as 5) and the worst case is
   plain raw STT. Cached to `captions.json`. `ass.ts` then renders a karaoke
   `.ass` in the slop theme — purple/pink words, the one being spoken popping
   white — which libass burns into the clip in 6. Skip with `--no-refine`
   (raw STT) or `--no-burn` (sidecar `.srt` only, clean video). The glossary at
   the top of `refine.ts` is where you teach the system new vocabulary.
9. **`tweets.ts`** — suggested **post copy** for each clip: a short scroll-stopper
   and a longer version, ready to ship with the video. One batched call that sees
   the corrected words, the speaker, and the judge's critique — so the copy
   deliberately supplies the hook the critique says the clip lacks cold. Cached to
   `tweets.json`, skip with `--no-tweets`.
10. **`gallery.ts`** — `index.json` (machine-readable, ranked) and a
   zero-dependency `index.html` that plays every clip inline, best first, with
   the pick/judge scores, the judge's critique, the corrected caption text, and
   the short/long post copy (each with a one-click copy button) on each card.

## Beyond the core: speakers, 9:16, stitch, publish

The captioned landscape clip above is the spine. Four layers build on it:

- **Speaker + chat signal** (`speakers.ts`, `chat.ts`). whisper drops who's
  talking; the episode's **live transcript** carries a handle per line on a wall
  clock. `alignToVideo` recovers the constant offset between that wall clock and
  the whisper (video) clock, which lets us (a) feed "who said what" + the windows
  where the **live chat spiked** to the candidate selector — the two biggest
  signals it was otherwise blind to — and (b) attribute each finished clip to its
  speaker(s) for the 9:16 nameplate. Best-effort: no alignment just leaves
  speakers unset.
- **9:16 mobile reframe** (`--vertical` → `vertical.ts`, `pixels.ts`,
  `director.ts`, `desktop-bg.ts`). The "hard mode" take: instead of letterboxing
  the wide call, **isolate the on-screen windows and stack them**. The recording
  is a 1920×1080 *desktop* where every webcam / screen share / app is a draggable
  window with a purple title bar ("CAMERA — name", "SCREEN — name", …) — a vision
  pass reads each window's kind/owner/box straight off that chrome (cached in
  `windows.json`; detection is the expensive part, composition is a pure function
  re-derived free on every run). A `director` pass (one batched LLM call) ranks
  which window each clip is *about* so the composer shows the screen the
  conversation references, not an incidental share. A second, deliberately
  different **ALT layout** is composed too. Tiles stack over a pre-rendered
  slop-desktop background, captions burned on the seam. *(A geometry-log fast path
  exists but is off by default — see Notes.)*
- **Stitched clips** (`--stitch`). Lets the selector return a clip as **multiple
  spans** so a dead interjection / cross-talk in the middle can be spliced out;
  the kept duration and the cut dead-air are logged and persisted to
  `stitches.json`. Each span is independently anchored to real words, so a stitch
  that can't be cleanly resolved is dropped, never faked.
- **Publish** (`--publish` → `publish.ts`, implies `--vertical`). Pins the 9:16
  clips (+ first-frame posters) to IPFS via bgipfs, builds a `clips.json` bundle,
  folds a `clips` field into the episode manifest, and writes `publish.json` with
  the new clips + manifest CIDs. The operator (or the relay's admin UI) then signs
  one `setManifest` with that CID — no server key, no contract change.

## Setup

```bash
yarn install          # or: npm install
cp .env.example .env  # then fill in the keys
```

Keys (see `.env.example`):

| Key                 | Used for                                         | Required |
| ------------------- | ------------------------------------------------ | -------- |
| `ALCHEMY_API_KEY`   | mainnet read of the SlopComputer contract        | yes (unless `--manifest`) |
| `OPENAI_API_KEY`    | `whisper-1` transcription                        | yes |
| `ANTHROPIC_API_KEY` | clip selection + shareability scoring (Claude)   | yes\* |
| `BANKR_API_KEY`     | fallback for clip selection (OpenClaw gateway)   | \*either Anthropic or Bankr |

> Per the repo's RPC rules, **never** use a public RPC — Alchemy only.

You also need **ffmpeg** (cutting / probing / audio extraction) and, for the
burned-in captions, an ffmpeg with **libass**. Homebrew's slim `ffmpeg` formula
ships *without* libass, so the burn pass uses the keg-only `ffmpeg-full`:

```bash
brew install ffmpeg-full   # libass-enabled; keg-only, so it won't shadow your system ffmpeg
```

The clipper auto-detects it at `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`
(override with `CLIPPER_FFMPEG_FULL_BIN`). If no libass build is found it warns
and falls back to clean clips + sidecar `.srt` — captions just won't be burned.

## Usage

```bash
yarn clip <slug>                 # resolve via contract, then clip
yarn clip <slug> --manifest CID  # skip the chain, use a manifest CID directly
yarn clip <slug> --limit 12      # only render the top N clips
yarn clip <slug> --target 25     # target clip length in seconds (10–40)
yarn clip <slug> --no-judge      # skip the adversarial judge re-rank
yarn clip <slug> --no-refine     # skip context-aware caption correction (raw STT)
yarn clip <slug> --no-burn       # don't burn captions in (clean video + sidecar .srt)
yarn clip <slug> --no-tweets     # skip generating per-clip post copy
yarn clip <slug> --vertical      # also render 9:16 mobile clips (stacked speaker tiles)
yarn clip <slug> --stitch        # allow stitched (multi-span) clips — splice out dead air
yarn clip <slug> --publish       # pin 9:16 clips to IPFS + emit updated manifest CID (implies --vertical)
yarn clip <slug> --force         # ignore caches (re-download, re-transcribe, re-judge)

# Custom clip — when the auto-picker missed a moment you want:
yarn clip <slug> --clip-at 7:18-8:05                       # render ONE clip from an explicit window
yarn clip <slug> --clip-at 7:18-8:05 --clip-title "Hermès" # name the output file
yarn clip <slug> --clip-at 438-485 --clip-exact            # seconds; honour times to the frame (no snap)
```

**`--clip-at START-END`** renders a single operator-chosen clip instead of
mining the episode. You watched the show and have a timestamp — give it the
window (`M:SS-M:SS`, `H:MM:SS-…`, or bare `seconds-seconds`) and it skips the
LLM picker, the judge, and the tweet copy, but runs the **same** speaker
attribution, caption correction, and 9:16 stacked-tile reframe the auto clips
get. It writes nothing to the manifest and pins nothing — just the `.mp4`s in
`out/<slug>/clips/`. It implies `--vertical` (the geometry + speaker tile is the
point). By default both edges snap to the nearest sentence beat for a clean cut;
`--clip-exact` honours your exact times. The 10–40s product bounds don't apply —
your window is your call. Re-uses the cached `source.mp4` + `transcript.json`, so
a custom clip on an already-processed episode is fast and cheap.

Output lands in `out/<slug>/`:

```
out/binji-x/
  source.mp4          # the downloaded episode (gitignored)
  transcript.json     # word + segment timestamps (cached)
  candidates.json     # raw LLM clip picks (cached)
  judge.json          # adversarial verdicts, keyed by clip content (cached)
  captions.json       # context-corrected caption tokens, keyed by clip content (cached)
  tweets.json         # per-clip short/long post copy, keyed by clip content (cached)
  windows.json        # detected desktop window boxes per clip (--vertical; cached)
  director.json       # per-clip "what is this about" window ranking (--vertical; cached)
  stitches.json       # stitch attempts: what spliced, what dropped, why (--stitch)
  publish.json        # clips + updated manifest CIDs (--publish)
  clips/
    01_<title>.mp4        # ranked, highest blended score first — captions burned in
    01_<title>.srt        # corrected, clip-relative
    01_<title>.ass        # the karaoke style burned into the mp4 (re-burn / re-style here)
    01_<title>.mobile.mp4 # 9:16 stacked-tile cut (--vertical)
    01_<title>.alt.mobile.mp4 # the ALT 9:16 take — deliberately different (--vertical)
    02_<title>.mp4
    …
  index.json          # ranked clip metadata (pick + judge scores, critiques)
  index.html          # inline gallery, sorted by final score
```

## Notes & knobs

- **Cost / time.** Dominated by the 3 GB download and whisper-1 (~$0.006/min of
  audio). Both are cached, so re-running selection/cutting is cheap — only
  `--force` re-does them.
- **Clip bounds** live at the top of `src/clips.ts` (`MIN`/`MAX`/`LEAD`/`TAIL`,
  overlap threshold).
- **Caption look** (font, size via `CLIPPER_CAPTION_SCALE`, the purple / white /
  pink colours, and the translucent background band that lifts captions off busy
  footage) is configurable via env (`CLIPPER_CAPTION_*`, see `src/config.ts`);
  ASS line-grouping knobs live at the top of `src/ass.ts`.
- **Caption vocabulary.** The glossary at the top of `src/refine.ts` is the place
  to teach the corrector new proper nouns / jargon (it already knows `Clawd` vs
  `Claude Code` vs `Claude`). Correction never invents timing — it only remaps
  spelling onto the real spoken words — so adding terms is safe.
- **9:16 window detection** is by **pixel CV** (a vision call per clip, cached in
  `windows.json`). A **geometry-log** fast path — replaying the rects the relay
  logged instead of re-detecting — exists behind `CLIPPER_USE_GEOMETRY=1` but is
  **off by default**: the relay logs the interactive *slot* coordinates, while OBS
  records a *different* broadcast composition, so replayed rects don't line up
  with the recorded pixels (a single affine can't reconcile two cameras). It'll
  default on once the relay logs the broadcast composition's coords — see
  `src/index.ts` (the note around the `useGeometry` gate) and
  `docs/window-geometry-log.md`.
- **Models** are configurable via env (`CLIPPER_ANTHROPIC_MODEL`,
  `CLIPPER_JUDGE_MODEL`, `CLIPPER_REFINE_MODEL`, `CLIPPER_TWEETS_MODEL`,
  `CLIPPER_DIRECTOR_MODEL`, `CLIPPER_TRANSCRIBE_MODEL`); the Claude passes default
  to the current Opus (`claude-opus-4-8`).

## Roadmap

- **Geometry-log fast path on by default** — once the relay logs the broadcast
  composition's window coords (not the interactive slot coords), the per-clip
  vision pass can be skipped (see the geometry note above).

License: MIT.
