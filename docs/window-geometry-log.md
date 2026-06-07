# Window Geometry Log — cross-repo spec

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

## Data format — `geometry.jsonl`

Append-only, newline-delimited JSON, time-ordered. First line is a header; the
rest are slot deltas. Reconstruct the live window set at any time `T` by
replaying events with `ts <= T` (last write per `id` wins; `removed` drops it).

```jsonc
// header (first line) — viewport is the coord space of the rects below; the
// recorded frame may be a scaled/cropped capture of it (see "Coordinate space").
{ "v": 1, "kind": "header", "viewport": { "width": 1920, "height": 1080 }, "videoStartMs": 1736900000000 }

// a window moved/resized/appeared (one per change, throttled — see below)
{ "ts": 1736900012345, "id": "owner-0xab12…-camera", "owner": "0xab12…", "handle": "binji",
  "slotKind": "camera", "x": 520, "y": 88, "w": 480, "h": 360, "z": 6 }

// a window closed / unpublished
{ "ts": 1736900098765, "id": "owner-0xab12…-camera", "removed": true }
```

- `slotKind`: `"camera" | "screen" | "audio"` (matches `desktop.ts` `SlotKind`).
- `handle`: resolved display name when known (lets the clipper map speaker → tile
  with zero fuzzy matching). May be null for anon/unknown.
- `videoStartMs`: filled in at finalize. Consumer maps `videoSec = (ts -
  videoStartMs) / 1000` — the **same alignment** the relay already computes for
  AI meta and the clipper already uses for speaker attribution.

---

## Changes to `slop-computer-live`

### 1. Accumulate the log during the session

Every geometry change funnels through **one chokepoint** already:
`DesktopState.applySlotUpdate(patch)` in `packages/relay/src/desktop.ts`
(invoked from the `slot_update` WS case in `packages/relay/src/index.ts`,
~line 6176, which then `room.broadcast({ type: "slot", slot: merged })`).

Add a sibling **`GeometryLog`** (new file, e.g. `packages/relay/src/geometry-log.ts`)
owned per-room, writing to `./.slop-data/rooms/<slug>/geometry.jsonl`:

- On every accepted `applySlotUpdate` → append a delta line for the merged slot
  (resolve `owner`/`handle`/`slotKind` from the slot id + roster).
- On window **close / unpublish** → append a `{ removed: true }` line.
- **Throttle**: a drag fires many updates — coalesce to **≤1 line per slot per
  ~150ms** (or emit only on drag-end), and reuse the existing atomic-write
  debounce pattern from `DesktopState`'s slots persistence. Goal: a log that's
  tiny next to chat/transcript.
- Keep it **separate** from `slots.json` (that stays the current-state snapshot,
  untouched). This is the time-series, append-only.

### 2. Pin it at finalize and reference it in the manifest

In `packages/relay/src/recordings.ts`, mirror the transcript/chat path exactly:

- Add a `geometryArchive: { content: string; sampleCount: number } | null` field
  to `finalizeRecording(opts)` (caller snapshots the room's `geometry.jsonl` and
  passes it, like `transcriptArchive`).
- Pin it with the existing `pinBlobToLocalIpfs(...)` helper (`filename:
  "geometry.jsonl"`), emit a `{ phase: "pinning-geometry" }` event.
- Stamp the header's `videoStartMs` from the value finalize already has.
- Add to the manifest object built in `finalizeRecording`:

  ```ts
  geometry?: { cid: string; sampleCount: number; format: "application/jsonl" };
  // ...
  if (geometryPin) manifestJson.geometry = geometryPin;
  ```

No change to the video, the on-chain reference, or any existing pin.

---

## Changes to `slop-computer-frontpage`

Purely additive — the frontpage just needs to **carry the field through** so
consumers (the clipper) can read `manifest.geometry.cid`. Extend
`EpisodeManifest` in `packages/nextjs/types/episode.ts`:

```ts
export type EpisodeManifest = {
  // …existing fields…
  /** Time-series of window geometry over the episode (geometry.jsonl on IPFS).
   *  Lets tools read exact window rects instead of recovering them from pixels. */
  geometry?: { cid: string; format?: string; sampleCount?: number };
};
```

That's it for the frontend unless we later want to *use* it (e.g. an in-page
"isolate this speaker" view). The key requirement: whatever code parses/re-emits
the manifest must **not strip unknown fields** — keep `geometry` intact.

---

## How the clipper consumes it (+ fallback)

In `clawd-clipper`, when resolving a clip's 9:16 layout:

1. If `ep.manifest.geometry?.cid` exists → fetch `geometry.jsonl`, replay to the
   clip's `videoSec` (via `videoStartMs`), and take the live windows' rects (+ z
   for occlusion order, + `handle` for speaker→tile). **No vision.**
2. Else → current deterministic pixel pipeline in `src/pixels.ts`.

Same downstream contract either way: per-window `{ left, top, right, bottom,
handle, z }`.

---

## Coordinate space (the one wrinkle)

The rects are in the **host browser's viewport** coords (`header.viewport`). OBS
captures that browser, possibly scaled/cropped, into the recorded frame
(typically 1920×1080). The consumer maps rects with a single affine transform:
`scale = recordedFrame.height / viewport.height` (and an x/y offset if cropped).
For a 1:1 capture this is identity. If it ever differs, one calibration constant
per capture setup resolves it — and the visual-marker idea (a machine-readable
code baked into each title bar, in capture pixels) remains the future option that
sidesteps coordinate mapping entirely.
