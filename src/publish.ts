import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import type { Clip } from "./clips.js";
import { pinFile, pinJson } from "./ipfs.js";
import type { EpisodeManifest, ResolvedEpisode } from "./resolve.js";

// Publish a clipped episode's 9:16 clips to IPFS and produce an updated manifest:
//   1. pin each .mobile.mp4 (+ a poster jpg + .srt) to IPFS (bgipfs),
//   2. build & pin clips.json (timings + speakers + tweet copy + per-clip CIDs),
//   3. fold a `clips` field into the episode manifest and pin the new manifest.
// Returns the new manifest CID — the operator then signs setManifest with it
// (see docs/clips-publishing-plan.md). Mirrors how the relay pins
// video/transcript/chat/card, so clips live on the same node.

export type ClipBundleEntry = {
  rank: number;
  title: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  speakers: string[];
  mobile: { cid: string; w: number; h: number; format: string; sizeBytes: number };
  poster?: { cid: string; format: string };
  captions?: { cid: string; format: string };
  tweetShort?: string;
  tweetLong?: string;
};

export type ClipsBundle = {
  v: 1;
  slug: string;
  generatedAt: string;
  clips: ClipBundleEntry[];
};

const exists = (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false);

/** Grab a representative frame from a clip as a small JPG, for <video poster>. */
async function makePoster(mp4: string, dest: string): Promise<boolean> {
  try {
    await new Promise<void>((res, rej) => {
      const ff = spawn(config.ffmpegBin, ["-y", "-ss", "1.5", "-i", mp4, "-frames:v", "1", "-q:v", "3", "-loglevel", "error", dest]);
      ff.on("error", rej);
      ff.on("close", c => (c === 0 ? res() : rej(new Error(`ffmpeg poster exited ${c}`))));
    });
    return await exists(dest);
  } catch {
    return false;
  }
}

export async function publishClips(opts: {
  ep: ResolvedEpisode;
  clips: Clip[];
  clipsDir: string;
  apiUrl: string;
  posters?: boolean;
  onProgress?: (e: { phase: "pinning-clip"; i: number; n: number; title: string } | { phase: "pinning-bundle" } | { phase: "updating-manifest" }) => void;
  log?: (m: string) => void;
}): Promise<{ clipsCid: string; manifestCid: string; bundle: ClipsBundle }> {
  const log = opts.log ?? (() => {});
  const withMobile = opts.clips.filter(c => c.mobileFile);
  if (!withMobile.length) throw new Error("no mobile (9:16) clips to publish — run with --vertical first");

  const W = 1080;
  const H = 1920;
  const entries: ClipBundleEntry[] = [];
  for (let i = 0; i < withMobile.length; i++) {
    const c = withMobile[i]!;
    opts.onProgress?.({ phase: "pinning-clip", i, n: withMobile.length, title: c.title });
    const mp4Path = join(opts.clipsDir, c.mobileFile!);
    const mobile = await pinFile(opts.apiUrl, mp4Path);
    log(`  [${i + 1}/${withMobile.length}] pinned ${c.mobileFile} → ${mobile.cid}`);

    let poster: ClipBundleEntry["poster"];
    if (opts.posters !== false) {
      const posterPath = `${mp4Path}.poster.jpg`;
      if (await makePoster(mp4Path, posterPath)) {
        const p = await pinFile(opts.apiUrl, posterPath);
        poster = { cid: `ipfs://${p.cid}`, format: "image/jpeg" };
        await rm(posterPath, { force: true });
      }
    }

    let captions: ClipBundleEntry["captions"];
    if (c.srt && (await exists(join(opts.clipsDir, c.srt)))) {
      const s = await pinFile(opts.apiUrl, join(opts.clipsDir, c.srt));
      captions = { cid: `ipfs://${s.cid}`, format: "application/x-subrip" };
    }

    entries.push({
      rank: c.rank,
      title: c.title,
      startSec: c.start,
      endSec: c.end,
      durationSec: Math.round((c.end - c.start) * 100) / 100,
      speakers: (c.speakers ?? []).map(s => s.speaker),
      mobile: { cid: `ipfs://${mobile.cid}`, w: W, h: H, format: "video/mp4", sizeBytes: mobile.size },
      poster,
      captions,
      tweetShort: c.tweetShort,
      tweetLong: c.tweetLong,
    });
  }

  const bundle: ClipsBundle = {
    v: 1,
    slug: opts.ep.slug,
    generatedAt: new Date().toISOString(),
    clips: entries.sort((a, b) => a.rank - b.rank),
  };

  opts.onProgress?.({ phase: "pinning-bundle" });
  const clipsCid = await pinJson(opts.apiUrl, bundle, "clips.json");
  log(`  clips.json → ${clipsCid}`);

  opts.onProgress?.({ phase: "updating-manifest" });
  const newManifest: EpisodeManifest = {
    ...opts.ep.manifest,
    clips: { cid: `ipfs://${clipsCid}`, count: entries.length, format: "application/json" },
  };
  const manifestCid = await pinJson(opts.apiUrl, newManifest, "manifest.json");
  log(`  manifest (with clips) → ${manifestCid}`);

  return { clipsCid, manifestCid, bundle };
}
