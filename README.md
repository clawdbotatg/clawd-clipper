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

This is a **standalone** tool for now — it reads the same public artifacts the
slug page reads (the on-chain manifest + IPFS video/transcript). A later
version could fold the output back into the deploy so clips show up at the
bottom of a slug page like `slop.computer/binji-x`.

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
9. **`gallery.ts`** — `index.json` (machine-readable, ranked) and a
   zero-dependency `index.html` that plays every clip inline, best first, with
   the pick/judge scores, the judge's critique, and the corrected caption text
   on each card.

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
yarn clip <slug> --force         # ignore caches (re-download, re-transcribe, re-judge)
```

Output lands in `out/<slug>/`:

```
out/binji-x/
  source.mp4          # the downloaded episode (gitignored)
  transcript.json     # word + segment timestamps (cached)
  candidates.json     # raw LLM clip picks (cached)
  judge.json          # adversarial verdicts, keyed by clip content (cached)
  captions.json       # context-corrected caption tokens, keyed by clip content (cached)
  clips/
    01_<title>.mp4    # ranked, highest blended score first — captions burned in
    01_<title>.srt    # corrected, clip-relative
    01_<title>.ass    # the karaoke style burned into the mp4 (re-burn / re-style here)
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
- **Models** are configurable via env (`CLIPPER_ANTHROPIC_MODEL`,
  `CLIPPER_REFINE_MODEL`, `CLIPPER_TRANSCRIBE_MODEL`, …); defaults match slop's
  own stack.

## Roadmap

- A 9:16 social reframe (v1 burns captions onto the clean landscape cut).
- Fold clips into the slop deploy so they render at the bottom of the slug page.

License: MIT.
