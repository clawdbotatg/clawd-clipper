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
6. **`clips.ts`** — pads, clamps to 10–40 s, de-overlaps (keeps the
   higher-scored clip), then `ffmpeg`-cuts each window (re-encoded for
   frame-accurate boundaries) and writes a clip-relative `.srt`.
7. **`judge.ts`** — an **adversarial re-rank**. One batched second-opinion call
   that sees only each clip's actual words (not the selection model's title /
   reason / score, so it can't be anchored by the pitch), assumes the clip is
   watched *cold while scrolling*, finds the single biggest reason it would
   flop, and re-scores it stingily. The final rank blends the two scores
   (`finalScore = 0.35·pick + 0.65·judge`). One extra model call per episode
   (not one per clip), cached to `judge.json`, skippable with `--no-judge`.
8. **`gallery.ts`** — `index.json` (machine-readable, ranked) and a
   zero-dependency `index.html` that plays every clip inline, best first, with
   the pick/judge scores and the judge's critique on each card.

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

## Usage

```bash
yarn clip <slug>                 # resolve via contract, then clip
yarn clip <slug> --manifest CID  # skip the chain, use a manifest CID directly
yarn clip <slug> --limit 12      # only render the top N clips
yarn clip <slug> --target 25     # target clip length in seconds (10–40)
yarn clip <slug> --no-judge      # skip the adversarial judge re-rank
yarn clip <slug> --force         # ignore caches (re-download, re-transcribe, re-judge)
```

Output lands in `out/<slug>/`:

```
out/binji-x/
  source.mp4          # the downloaded episode (gitignored)
  transcript.json     # word + segment timestamps (cached)
  candidates.json     # raw LLM clip picks (cached)
  judge.json          # adversarial verdicts, keyed by clip content (cached)
  clips/
    01_<title>.mp4    # ranked, highest blended score first
    01_<title>.srt
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
- **Models** are configurable via env (`CLIPPER_ANTHROPIC_MODEL`,
  `CLIPPER_TRANSCRIBE_MODEL`, …); defaults match slop's own stack.

## Roadmap

- **Snap clip ends to natural beats.** The judge keeps flagging clips that "end
  mid-sentence / on a vague word" — snap the end to the end of the whisper
  segment containing the end word so clips land cleanly.
- Burned-in captions and a 9:16 social reframe (v1 ships clean landscape + sidecar `.srt`).
- Fold clips into the slop deploy so they render at the bottom of the slug page.

License: MIT.
