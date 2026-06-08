# Clips publishing — cross-repo plan (server-side)

**Goal:** when you finish an episode in `/admin`, **one more button** —
"Generate clips" — makes the server cut the AI 9:16 vertical clips + tweet copy,
pin them to IPFS, fold them into the manifest, and push the one on-chain update.
A minute later `https://slop.computer/<slug>` shows a **Clips** section at the
bottom. No laptop, no manual CID paste.

It's part of the normal publishing process, right after Pin → Save Manifest.
**The server does all the heavy lifting; you sign the one tx** (your wallet, the
same `setManifest` you already use — no server key, no contract change):

```
/admin:  [Check] → [Pin to IPFS] → [Save Manifest] → [Generate clips] → [Save Manifest]
                        │                │                  │                  │
                   video+chat+      manifest v1      server cuts clips,   you sign the
                   transcript+card   on-chain        pins them, builds    prefilled v2 CID
                   → manifest v1                     manifest v2 → CID    (one wallet click)
```

The new **Generate clips** button runs the whole server job and hands back the
new manifest CID, prefilled into the manifest field; you click **Save Manifest**
once more to push it on-chain. Then the Clips section appears on the episode page.

---

## Why this slots in cleanly after finalize

Clips depend on the **finalized video** (the job downloads/loads the episode mp4
and runs ffmpeg + an LLM for clip selection + tweets — a minute or two of work),
so they can't be part of the initial finalize pin. They attach as a **manifest
update**: take manifest v1, add a `clips` field, pin v2, `setManifest` again. The
on-chain `manifest` string is already mutable (`SlopComputer.sol:setManifest`),
so this is just a second call — triggered by the new button instead of by hand.

Keeping it a separate step (not inside `finalizeRecording`) means finalize stays
fast and the heavy clip job can run in the background and stream progress, exactly
like the existing finalize NDJSON stream.

---

## Two things that make the server job light

1. **The desktop background is static.** It's the same slop-computer mobileMode
   desktop (title bar + icon grid + watermark) at 1080×1920 for every clip. We
   **pre-render it once** with headless Chrome (locally, during this work) and
   **commit the PNG as an asset**. The server composites clips over that PNG with
   plain ffmpeg — **no Chrome on the server**.
2. **The LLM is already there.** Finalize already calls a model (the
   `generating-meta` phase), so the API key is on the server — that covers clip
   ranking + tweet copy. And once the **geometry log** lands (see
   `window-geometry-log.md`), window rects come from the log, so the job needs
   **no vision/CV for geometry either**. Net server deps: ffmpeg (already) + the
   existing LLM key + the bundled background PNG.

---

## On-chain: you sign it (no contract change, no server key)

**Decision:** the server never holds a key and the contract is untouched.
`setManifest` stays `onlyOwner` and you sign it from your browser wallet — exactly
like today. The clips job's only job is to produce the new manifest CID; the
button prefills it into the existing manifest field and you hit **Save Manifest**.

So the on-chain flow is unchanged; there's just a new manifest CID to save after
the clip job runs. (If you ever want it fully hands-off later, a low-privilege
"publisher" role on the contract + a server key would remove that last click —
but that's explicitly out of scope here.)

---

## Data format

### `clips.json` (pinned to IPFS; the frontpage reads only this)

```jsonc
{
  "v": 1,
  "slug": "binji-x",
  "generatedAt": "2026-06-07T19:11:00Z",
  "clips": [
    {
      "rank": 1,
      "title": "Worst time to be a junior dev, best time to be solo",
      "startSec": 1920.62, "endSec": 1949.86, "durationSec": 29.24,
      "speakers": ["austingriffith.eth", "binji"],
      "mobile":   { "cid": "ipfs://bafy…", "w": 1080, "h": 1920, "format": "video/mp4", "sizeBytes": 15166546 },
      "poster":   { "cid": "ipfs://bafy…", "format": "image/jpeg" },   // first-frame, optional
      "captions": { "cid": "ipfs://bafy…", "format": "application/x-subrip" }, // optional
      "tweetShort": "Worst time in history to be a junior dev. Best time ever to be a solo founder.",
      "tweetLong":  "austingriffith.eth's take: it's a terrible time to be a junior developer, but …"
    }
    // … one per clip, rank order
  ]
}
```

### Manifest field (`frontpage/packages/nextjs/types/episode.ts`) — additive

```ts
export type EpisodeManifest = {
  // …existing…
  /** AI-generated vertical clips + tweet copy (clips.json on IPFS). */
  clips?: { cid: string; count?: number; format?: "application/json" };
};
```

> Additive, like the geometry log: anything that re-emits the manifest must keep
> unknown fields (`clips`) intact.

---

## Changes by repo

### 1. `slop-computer-live` (relay) — the worker + the route

- **Port the clipper into the relay** as a package/module
  (`packages/relay/src/clips/…`), or vendor it as a dependency. It already shares
  the stack (Node + ffmpeg). Reuse the existing IPFS (bgipfs) pin helpers
  (`ipfs.ts:pinBlob`, `recordings.ts:pinToLocalIpfs`) — no new pinning code.
- **New route** `POST /admin/generate-clips?slug=` (mirror `/admin/finalize`):
  auth via `requireHost`, stream NDJSON progress
  (`{phase:"cutting", i, n}`, `{phase:"pinning-clips", count}`,
  `{phase:"updating-manifest"}`, `{phase:"done", manifestCid}`), run in the
  background like finalize does.
- **The job** (mirrors `finalizeRecording`'s pin → manifest pattern; **no signing**):
  1. Locate the finalized mp4 on disk (the same file finalize just pinned) and
     the current manifest (resolve the episode's manifest CID).
  2. Cut clips over the bundled background PNG; build tweet copy via the existing
     LLM client.
  3. Pin each `.mobile.mp4` (+ poster + srt) → CIDs; build + pin `clips.json` →
     `clipsCid`.
  4. Fetch manifest v1, add `clips: {cid:"ipfs://"+clipsCid, count}`, pin → v2.
  5. Emit `done` with the new manifest CID — the server stops here, the admin
     signs `setManifest` in the browser.
- **Background-job hygiene:** one job per slug at a time; idempotent (re-running
  repins + re-points the manifest; old artifacts stay pinned).

### 2. `slop-computer-frontpage` — the button, the section, the checklist

- **Admin** (`app/admin/page.tsx`): add a **"Generate clips"** action in the
  Finalize panel, after Save Manifest. It POSTs to `/admin/generate-clips?slug=`,
  renders the streamed progress (reuse the finalize NDJSON stream UI), and on
  `done` **prefills the new manifest CID into the manifest field** so you click
  the existing **Save Manifest** to sign it. (Same `saveManifest()` /
  `writeContractAsync({ functionName: "setManifest" })` already in the panel.)
- **Type** (`types/episode.ts`): add the `clips?` field.
- **Episode page** (`components/EpisodeView.tsx`): manifest is already loaded via
  `fetchManifest`; add a bottom section
  `{manifest?.clips?.[0]?.cid ? <ClipsSection bundleUrl={…}/> : null}`.
- **`ClipsSection`** (new): fetch `clips.json` from the CID, render a responsive
  row of 9:16 `<video controls preload="none" poster=…>` (src via the existing
  `gatewayUrl()`), each with title, speakers, and the **short/long tweet + copy
  buttons** — port the markup + styles straight from
  `clawd-clipper/src/gallery.ts`. `preload="none"` so 16 players don't hammer the
  gateway.
- **Checklist** (`checklist.md` + the interactive `app/checklist/page.tsx`): add a
  step in the post-show / finalize section, right after "Save Manifest":
  > - [ ] On `slop.computer/admin` → **Generate clips** → wait for it to finish →
  >   **Save Manifest** again (CID is prefilled) to push the clips on-chain.
  >   Confirm the **Clips** section shows at the bottom of `slop.computer/<slug>`.

  `checklist.md` is the canonical list; mirror the same item into the React
  checklist so it shows up as a real step (optionally with a live check that the
  current manifest has a `clips` field).

---

## Pre-render the background now (removes the Chrome dep)

`clawd-clipper/src/desktop-bg.ts` already renders the 1080×1920 desktop PNG via
Chrome. We run it once, commit the result as
`assets/mobile/desktop-1080x1920.png`, and have the compositor use the committed
PNG when present (rendering on the fly only as a dev convenience). The relay then
ships that PNG and never needs Chrome.

---

## Admin workflow (what you actually do)

1. Finish stream → `/admin` → **Pin to IPFS** → **Save Manifest** (today).
2. Click **Generate clips**. Watch the progress stream (~1–2 min) while the
   server cuts + pins everything and builds the new manifest.
3. The new manifest CID is prefilled → click **Save Manifest** again (your wallet
   signs the one tx).
4. Done — `slop.computer/<slug>` shows the Clips section.

This is captured as a checklist step so it's part of the routine (see above).
Local `yarn clip <slug> --vertical --publish` stays as a **dev/back-catalog
fallback** for re-cutting old episodes by hand.

---

## Open questions for you

1. **Posters?** First-frame JPGs make the grid look alive instead of 16 black
   boxes — small extra pin, recommend yes.
2. **Mobile-only on the page, or landscape too?** (mobile-only ≈ 250 MB/episode)

(On-chain is settled: you sign `setManifest` in the browser — no contract change,
no server key. A fully-auto publisher role is a possible later upgrade, out of
scope here.)
