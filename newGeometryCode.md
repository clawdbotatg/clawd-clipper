# Geometry code — what changed and what to watch out for

A reference for future-you. The clipper makes **9:16 mobile clips** from a wide
desktop recording. To do that it has to know *where each window is* in the
video (which rectangle is binji's camera, which is the shared screen) so it can
crop and stack them. This doc is about **how it learns those rectangles**, the
bug we just fixed, and the things that can still bite.

> TL;DR — there were two ways to find window rectangles: (a) **computer vision**
> on the recorded pixels, and (b) a **geometry log** the relay writes. The
> geometry log used to log the *wrong coordinates* and was disabled. We changed
> the relay so the **OBS-capture browser logs the windows' actual on-screen
> rectangles**, which line up with the recording exactly. The clipper now uses
> that automatically. It's code-complete but **only truly proven once a real
> show is recorded on the new build** (see "How to verify").

---

## The mental model (read this first)

There are **two different pictures** of the same desktop, and the whole bug is
about confusing them.

1. **The interactive desktop** — slop.computer is a shared desktop. Each person's
   webcam / screen-share / app is a draggable window. Everyone in the room sees
   it, and *each person sees it in their own browser at their own size*. If Alice
   drags her camera to the right edge of her 1920-wide screen, that position is
   shared to everyone. Bob, on a 1400-wide laptop, would see it hanging off-screen,
   so Bob's browser **clamps** it back on-screen — and broadcasts that clamped
   position back. So the shared "where is this window" number is **whatever the
   last person to touch it had**, in *their* screen's pixels.

2. **The recording** — a special "god-mode" browser is open (no editing UI, just
   the desktop), and **OBS screen-records that one browser** into the MP4. So the
   recording is exactly *one browser's* rendering of the desktop.

The clipper works on picture #2 (the MP4). It needs the window rectangles **as
they appear in that recording**.

---

## Why it was broken

The geometry log was recording picture #1's numbers (the shared "slot" positions,
in whoever-last-moved-it's pixel space). The clipper then tried to stretch those
numbers onto picture #2 (the recording) with a single scale factor.

That *almost* worked — on average the boxes were ~97% right. But because the slot
numbers were a **mix of different people's screen sizes**, you could never line up
*all* the windows at once with one scale. Specifically: with two cameras on
screen, you could get one right or the other, never both. So we **turned the
geometry log off** and fell back to computer vision (which reads the actual
recorded pixels, so it's always in the right coordinate space — just slower and
occasionally wrong about labels).

The key realization: **the recording is just one browser's DOM.** That browser
already knows exactly where every window is on its own screen
(`element.getBoundingClientRect()`). If *that* browser logs the rectangles, they
line up with the recording perfectly — because they came from the same pixels.

---

## What we changed (the fix: "god-frame" geometry)

We made the **god-mode/OBS browser log each window's real on-screen rectangle**,
plus its own window size. Because OBS captures that whole browser uniformly, a
rectangle at `x` pixels in a browser that's `vw` pixels wide is at `x / vw` of
the way across the recorded frame — **one clean conversion, no guessing, works
for every window including both cameras.**

These new log entries are tagged `src:"god"` and carry the browser size
(`vw`/`vh`). The clipper trusts them automatically. The old slot-coordinate path
still exists as a fallback for already-recorded episodes, gated behind an env
flag.

**Important — geometry does NOT replace the CV detector; it runs *alongside* it.**
The proven pixel/CV detector still frames the **primary** 9:16 clip. Geometry
drives a **separate, parallel** 9:16 take so the two can be compared (and you can
flip which is "primary" later, once geometry is trusted). So a `--vertical` clip
now renders up to **four** outputs: the 16:9 landscape, plus three 9:16 framings —
CV (`.mobile.mp4`, primary), geometry (`.geom.mobile.mp4`), and the
deliberately-different alt-composition (`.alt.mobile.mp4`, full-screen / swapped).
The gallery's top buttons toggle all clips between them; `--publish` pins all of
them and the admin can pick. (Cost: ~4 re-encoded cuts per clip — heavier, but
that's the point during the trust-building phase.)

### The data flow (two repos)

```
 god-mode browser (slop-computer-live / packages/nextjs)
   Window.tsx        — every window tagged with data-slot-id
   Desktop.tsx       — effect measures getBoundingClientRect() of each
                        window + window size, ~once/sec, only when it changes
   usePeerMesh.ts    — sends a "god_geometry" websocket message
        │
        ▼  websocket
 relay (slop-computer-live / packages/relay)
   index.ts          — validates the "god_geometry" message (spectator-only)
   room.ts           — recordGodGeometry()
   geometry-log.ts   — recordGod() appends lines to geometry.jsonl
                        tagged src:"god" with vw/vh
        │
        ▼  pinned to IPFS at finalize, referenced by manifest.geometry.cid
 clipper (clawd-clipper)
   geometry.ts       — windowsAt() converts god rects to frame fractions
                        with x/vw, y/vh (prefers them over legacy slot lines)
   index.ts          — CV detector drives the PRIMARY 9:16; the god log drives
                        a SEPARATE parallel geometry take (not a replacement)
   clips.ts          — cuts each 9:16 take (CV / geometry / alt) to its own file
   gallery.ts        — top buttons toggle all clips between the takes
   publish.ts        — pins each take into clips.json for the admin to pick
```

### Files touched (so you can find them later)

**slop-computer-live**
- `packages/nextjs/components/ui/Window.tsx` — added `slotId` prop → renders
  `data-slot-id` on the window's root element (the measurement hook).
- `packages/nextjs/components/Desktop.tsx` — passes `slotId` on each camera/screen
  window; new spectator-only effect that measures the rects and sends them.
- `packages/nextjs/hooks/usePeerMesh.ts` — `sendGodGeometry()` + its type.
- `packages/relay/src/index.ts` — `god_geometry` message handler (validates +
  caps the array; spectator-only).
- `packages/relay/src/room.ts` — `recordGodGeometry()`.
- `packages/relay/src/geometry-log.ts` — `recordGod()` writes the `src:"god"`
  lines; the existing slot logging is untouched.
- `packages/relay/src/skill.ts` — documented the new message in the WS table.

**clawd-clipper**
- `src/geometry.ts` — `windowsAt()` now keeps god vs legacy rects separate and
  prefers god; `logHasGodGeometry()` detects the new format. The big comment at
  the top explains both coordinate bases.
- `src/index.ts` — one geometry fetch+decision; CV drives the primary 9:16,
  geometry drives a separate parallel take, alt-composition is its own take.
- `src/clips.ts` — `cutVertical()` helper cuts each 9:16 take to its own file
  (`.mobile` / `.geom.mobile` / `.alt.mobile`).
- `src/gallery.ts` — switcher buttons (16:9 · CV · geometry · alt).
- `src/publish.ts` — pins the geometry take (`geomMobile`) alongside the rest.

---

## What to watch out for

- **It is NOT verified end-to-end yet.** The recording only exists after a live
  show on the *new* build (both the nextjs and relay deploys). Until then it's
  "should work, typechecks, passes a synthetic test." Don't assume it's working
  on real footage until you've checked (next section).

- **Old episodes are unaffected.** Anything recorded before this ships has no
  `src:"god"` lines, so the clipper uses computer vision (the default) or the
  legacy slot path if you force it. This change only helps **future** episodes.

- **One runtime assumption:** the `data-slot-id` we put on windows has to actually
  reach the rendered HTML. The plain (pre-mount) window does this for sure; the
  draggable window passes it through the `react-rnd` library. It typechecks and
  that library is known to forward `data-*` attributes, but if the geometry log
  comes out empty on a real show, **this is the first thing to check** — open the
  god-mode browser devtools and confirm `document.querySelectorAll('[data-slot-id^="owner-"]')`
  finds the camera/screen windows.

- **Only camera/screen/audio windows are logged** ("media slots", ids starting
  `owner-`). Browser/app windows aren't — that's intentional (they're not
  speakers), and it keeps the log small. If you ever want an app window in a 9:16
  clip, that's a deliberate extension.

- **Window labels still come from elsewhere.** The geometry log says *where* a
  window is and *whose* it is (from the slot id → `manifest.participants`), but
  the speaker→camera matching and the burned nameplate come from the live
  transcript alignment. Geometry being correct won't fix a mislabeled speaker.

- **The `CLIPPER_USE_GEOMETRY` env flag is now only for the OLD path.** You do
  **not** need to set it for the new god-frame logs — those are used
  automatically. Setting it only opts an *old, legacy* slot-coord log back in
  (with the imperfect single-scale fit). Leave it unset normally.

- **Visibility vs position.** The god log says where windows are; *when* a window
  appears/disappears still comes from the original slot show/hide events (which
  still run). A closed window just stops being measured. This is fine in practice
  but worth knowing if a window lingers or vanishes oddly in a clip.

---

## How to verify (do this on the first show after deploy)

1. Run a real show on the new build, finalize it (so `geometry.jsonl` gets pinned
   and `manifest.geometry.cid` is set).
2. `yarn clip <slug> --vertical` — watch the log line. You want to see:
   `geometry log: N events — god-frame rects (exact recorded geometry); driving the geometry 9:16 take`.
   If instead you see "legacy slot coords" or "present but legacy ... skipping the
   geometry take", the god logging didn't happen — check the `data-slot-id`
   assumption above.
3. `yarn compare <slug>` then open `out/<slug>/compare.html`. This shows, per
   clip, the computer-vision boxes (left) vs the geometry boxes (right) with an
   **IoU** number (1.0 = perfect overlap). **Success = mean IoU near ~1, and both
   cameras land correctly** (the thing the old approach couldn't do).
4. Eyeball the takes side by side: open `out/<slug>/index.html` and use the top
   buttons (16:9 · CV · geometry · alt) to flip all clips between framings —
   compare `.mobile.mp4` (CV) vs `.geom.mobile.mp4` (geometry). Faces centered, no
   half-window crops.

If something's off, the safe fallback is always there: the clipper uses computer
vision by default for anything geometry can't cover, so a bad/empty geometry log
degrades to "the old way," never to broken clips.

---

## If you need to roll back

- **Clipper only:** nothing to do — if the log has no god entries it already
  falls back to vision. To ignore even a god log, you'd add a one-line guard in
  `src/index.ts` (where `logHasGodGeometry` is checked).
- **Stop the relay from logging it:** the producer is self-contained — the
  `god_geometry` effect in `Desktop.tsx` and the `recordGod` path. Disabling
  either stops the new lines; the old slot logging keeps working.
- The change is **additive** — no manifest shape change, no contract change, no
  removal of the vision path. Worst case everywhere is "back to computer vision."

---

*Companion docs:* `docs/window-geometry-log.md` is the original cross-repo spec
(now updated with the god-frame approach); the big comment at the top of
`src/geometry.ts` is the in-code version of the coordinate-space explanation.
