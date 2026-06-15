# Window Geometry Log — cross-repo spec

> **Status (2026-06):** fully built across both repos. The original **slot-coord**
> basis shipped but couldn't be reconciled to the recorded frame (different
> composition) — it's now the legacy fallback behind `CLIPPER_USE_GEOMETRY`. The
> **god-frame** basis (the OBS browser logs each window's actual rendered rect +
> its viewport via a `god_geometry` message) is the real fix and is used
> automatically. See "Coordinate space" and "Status & what's left" below. Only
> empirical end-to-end verification on a fresh recording remains.


**Goal:** publish the exact on-screen geometry of every desktop window over the
course of an episode, so downstream tools (the clipper's 9:16 mobile crop) can
read window rects **deterministically** instead of recovering them with computer
vision from the flat recording.

**Why:** slop-computer-live already *knows* every window's `{x, y, width, height,
z}` exactly (it renders them). The recording is a flat OBS-captured MP4, so that
truth never reaches the artifact. We fix that by logging the geometry during the
session and pinning it alongside the video, referenced from the manifest — the
same pattern as `transcript` / `chat` / `card`.

**Fallback:** the clipper keeps its deterministic pixel pipeline
(`src/pixels.ts`: dots → menu bar → side traces → bottom). When
`manifest.geometry` is absent or empty (older episodes, a dropped log), it falls
back to that. We ship **both**; the log is preferred when present.

> Scope note: only helps **future** episodes — already-recorded ones rely on the
> CV fallback. Touch **no existing log**: this is a brand-new file + a new
> additive manifest field.

---

## Data format — `geometry.jsonl` (as built)

Append-only, newline-delimited JSON, time-ordered. During the session the relay
appends only **event** lines; a **header** line is prepended at finalize (it
carries `videoStartMs`, which is only known once the recording filename is
parsed). Reconstruct the live window set at any time `T` by replaying events
with `ts <= T`: keep the last geometry seen per `id`, treat `shown` as
"visible", `removed` as "gone".

```jsonc
// header (prepended at finalize) — videoStartMs lets the consumer map a
// wall-clock ts to video seconds. Server-side we do NOT know the OBS capture
// viewport, so it is intentionally omitted (see "Coordinate space").
{ "v": 1, "kind": "header", "videoStartMs": 1736900000000 }

// a window appeared (a publication went live and mapped to this slot). Carries
// the current geometry if a slot position was already remembered.
{ "ts": 1736900010000, "id": "owner-0xab12…-camera", "shown": true,
  "x": 520, "y": 88, "w": 480, "h": 360, "z": 6 }

// a window moved/resized (throttled — coalesced to ≤1 line/slot/150ms)
{ "ts": 1736900012345, "id": "owner-0xab12…-camera", "x": 540, "y": 90, "w": 480, "h": 360, "z": 7 }

// a window closed (unpublished, or its peer disconnected)
{ "ts": 1736900098765, "id": "owner-0xab12…-camera", "removed": true }
```

**Identity lives in the `id`, not in extra fields.** The slot id is
`owner-<ownerKey>-<kind>` (or `owner-<ownerKey>-screen-<streamId>` for screen
shares) — the exact `slotIdFor` convention shared with the frontend. So the
consumer parses `ownerKey` + `kind` (`camera | screen | audio`) straight from
the id and joins `ownerKey → handle` via `manifest.participants` (the clipper
already loads this for speaker attribution; `ownerKey` is the lowercased wallet
address for logged-in users). This keeps the relay decoupled — **no roster
lookup, no handle/owner/kind duplicated into each line, no fragile parsing on
the write side.** Only media slots (`owner-…` ids) are logged; browser/app
windows aren't speakers and are skipped to keep the log tiny.

- `videoStartMs`: stamped at finalize from the recording filename. Consumer maps
  `videoSec = (ts - videoStartMs) / 1000` — the **same alignment** the relay
  already computes for AI meta chapters and the clipper already uses for speaker
  attribution.

---

## Changes to `slop-computer-live` — **DONE**

### 1. Accumulate the log during the session

New file `packages/relay/src/geometry-log.ts` — a `GeometryLog` class with
`recordMove(slot)` / `recordShow(id, slot)` / `recordHide(id)` / `readArchive()`,
writing to `./.slop-data/rooms/<slug>/geometry.jsonl` (append-only via
`appendFileSync`, mirroring `Transcript.persist`).

The key improvement over the first draft: **every geometry/visibility mutation
is already a method on `DesktopState`**, so the log is owned by and wired
*inside* `DesktopState` (`packages/relay/src/desktop.ts`), not scattered across
WS handlers:

- `applySlotUpdate()` → `recordMove(merged)` — covers **both** the `slot_update`
  WS case *and* the HTTP `POST /v1/slots` route with zero call-site duplication.
- `publish()` → `recordShow(slotIdFor(p), getSlot(slotId))` — window appeared.
- `unpublish()` → `recordHide(slotIdFor(removed))` — window closed.
- `clearPeerPublications()` → `recordHide` per ended publication — peer
  disconnected (both the stale-peer sweep and the socket `close` path call this).

`slotIdFor()` was added to `desktop.ts` (mirrors the frontend's `Desktop.tsx`).
Throttle: `recordMove` coalesces to ≤1 line/slot/150ms with a trailing flush so
the final resting position always lands. `slots.json` is untouched — this is a
separate append-only time-series.

`GeometryLog` is constructed in `room.ts` (`paths.geometry.path`) and passed to
`new DesktopState(..., this.geometry)`; the room also keeps a `geometry`
reference so finalize can snapshot it.

### 2. Pin it at finalize and reference it in the manifest

In `packages/relay/src/recordings.ts`, mirroring the transcript/chat path:

- `finalizeRecording(opts)` gained `geometryArchive: { content; sampleCount } |
  null`; the caller in `index.ts` passes `room.geometry.readArchive()`.
- When `sampleCount > 0`: prepend the `{ v:1, kind:"header", videoStartMs }`
  line (using the `videoStartMs` hoisted from the recording filename), pin via
  the existing `pinBlobToLocalIpfs({ filename: "geometry.jsonl" })`, and emit
  `{ phase: "pinning-geometry", sampleCount }`.
- Manifest gains `geometry?: { cid; sampleCount; format }`, set with
  `if (geometryPin) manifestJson.geometry = geometryPin;`.

No change to the video, the on-chain reference, or any existing pin. Relay
package typechecks clean (`yarn check-types`).

---

## Changes to `slop-computer-frontpage` — **DONE**

Purely additive: added `geometry?: { cid: string; format?: string;
sampleCount?: number }` to `EpisodeManifest` in
`packages/nextjs/types/episode.ts`. Verified safe — the frontpage does **no
schema validation and no field-by-field re-serialization** of the manifest
(`fetchManifest` does `(await res.json()) as EpisodeManifest`, consumers use
optional chaining), so unknown fields pass through untouched. `check-types`
clean. The clipper has its own copy of the manifest type (`src/resolve.ts`) —
the same field was added there too.

---

## How the clipper consumes it (+ fallback) — **BUILT** (`src/geometry.ts`)

In `clawd-clipper`, when resolving a clip's 9:16 layout (the `missing`-windows
loop in `src/index.ts:~254`, which today calls `detectClipWindows()` in
`src/vertical.ts`):

1. If `ep.manifest.geometry?.cid` exists → fetch `geometry.jsonl` (reuse
   `gatewayUrl()` + `fetch`, as `fetchLiveTranscript` does), replay events to the
   clip's `videoSec` window (via `videoStartMs` + the `offsetMs` already computed
   for speaker attribution), take the visible windows' rects, parse `ownerKey`/
   `kind` from each id, and join `ownerKey → handle` via `manifest.participants`.
   **No vision.**
2. Else → the deterministic pixel pipeline in `src/pixels.ts`
   (`traceWindows() → WindowTrace[]`).

**Both paths must normalize to the existing `DetectedWindow[]` that
`composeLayout()` already consumes** — that's the shared contract, not a new
`{left,top,right,bottom}` shape. The geometry path is the richer source: it
carries `z` (occlusion order), `kind`, and `ownerKey`/`handle` for free; the
pixels.ts path supplies only the rect (`windowBox = {x,y,w,h}`) and leaves
`z`/`handle`/`kind` null. Plan a small `src/geometry.ts` (fetch + replay →
`DetectedWindow[]`) so `index.ts` just picks geometry-or-CV and feeds the same
`composeLayout`.

---

## Coordinate space — solved by GOD-FRAME geometry (2026-06)

The first cut logged the relay's **slot rects** (shared-desktop layout px) and
hoped a single affine would map them onto the recorded frame. It didn't: the
slot rects are in *whoever-last-moved-the-window's* viewport space (peers clamp
to their own viewport and rebroadcast), so the log mixed coordinate spaces — a
global affine fit IoU 0.97 *in aggregate* but couldn't reconcile two cameras at
once (verified on `clawdbotatg`). That basis is now the **legacy fallback**,
gated behind `CLIPPER_USE_GEOMETRY`.

The fix (**Option C**): the **god-mode/OBS browser** — the exact DOM that OBS
captures — logs each window's **actual rendered `getBoundingClientRect()`** plus
its own viewport (`vw`/`vh`), via a `god_geometry` WS message. Because the whole
browser is captured uniformly, a rect maps to the recorded frame as `x/vw`,
`y/vh` — **one clean affine, no calibration constant**, and it reconciles every
window including cameras. These lines are tagged `src:"god"` and carry `vw`/`vh`;
the clipper prefers them per-id over any legacy slot line (see `windowsAt` in
`src/geometry.ts`) and uses geometry automatically when they're present (no
`CLIPPER_USE_GEOMETRY` needed). Window *visibility* still comes from the legacy
`recordShow`/`recordHide` stream (which runs unchanged); a closed window simply
drops out of the god snapshot.

**Still empirical:** the recorded composition only exists at broadcast time, so
the calibration (now expected to be exact) is confirmed by running a show on the
new build and checking `yarn compare <slug>` IoU → ~1 (see below).

---

## Status & what's left

| Piece | Repo | Status |
| --- | --- | --- |
| `GeometryLog` + `DesktopState` slot wiring | slop-computer-live | ✅ built, typechecks |
| finalize pin + `manifest.geometry` | slop-computer-live | ✅ built, typechecks |
| `EpisodeManifest.geometry` carry-through | slop-computer-frontpage | ✅ done |
| Legacy slot-coord replay (`CLIPPER_USE_GEOMETRY`) | clawd-clipper | ✅ built (`src/geometry.ts`) |
| **God-frame producer** (`god_geometry`: `Window` `data-slot-id` + measure effect) | slop-computer-live (nextjs) | ✅ built |
| **God-frame transport** (`god_geometry` route → `GeometryLog.recordGod`) | slop-computer-live (relay) | ✅ built |
| **God-frame consumer** (prefer `src:"god"` rects, auto-use) | clawd-clipper | ✅ built (`src/geometry.ts`, `src/index.ts`) |
| Verify on a real clip: `yarn compare <slug>` IoU → ~1 | — | ⬜ needs a recorded episode on the new build |

The god-frame pipeline is code-complete (replay verified on a synthetic log).
The **only** thing left is empirical: run a show on the new relay+nextjs build so
the god browser logs `god_geometry`, finalize pins `geometry.jsonl`, then
`yarn clip <slug> --vertical && yarn compare <slug>` — the geometry boxes should
snap onto the pixel boxes (mean IoU → ~1, vs the legacy basis's ~0.97-but-cameras-
wrong). No calibration constants to set; god-frame rects are self-describing.
