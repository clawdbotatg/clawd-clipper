import { gatewayUrl } from "./resolve.js";
import type { DetectedWindow, WinKind } from "./vertical.js";

// Window geometry from the upstream log — the deterministic alternative to the
// vision/pixel detection in vertical.ts. slop-computer-live records every
// shared-desktop window's exact rect over the session into geometry.jsonl and
// pins it (manifest.geometry.cid). Here we fetch it, replay it to a clip's
// mid-frame time, and emit the same DetectedWindow[] composeLayout() already
// consumes — so the 9:16 layout reads exact boxes instead of recovering them
// from pixels. See clawd-clipper/docs/window-geometry-log.md for the spec.
//
// Two alignments matter:
//
//  • TIME — geometry events carry the relay's wall-clock `ts`, the SAME clock as
//    the live transcript. So we map a clip's video seconds to wall-clock with the
//    very offset alignToVideo() already recovers from the transcript
//    (wallMs = videoSec*1000 + offsetMs). That offset is empirical and cancels
//    capture/receive skew — more reliable than the filename-parsed videoStartMs,
//    which we keep only as a fallback when transcript alignment isn't available.
//
//  • SPACE — two bases, picked per entry by windowsAt():
//
//    GOD-FRAME (src:"god", the current upstream): each window's rect is the
//    ACTUAL rendered box in the OBS-capture browser, logged with that browser's
//    viewport (vw/vh). The whole browser is captured uniformly, so frame fraction
//    is just x/vw, y/vh — one clean affine, no calibration constant, and it
//    reconciles every window (cameras included). This is the fix for the failure
//    the LEGACY basis below hit. logHasGodGeometry() detects it; index.ts then
//    drives a SEPARATE geometry 9:16 take from it (no CLIPPER_USE_GEOMETRY
//    needed) — the CV/pixel detector still drives the primary take, so the two
//    framings render in parallel and can be A/B'd (yarn compare).
//
//    LEGACY (slot-px, older episodes): rects are the relay's interactive
//    god-desktop SLOT coords, in whoever-last-moved-the-window's viewport px —
//    a different composition from what OBS recorded. We map them with a single
//    fitted affine (LAYOUT_W/H below): CALIBRATED 2026-06-08 on `clawdbotatg` to
//    ~1717×960 (scale ≈1.12), mean IoU 0.97 in aggregate — but it can't reconcile
//    two cameras at once (their slot rects live in different viewport spaces), so
//    this basis stays gated behind CLIPPER_USE_GEOMETRY. Re-fit with
//    `yarn compare <slug>`; all four are env-overridable
//    (CLIPPER_GEOM_LAYOUT_W/H, CLIPPER_GEOM_OFFSET_X/Y).

const LAYOUT_W = Number(process.env.CLIPPER_GEOM_LAYOUT_W) || 1717;
const LAYOUT_H = Number(process.env.CLIPPER_GEOM_LAYOUT_H) || 960;
const OFFSET_X = Number(process.env.CLIPPER_GEOM_OFFSET_X) || -8; // layout px subtracted before scaling
const OFFSET_Y = Number(process.env.CLIPPER_GEOM_OFFSET_Y) || 0;

type GeomEvent = {
  ts: number;
  id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  shown?: boolean;
  removed?: boolean;
  // GOD-FRAME basis (src:"god"): x/y/w/h are the window's actual rendered rect in
  // the OBS-capture browser, in that browser's CSS px, and vw/vh is that browser's
  // viewport. Recorded-frame fraction is then x/vw, y/vh — one clean affine, no
  // calibration guess. Absent ⇒ legacy slot-px basis (the LAYOUT_W/H affine).
  vw?: number;
  vh?: number;
  src?: string;
};

export type GeometryLog = {
  /** Recording start in wall-clock ms, from the header. Fallback time anchor
   *  when transcript alignment (the preferred offset) isn't available. */
  videoStartMs: number | null;
  /** Time-ordered events (ascending `ts`). */
  events: GeomEvent[];
};

/** Fetch + parse geometry.jsonl. First line may be a `{kind:"header"}` carrying
 *  videoStartMs; the rest are events. Tolerant of corrupt lines. */
export async function fetchGeometryLog(cid: string): Promise<GeometryLog> {
  const res = await fetch(gatewayUrl(cid));
  if (!res.ok) throw new Error(`geometry fetch ${res.status} for ${cid}`);
  const raw = await res.text();
  let videoStartMs: number | null = null;
  const events: GeomEvent[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: GeomEvent & { kind?: string; videoStartMs?: number | null };
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.kind === "header") {
      videoStartMs = typeof o.videoStartMs === "number" ? o.videoStartMs : null;
      continue;
    }
    if (typeof o.ts !== "number" || typeof o.id !== "string") continue;
    events.push(o);
  }
  events.sort((a, b) => a.ts - b.ts);
  return { videoStartMs, events };
}

/** Parse a media slot id into its owner + window kind. The id encodes both:
 *    owner-<ownerKey>-camera | owner-<ownerKey>-audio
 *    owner-<ownerKey>-screen-<streamId> | owner-<ownerKey>-screen
 *  `ownerKey` is a lowercased wallet address (or handle, for anon). Audio slots
 *  render as an avatar tile, so they map to the "camera" WinKind for layout. */
function parseSlotId(id: string): { ownerKey: string; kind: WinKind } | null {
  if (!id.startsWith("owner-")) return null;
  const rest = id.slice("owner-".length);
  const screenAt = rest.indexOf("-screen-");
  if (screenAt >= 0) return { ownerKey: rest.slice(0, screenAt), kind: "screen" };
  if (rest.endsWith("-screen")) return { ownerKey: rest.slice(0, -"-screen".length), kind: "screen" };
  if (rest.endsWith("-camera")) return { ownerKey: rest.slice(0, -"-camera".length), kind: "camera" };
  if (rest.endsWith("-audio")) return { ownerKey: rest.slice(0, -"-audio".length), kind: "camera" };
  return null;
}

/**
 * Replay the log to wall-clock time `tWallMs` and return the windows visible at
 * that instant as DetectedWindow[] (frame fractions). Last write per slot wins;
 * `shown` makes a slot visible, `removed` hides it. Windows are returned topmost
 * (highest z) first so composeLayout's `cams[0]` fallback picks the frontmost.
 *
 * A new episode interleaves TWO geom streams on the same log: the legacy
 * slot-coord lines (recordMove/Show) and the god-frame lines (src:"god", with
 * vw/vh). We keep them in SEPARATE maps and always PREFER the god rect per id —
 * so an interleaved slot line can never clobber the correct rendered rect,
 * regardless of write order. Legacy slot geom is the fallback for ids the god
 * stream never covered (older eps, or windows off the captured frame).
 *
 * `names` resolves ownerKey → handle (from manifest.participants) so the label
 * feeds composeLayout's speaker↔camera matching with zero fuzzy guessing.
 */
export function windowsAt(log: GeometryLog, tWallMs: number, names: Record<string, string> = {}): DetectedWindow[] {
  type G = { x: number; y: number; w: number; h: number; z: number; vw?: number; vh?: number };
  const godGeom = new Map<string, G>();
  const legacyGeom = new Map<string, G>();
  const visible = new Map<string, boolean>();
  for (const e of log.events) {
    if (e.ts > tWallMs) break; // events are sorted ascending
    if (
      typeof e.x === "number" &&
      typeof e.y === "number" &&
      typeof e.w === "number" &&
      typeof e.h === "number"
    ) {
      const z = typeof e.z === "number" ? e.z : 0;
      if (typeof e.vw === "number" && e.vw > 0 && typeof e.vh === "number" && e.vh > 0) {
        godGeom.set(e.id, { x: e.x, y: e.y, w: e.w, h: e.h, z, vw: e.vw, vh: e.vh });
      } else {
        legacyGeom.set(e.id, { x: e.x, y: e.y, w: e.w, h: e.h, z });
      }
    }
    if (e.shown) visible.set(e.id, true);
    if (e.removed) visible.set(e.id, false);
  }

  const rows: { win: DetectedWindow; z: number }[] = [];
  for (const [id, vis] of visible) {
    if (!vis) continue;
    const g = godGeom.get(id) ?? legacyGeom.get(id);
    if (!g) continue;
    const parsed = parseSlotId(id);
    if (!parsed) continue;
    // → frame fraction. GOD-FRAME entries (carry their own capture viewport)
    // normalize by it directly — one clean affine, no calibration guess. Legacy
    // slot-px entries fall back to the fitted LAYOUT_W/H affine.
    let x: number, y: number, w: number, h: number;
    if (g.vw && g.vh) {
      x = g.x / g.vw;
      y = g.y / g.vh;
      w = g.w / g.vw;
      h = g.h / g.vh;
    } else {
      x = (g.x - OFFSET_X) / LAYOUT_W;
      y = (g.y - OFFSET_Y) / LAYOUT_H;
      w = g.w / LAYOUT_W;
      h = g.h / LAYOUT_H;
    }
    if (!(w > 0 && h > 0)) continue;
    if (x >= 1 || y >= 1 || x + w <= 0 || y + h <= 0) continue; // fully off-frame
    const label = names[parsed.ownerKey.toLowerCase()] ?? parsed.ownerKey;
    rows.push({ win: { kind: parsed.kind, label, x, y, w, h }, z: g.z });
  }
  rows.sort((a, b) => b.z - a.z);
  return rows.map(r => r.win);
}

/** Does the log carry GOD-FRAME geometry — windows measured as their actual
 *  rendered rect in the OBS-capture browser (src:"god", carrying vw/vh)? These
 *  map to the recorded frame with no calibration guess, so the clipper trusts
 *  them automatically (vs. the legacy slot-px basis, which is gated behind
 *  CLIPPER_USE_GEOMETRY because its single-affine fit can't reconcile cameras). */
export function logHasGodGeometry(log: GeometryLog): boolean {
  return log.events.some(e => e.src === "god" && typeof e.vw === "number" && typeof e.vh === "number");
}
