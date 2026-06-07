import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { selectCandidates, type RawCandidate } from "./candidates.js";
import { buildClips, resolveCandidates } from "./clips.js";
import { downloadFile } from "./download.js";
import { writeGallery } from "./gallery.js";
import { applyVerdicts, clipKey, getVerdicts, type JudgeVerdict } from "./judge.js";
import { refineCaptions, type Captions } from "./refine.js";
import { resolveBySlug, resolveByManifestCid, type ResolvedEpisode } from "./resolve.js";
import { transcribeVideo } from "./transcribe.js";
import { probeSize } from "./ffmpeg.js";
import { alignToVideo, attributeWindow, fetchLiveTranscript, namesFromParticipants, type LiveLine } from "./speakers.js";
import { resolveClipLayout, type ClipLayout } from "./vertical.js";

// CLI: clip an episode end-to-end.
//
//   yarn clip <slug>                 resolve via mainnet contract, then clip
//   yarn clip <slug> --manifest CID  skip the chain, use a manifest CID
//   yarn clip <slug> --limit 12      cap the number of clips rendered
//   yarn clip <slug> --target 25     target clip length in seconds (10-40)
//   yarn clip <slug> --no-judge      skip the adversarial judge re-rank
//   yarn clip <slug> --no-refine     skip context-aware caption correction (raw STT)
//   yarn clip <slug> --no-burn       don't burn karaoke captions into the video
//   yarn clip <slug> --vertical      render 9:16 mobile clips (stacked speaker tiles)
//   yarn clip <slug> --force         ignore caches (re-download, re-transcribe)

type Args = {
  slug: string;
  manifest?: string;
  limit?: number;
  target?: number;
  judge: boolean;
  refine: boolean;
  burn: boolean;
  vertical: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const out: Partial<Args> = { force: false, judge: true, refine: true, burn: true, vertical: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--no-judge") out.judge = false;
    else if (a === "--no-refine") out.refine = false;
    else if (a === "--no-burn") out.burn = false;
    else if (a === "--vertical") out.vertical = true;
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--target") out.target = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (!positional[0])
    throw new Error(
      "usage: yarn clip <slug> [--manifest CID] [--limit N] [--target SEC] [--no-judge] [--no-refine] [--no-burn] [--vertical] [--force]",
    );
  return {
    slug: positional[0],
    ...out,
    judge: out.judge ?? true,
    refine: out.refine ?? true,
    burn: out.burn ?? true,
    vertical: out.vertical ?? false,
    force: out.force ?? false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => console.log(m);
  const t0 = Date.now();

  const outDir = resolve(process.cwd(), "out", args.slug);
  await mkdir(outDir, { recursive: true });

  log(`\n▸ resolving ${args.slug}…`);
  const ep: ResolvedEpisode = args.manifest
    ? await resolveByManifestCid(args.slug, args.manifest)
    : await resolveBySlug(args.slug);
  log(`  ${ep.name}`);
  log(`  manifest: ${ep.manifestCid}`);
  log(`  video:    ${ep.videoUrl}`);

  log(`\n▸ downloading video…`);
  const source = join(outDir, "source.mp4");
  const dl = await downloadFile(ep.videoUrl, source, args.force);
  log(`  ${dl.cached ? "cached" : "downloaded"} -> ${source}`);

  log(`\n▸ transcribing…`);
  const transcript = await transcribeVideo({
    videoFile: source,
    workDir: outDir,
    cachePath: join(outDir, "transcript.json"),
    force: args.force,
    log: m => log(`  ${m}`),
  });

  log(`\n▸ selecting clip candidates…`);
  // Cache the LLM's raw candidates so re-runs (tweaking padding, captions,
  // gallery) are free + deterministic. --force re-asks the model.
  const candPath = join(outDir, "candidates.json");
  let candidates: RawCandidate[] | null = null;
  if (!args.force) {
    try {
      candidates = JSON.parse(await readFile(candPath, "utf8")) as RawCandidate[];
      log(`  loaded ${candidates.length} cached candidates`);
    } catch {
      /* no cache */
    }
  }
  if (!candidates) {
    candidates = await selectCandidates({
      transcript,
      meta: ep.manifest.meta,
      targetSeconds: args.target,
    });
    await writeFile(candPath, JSON.stringify(candidates, null, 2));
    log(`  model proposed ${candidates.length} candidates`);
  }

  let resolvedCands = resolveCandidates(candidates, transcript);
  log(`  ${resolvedCands.length} anchored to real timestamps + in range`);

  if (args.judge && resolvedCands.length) {
    log(`\n▸ adversarial judge re-rank…`);
    // Cache verdicts keyed by clip content (judge.json) so re-runs are free.
    const judgePath = join(outDir, "judge.json");
    let verdicts: Record<string, JudgeVerdict> = {};
    if (!args.force) {
      try {
        verdicts = JSON.parse(await readFile(judgePath, "utf8")) as Record<string, JudgeVerdict>;
      } catch {
        /* no cache */
      }
    }
    const allCovered = resolvedCands.every(c => verdicts[clipKey(c)]);
    if (allCovered && Object.keys(verdicts).length) {
      log(`  loaded cached verdicts`);
    } else {
      verdicts = await getVerdicts(resolvedCands);
      await writeFile(judgePath, JSON.stringify(verdicts, null, 2));
    }
    resolvedCands = applyVerdicts(resolvedCands, verdicts);
    const cut = resolvedCands.filter(c => c.verdict === "cut").length;
    log(`  judged ${resolvedCands.length} clips · ${cut} flagged "cut" · re-ranked by blended score`);
  }

  // Speaker attribution: who's talking in each clip. whisper drops speakers, so
  // we recover them from slop's live transcript (handle/address per line),
  // aligned to the re-transcription, and tally the dominant speaker per clip
  // window. Best-effort + no AI — no live transcript or no alignment just leaves
  // speakers unset. Surfaced on every clip in the gallery + index.json.
  if (resolvedCands.length && ep.manifest.transcript?.cid) {
    log(`\n▸ attributing speakers…`);
    const names = namesFromParticipants(ep.manifest.participants);
    const live = await fetchLiveTranscript(ep.manifest.transcript.cid, names);
    const align = alignToVideo(live, transcript);
    if (align.offsetMs != null) {
      for (const c of resolvedCands) {
        const info = attributeWindow(live, align.offsetMs, c.start, c.end);
        if (info.primary) {
          c.speaker = info.primary;
          c.speakers = info.shares;
        }
      }
      const who = [...new Set(resolvedCands.map(c => c.speaker).filter(Boolean))].join(", ");
      log(`  aligned (offset ${(align.offsetMs / 1000).toFixed(1)}s · ${align.matches} matches) → ${who || "none"}`);
    } else {
      log(`  could not align live transcript — leaving speakers unset`);
    }
  }

  // Context-aware caption correction: recover crypto/AI jargon + proper nouns
  // the generic STT mangled, keeping word-level timing for the karaoke burn-in.
  // Cached (captions.json) keyed by clip content, like the judge verdicts.
  let captions: Captions = {};
  if (args.refine && resolvedCands.length) {
    log(`\n▸ correcting captions…`);
    const capPath = join(outDir, "captions.json");
    if (!args.force) {
      try {
        captions = JSON.parse(await readFile(capPath, "utf8")) as Captions;
      } catch {
        /* no cache */
      }
    }
    const allCovered = resolvedCands.every(c => captions[clipKey(c)]);
    if (allCovered && Object.keys(captions).length) {
      log(`  loaded cached captions`);
    } else {
      captions = await refineCaptions(resolvedCands, transcript, ep.manifest.meta, m => log(`  ${m}`));
      await writeFile(capPath, JSON.stringify(captions, null, 2));
    }
  }

  // 9:16 mobile composition: detect each clip's speaker tiles so we can stack
  // them. One vision call per clip (sampled frame) — so cache the result
  // (layout.json) keyed by clip content, like judge verdicts / captions.
  let layouts: Record<string, ClipLayout> = {};
  if (args.vertical && resolvedCands.length) {
    log(`\n▸ detecting speaker tiles (9:16 mobile)…`);
    const layoutPath = join(outDir, "layout.json");
    if (!args.force) {
      try {
        layouts = JSON.parse(await readFile(layoutPath, "utf8")) as Record<string, ClipLayout>;
      } catch {
        /* no cache */
      }
    }
    const allCovered = resolvedCands.every(c => layouts[clipKey(c)]);
    if (allCovered && Object.keys(layouts).length) {
      log(`  loaded cached layouts`);
    } else {
      const size = await probeSize(source);
      const framesDir = join(outDir, "frames");
      await mkdir(framesDir, { recursive: true });

      // Recover WHO is talking when, so we can match speakers to detected tiles.
      // (No live transcript, or no alignment → blur-pad fallback for every clip.)
      let live: LiveLine[] = [];
      let offsetMs: number | null = null;
      const tcid = ep.manifest.transcript?.cid;
      if (tcid) {
        const names = namesFromParticipants(ep.manifest.participants);
        live = await fetchLiveTranscript(tcid, names);
        const align = alignToVideo(live, transcript);
        offsetMs = align.offsetMs;
        log(
          offsetMs == null
            ? `  could not align live transcript — falling back to blur-pad`
            : `  aligned live transcript: offset ${(offsetMs / 1000).toFixed(1)}s · ${align.matches} matches`,
        );
      } else {
        log(`  manifest has no live transcript — falling back to blur-pad`);
      }

      layouts = {};
      for (const c of resolvedCands) {
        const key = clipKey(c);
        layouts[key] = await resolveClipLayout({
          source,
          srcW: size.width,
          srcH: size.height,
          framePath: join(framesDir, `${key}.png`),
          startSec: c.start,
          endSec: c.end,
          live,
          offsetMs,
          log: m => log(`  ${c.title.slice(0, 36)} — ${m}`),
        });
      }
      await writeFile(layoutPath, JSON.stringify(layouts, null, 2));
    }
  }

  log(`\n▸ cutting clips…`);
  const clips = await buildClips({
    source,
    transcript,
    resolved: resolvedCands,
    clipsDir: join(outDir, "clips"),
    captions,
    burn: args.burn,
    vertical: args.vertical,
    layouts,
    limit: args.limit,
    log: m => log(`  ${m}`),
  });

  const generatedAt = new Date(t0).toISOString();
  await writeGallery({
    outDir,
    slug: args.slug,
    name: ep.name,
    manifestCid: ep.manifestCid,
    generatedAt,
    vertical: args.vertical,
    clips,
  });

  log(`\n✓ ${clips.length} clips in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(`  open ${join(outDir, "index.html")}`);
}

main().catch(err => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
