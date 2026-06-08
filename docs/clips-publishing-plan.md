# Clips publishing — cross-repo plan

**Goal:** every episode page (`https://slop.computer/<slug>`) shows, at the
bottom, the AI-generated **9:16 vertical clips** + their **suggested tweet copy**
(short + long) that `clawd-clipper` already produces — automatically, from the
episode's manifest, with at most one extra button in `/admin`.

**Today:** `clawd-clipper` produces, under `out/<slug>/`:
- `clips/NN_*.mobile.mp4` — 1080×1920 clips (stacked speaker tiles on the slop
  desktop background, captions burned on the seam),
- `clips/NN_*.mp4` / `.srt` — the 16:9 cut + captions,
- `index.json` — ranked clips with `title`, `start`, `end`, `speakers`,
  `tweetShort`, `tweetLong`, `mobileFile`, `srt`, `captionText`,
- a local `index.html` gallery (with copy buttons).

That output never leaves the laptop. This plan ships it.

---

## The one design decision: clips attach AFTER finalize

The relay's `finalizeRecording` (`slop-computer-live/packages/relay/src/recordings.ts`)
pins the **video** first, then transcript/chat/card, then builds + pins
`manifest.json`, then the admin calls `setManifest(id, ipfs://<cid>)` on-chain.

Clips **depend on that finalized video** (the clipper downloads the episode mp4
and runs vision + ffmpeg + headless Chrome — minutes of work, plus an Anthropic
API key). So clips can't be part of the initial finalize. They attach as a
**manifest update**: produce a *new* manifest JSON = old manifest + a `clips`
field, pin it, and `setManifest` to the new CID. The on-chain `manifest` string
is already mutable via `setManifest` (`SlopComputer.sol:setManifest`), so this is
just a second, later call — no contract change.

This also keeps the heavy clipper OFF the relay's finalize path (which must stay
fast and not need a vision API key or Chrome).

```
record ──▶ /admin finalize ──▶ manifest v1 (video/transcript/chat/card) ──▶ setManifest
                                                                                  │
                                              (episode is live, no clips yet)     │
                                                                                  ▼
host runs:  clawd-clipper <slug> --vertical --publish
              ├─ make clips + tweets (existing)
              ├─ pin each .mobile.mp4 (+ .srt) to IPFS
              ├─ pin clips.json (timings + tweets + per-clip CIDs)  ─▶ clipsCid
              └─ fetch manifest v1, add `clips`, pin manifest v2     ─▶ newManifestCid
                                                                                  │
            /admin ▶ paste newManifestCid ▶ "Save manifest"  (setManifest) ◀──────┘
                                                                                  ▼
                          slop.computer/<slug> renders the Clips section
```

The only manual step: paste one CID into `/admin` and hit save (the button you
said is fine).

---

## Data format

### `clips.json` (the clips bundle, pinned to IPFS)

Self-contained; the frontpage fetches it from `manifest.clips.cid` and renders
without any other lookups. CIDs are `ipfs://…` so the frontpage's existing
`gatewayUrl()` resolves them.

```jsonc
{
  "v": 1,
  "slug": "binji-x",
  "generatedAt": "2026-06-07T19:11:00Z",   // stamped by --publish
  "clips": [
    {
      "rank": 1,
      "title": "Worst time to be a junior dev, best time to be solo",
      "startSec": 1920.62,
      "endSec": 1949.86,
      "durationSec": 29.24,
      "speakers": ["austingriffith.eth", "binji"],
      "mobile": { "cid": "ipfs://bafy…", "w": 1080, "h": 1920, "format": "video/mp4", "sizeBytes": 15166546 },
      "landscape": { "cid": "ipfs://bafy…", "format": "video/mp4" },   // optional
      "captions": { "cid": "ipfs://bafy…", "format": "application/x-subrip" }, // .srt, optional
      "tweetShort": "Worst time in history to be a junior dev. Best time ever to be a solo founder.",
      "tweetLong": "austingriffith.eth's take: it's a terrible time to be a junior developer, but …"
    }
    // … one per clip, already in rank order
  ]
}
```

### Manifest field (`slop-computer-frontpage/packages/nextjs/types/episode.ts`)

Mirror the existing `transcript`/`chat`/`card` shape — purely additive:

```ts
export type EpisodeManifest = {
  // …existing…
  /** AI-generated vertical clips + tweet copy (clips.json on IPFS). */
  clips?: { cid: string; count?: number; format?: "application/json" };
};
```

> Scope note like the geometry log: this is additive. Whatever parses/re-emits
> the manifest must **not strip unknown fields** — keep `clips` intact.

---

## Changes to `clawd-clipper`

A new **`--publish`** step (only runs when asked; no behaviour change otherwise).
New file `src/publish.ts`, invoked from `src/index.ts` after `buildClips`.

1. **Config** (`src/config.ts`): add
   - `ipfsApiUrl` (kubo `/api/v0/add` endpoint — same one the relay uses, e.g.
     `http://127.0.0.1:5001`),
   - read from env (`IPFS_API_URL`). If absent and `--publish` is passed, error
     with instructions (don't silently skip).

2. **Pin helper** (`src/publish.ts`): copy the relay's tiny `pinBlob` /
   `pinToLocalIpfs` pattern (`slop-computer-live/packages/relay/src/ipfs.ts`,
   `recordings.ts:pinToLocalIpfs`) — POST a `FormData` blob to
   `${ipfsApiUrl}/api/v0/add?pin=true`, parse the last NDJSON line's `Hash`.
   Stream the mp4s (they're ~15 MB each, 16 clips ≈ 250 MB total).

3. **Publish flow** (`src/publish.ts`, called when `args.publish`):
   - For each clip: pin `<base>.mobile.mp4` (+ `.srt` if present, + landscape
     `.mp4` if we want it) → collect CIDs.
   - Build `clips.json` from `index.json`'s clips (rank/title/start/end/speakers/
     tweetShort/tweetLong) + the pinned CIDs. Stamp `generatedAt` (pass the
     timestamp in — `Date.now()` is fine here, this is a one-shot CLI).
   - Pin `clips.json` → `clipsCid`.
   - **Augment the manifest**: fetch the current manifest JSON from
     `ep.manifest` (the clipper already resolves the episode + manifest CID in
     `resolve.ts`), add `clips: { cid: "ipfs://"+clipsCid, count, format }`,
     pin → `newManifestCid`.
   - Print clearly:
     ```
     ✓ clips bundle: ipfs://<clipsCid>  (16 clips, 251 MB)
     ✓ updated manifest: ipfs://<newManifestCid>
       → paste this into /admin "Manifest CID" and Save.
     ```

4. **CLI** (`src/index.ts` `parseArgs`): add `--publish` (default false), and
   gate the publish step behind it (and `args.vertical`, since clips need the
   mobile mp4s).

No on-chain writes from the clipper (keeps the deployer key out of the tool). The
clipper stops at "here's the manifest CID."

---

## Changes to `slop-computer-frontpage`

1. **Type** (`types/episode.ts`): add the `clips?` field above. Optionally export
   a `ClipsBundle` / `Clip` type matching `clips.json`.

2. **Fetch + render** (`components/EpisodeView.tsx`): the manifest is already
   loaded via `fetchManifest(episode.manifest)`. Add a bottom section (after the
   existing metadata sections, ~line 535):
   ```tsx
   {manifest?.clips?.[0]?.cid ? <ClipsSection bundleUrl={manifest.clips[0].cid} /> : null}
   ```
   `ClipsSection` (new component):
   - `fetch(gatewayUrl(bundleUrl))` → `clips.json`,
   - render a responsive grid/scroller of 9:16 `<video controls preload="none"
     poster=…>` (src = `gatewayUrl(clip.mobile.cid, filename)`), each with title,
     speakers, and the **short/long tweet with copy buttons** (port the markup +
     `.tweets`/`.tw`/`copy` styles straight from `clawd-clipper/src/gallery.ts`),
   - lazy-load videos (`preload="none"`) so 16 players don't hammer the gateway.

3. **Admin** (`app/admin/page.tsx`): smallest possible change — the page already
   has `setManifest` wiring (`saveManifest()` writes `ipfs://<manifestCid>`). Add
   a **"Manifest CID"** text input + "Save" that calls the same `setManifest`
   with the pasted CID. (Today `manifestCid` comes only from the finalize stream;
   this lets you set the clipper's `newManifestCid` later.) That's the one button.

No relay changes required in this approach — the clipper pins directly to the same
kubo node. (If we'd rather the relay own all pinning, a `/admin/attach-clips`
endpoint is the alternative; see below.)

---

## Admin workflow (what you actually do)

1. Finish the stream → `/admin` → **Pin to IPFS** → **Save Manifest** (today's
   flow; episode goes live without clips).
2. On your machine: `IPFS_API_URL=http://127.0.0.1:5001 yarn clip binji-x --vertical --publish`
   (kubo running — the same node the relay pins to, or any reachable kubo).
3. Copy the printed `ipfs://<newManifestCid>`.
4. `/admin` → paste into **Manifest CID** → **Save**. (one tx)
5. `slop.computer/binji-x` now shows the Clips section.

Re-running the clipper + repasting updates clips idempotently (new manifest CID
each time; old artifacts stay pinned).

---

## IPFS / pinning notes

- **Where it pins:** the clipper needs a kubo `/api/v0/add` endpoint. Easiest is
  the same node the relay uses (`config.ipfsApiUrl` over there). If the host runs
  the clipper on the relay box (or kubo's API is reachable), reuse it; otherwise
  run a local kubo or point at a pinning service that exposes the kubo add API.
- **Size:** ~16 × 15 MB mobile mp4s ≈ 250 MB per episode. Add landscape cuts and
  it ~doubles. Decide whether to pin landscape too (probably mobile-only for the
  page; landscape is the existing per-clip download if wanted).
- **Gateway:** the frontpage already serves IPFS via
  `NEXT_PUBLIC_IPFS_GATEWAY` (`media.slop.computer/ipfs`) and `gatewayUrl()` —
  clip `<video src>` uses it unchanged.
- **Posters:** optionally pin a JPg first-frame per clip for `<video poster>` so
  the grid isn't 16 black boxes before play. Cheap to add in `--publish`.

---

## Alternative considered (relay-owned pinning)

Instead of the clipper pinning, add a relay endpoint
`POST /admin/attach-clips?slug=` that accepts the clip files (or a clips.json the
clipper already built with CIDs), pins what's missing, augments + pins the
manifest, and returns `newManifestCid`. The admin button then drives that.

- **Pro:** one place owns kubo; the clipper never touches IPFS; admin uploads
  files through the relay.
- **Con:** pushing 250 MB through the relay HTTP API; more relay code; the
  clipper would have to upload raw files. The recommended approach (clipper pins
  to kubo directly, admin just sets the CID) is less moving-parts and mirrors how
  the geometry-log plan keeps the clipper as the IPFS producer.

---

## Open questions for you

1. **Pin target:** is the relay's kubo reachable from where you run the clipper,
   or should `--publish` point at a separate kubo / pinning service?
2. **Landscape clips on the page too, or mobile-only?** (affects pin size)
3. **Posters:** want first-frame JPgs for the `<video>` grid? (nicer, +small pin)
4. **Manifest update UX:** a bare "Manifest CID" box in `/admin`, or a dedicated
   "Attach clips (paste clips CID)" box that fetches+augments+pins the manifest
   in-browser via a relay helper? The former is ~zero code; the latter is one
   button that does everything but needs a small relay/SDK pin call.
```
