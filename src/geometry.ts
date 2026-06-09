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
//  • SPACE — slot rects are in the slop desktop LAYOUT coord space (CSS px of the
//    shared-desktop canvas). OBS captures that canvas into the recorded frame.
//    We map layout px → frame fraction with one affine transform.
//
//    CALIBRATED 2026-06-08 on `clawdbotatg`: the recorded frame is 1920×1080 but
//    the layout space is ~1717×960 (the broadcast viewport the relay lays out in
//    is smaller than the OBS canvas, so the capture is scaled ~1.12×, not 1:1).
//    Fit from 29 matched geometry↔pixel window pairs across 12 clips — scale
//    X=1.118, Y=1.125, offset ≈0, sd ≈0.01 — i.e. a single global affine, dead
//    consistent. With these defaults `yarn compare clawdbotatg` reports mean
//    IoU 0.97 (was 0.50 at identity 1920×1080). If the OBS/broadcast capture
//    setup changes, re-fit with `yarn compare <slug>` and update these four (all
//    env-overridable: CLIPPER_GEOM_LAYOUT_W/H, CLIPPER_GEOM_OFFSET_X/Y).

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
 * `names` resolves ownerKey → handle (from manifest.participants) so the label
 * feeds composeLayout's speaker↔camera matching with zero fuzzy guessing.
 */
export function windowsAt(log: GeometryLog, tWallMs: number, names: Record<string, string> = {}): DetectedWindow[] {
  const geom = new Map<string, { x: number; y: number; w: number; h: number; z: number }>();
  const visible = new Map<string, boolean>();
  for (const e of log.events) {
    if (e.ts > tWallMs) break; // events are sorted ascending
    if (
      typeof e.x === "number" &&
      typeof e.y === "number" &&
      typeof e.w === "number" &&
      typeof e.h === "number"
    ) {
      geom.set(e.id, { x: e.x, y: e.y, w: e.w, h: e.h, z: typeof e.z === "number" ? e.z : 0 });
    }
    if (e.shown) visible.set(e.id, true);
    if (e.removed) visible.set(e.id, false);
  }

  const rows: { win: DetectedWindow; z: number }[] = [];
  for (const [id, vis] of visible) {
    if (!vis) continue;
    const g = geom.get(id);
    if (!g) continue;
    const parsed = parseSlotId(id);
    if (!parsed) continue;
    // layout px → frame fraction (the one calibration; identity by default).
    const x = (g.x - OFFSET_X) / LAYOUT_W;
    const y = (g.y - OFFSET_Y) / LAYOUT_H;
    const w = g.w / LAYOUT_W;
    const h = g.h / LAYOUT_H;
    if (!(w > 0 && h > 0)) continue;
    if (x >= 1 || y >= 1 || x + w <= 0 || y + h <= 0) continue; // fully off-frame
    const label = names[parsed.ownerKey.toLowerCase()] ?? parsed.ownerKey;
    rows.push({ win: { kind: parsed.kind, label, x, y, w, h }, z: g.z });
  }
  rows.sort((a, b) => b.z - a.z);
  return rows.map(r => r.win);
}
