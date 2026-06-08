# Window Geometry Log — cross-repo spec

> **Status (2026-06-07):** relay logging + finalize/manifest pin **built &
> typechecking** in `slop-computer-live`; manifest field **carried through** in
> `slop-computer-frontpage` and `clawd-clipper` types. **Remaining:** the
> clipper *consumption* path (fetch → replay → feed `composeLayout`, CV
> fallback). See "Status & what's left" at the bottom. This doc is updated to
> describe what was actually built, which is simpler than the first draft.


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

## Coordinate space (the one wrinkle — still unverified)

Slot rects are in the **shared-desktop layout** coord space the frontend renders
in; OBS captures that browser, possibly scaled/cropped, into the recorded frame
(typically 1920×1080). The relay does **not** know the capture viewport, so the
header omits it — the consumer maps rects with a single affine transform:
`scale = recordedFrame.height / layout.height` (plus an x/y offset if cropped).
For a 1:1 capture this is identity. **This is the one genuinely open risk:**
nobody has confirmed the capture is 1:1, so the first integration test should
overlay a replayed rect on a real frame and read off the calibration constant.
The visual-marker idea (a machine-readable code baked into each title bar, in
capture pixels) remains the future option that sidesteps coordinate mapping
entirely.

---

## Status & what's left

| Piece | Repo | Status |
| --- | --- | --- |
| `GeometryLog` + `DesktopState` wiring | slop-computer-live | ✅ built, typechecks |
| finalize pin + `manifest.geometry` | slop-computer-live | ✅ built, typechecks |
| `EpisodeManifest.geometry` carry-through | slop-computer-frontpage | ✅ done |
| `EpisodeManifest.geometry` in clipper type | clawd-clipper | ✅ done |
| Fetch + replay + `DetectedWindow[]` adapter | clawd-clipper | ✅ built (`src/geometry.ts`) |
| Wire geometry-or-CV switch into `index.ts` | clawd-clipper | ✅ built |
| Verify coordinate-space calibration on a real clip | — | ⬜ needs a recorded episode |

The full pipeline is code-complete: the relay logs + pins `geometry.jsonl`, and
the clipper reads it (replay verified on a synthetic log). The **only** thing
left is empirical: run a show on the new relay build, then confirm the spatial
calibration (layout px → frame fraction) on a real frame. Identity (1:1 at
1920×1080) is the default; if the capture is scaled/cropped, set
`CLIPPER_GEOM_LAYOUT_W/H` and `CLIPPER_GEOM_OFFSET_X/Y` — no code change.
