import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { selectCandidates, type RawCandidate } from "./candidates.js";
import { buildClips, resolveCandidates } from "./clips.js";
import { downloadFile } from "./download.js";
import { writeGallery } from "./gallery.js";
import { applyVerdicts, clipKey, getVerdicts, type JudgeVerdict } from "./judge.js";
import { refineCaptions, type Captions } from "./refine.js";
import { applyTweets, generateTweets, type Tweets } from "./tweets.js";
import { resolveBySlug, resolveByManifestCid, type ResolvedEpisode } from "./resolve.js";
import { transcribeVideo } from "./transcribe.js";
import { probeSize } from "./ffmpeg.js";
import {
  alignToVideo,
  attributeWindow,
  fetchLiveTranscript,
  namesFromParticipants,
  speakerSpans,
  type LiveLine,
} from "./speakers.js";
import { composeLayout, detectClipWindows, type ClipLayout, type DetectedWindow } from "./vertical.js";
import { renderMobileBackground } from "./desktop-bg.js";
import { publishClips } from "./publish.js";
import { config } from "./config.js";

// CLI: clip an episode end-to-end.
//
//   yarn clip <slug>                 resolve via mainnet contract, then clip
//   yarn clip <slug> --manifest CID  skip the chain, use a manifest CID
//   yarn clip <slug> --limit 12      cap the number of clips rendered
//   yarn clip <slug> --target 25     target clip length in seconds (10-40)
//   yarn clip <slug> --no-judge      skip the adversarial judge re-rank
//   yarn clip <slug> --no-refine     skip context-aware caption correction (raw STT)
//   yarn clip <slug> --no-burn       don't burn karaoke captions into the video
//   yarn clip <slug> --no-tweets     skip generating suggested post copy per clip
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
  tweets: boolean;
  vertical: boolean;
  publish: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const out: Partial<Args> = { force: false, judge: true, refine: true, burn: true, tweets: true, vertical: false, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--no-judge") out.judge = false;
    else if (a === "--no-refine") out.refine = false;
    else if (a === "--no-burn") out.burn = false;
    else if (a === "--no-tweets") out.tweets = false;
    else if (a === "--vertical") out.vertical = true;
    else if (a === "--publish") ((out.publish = true), (out.vertical = true)); // publish pins the 9:16 clips → implies --vertical
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--target") out.target = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (!positional[0])
    throw new Error(
      "usage: yarn clip <slug> [--manifest CID] [--limit N] [--target SEC] [--no-judge] [--no-refine] [--no-burn] [--no-tweets] [--vertical] [--publish] [--force]",
    );
  return {
    slug: positional[0],
    ...out,
    judge: out.judge ?? true,
    refine: out.refine ?? true,
    burn: out.burn ?? true,
    tweets: out.tweets ?? true,
    vertical: out.vertical ?? false,
    publish: out.publish ?? false,
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
          // Time-resolved spans so the burned nameplate tracks who's talking.
          c.speakerSpans = speakerSpans(live, align.offsetMs, c.start, c.end);
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

  // Suggested post copy (short + long tweet) per clip, ready to ship with the
  // video. Uses the corrected caption text + the judge's critique (so the copy
  // supplies the hook the clip lacks cold). Cached (tweets.json) by clip content.
  if (args.tweets && resolvedCands.length) {
    log(`\n▸ drafting post copy…`);
    const tweetPath = join(outDir, "tweets.json");
    let tweets: Tweets = {};
    if (!args.force) {
      try {
        tweets = JSON.parse(await readFile(tweetPath, "utf8")) as Tweets;
      } catch {
        /* no cache */
      }
    }
    const allCovered = resolvedCands.every(c => tweets[clipKey(c)]);
    if (allCovered && Object.keys(tweets).length) {
      log(`  loaded cached copy`);
    } else {
      tweets = await generateTweets(resolvedCands, captions, ep.manifest.meta, m => log(`  ${m}`));
      await writeFile(tweetPath, JSON.stringify(tweets, null, 2));
    }
    resolvedCands = applyTweets(resolvedCands, tweets);
  }

  // 9:16 mobile composition. The recording is a desktop of titled windows
  // ("CAMERA — <name>", "SCREEN — <name>", apps); one vision call per clip reads
  // those title bars into window boxes (cached in windows.json — detection is the
  // expensive part). The layout is then COMPOSED from the cached windows + the
  // clip's attributed speakers on every run (a pure function — free to retune).
  let layouts: Record<string, ClipLayout> = {};
  if (args.vertical && resolvedCands.length) {
    log(`\n▸ detecting windows (9:16 mobile)…`);
    const windowsPath = join(outDir, "windows.json");
    let windows: Record<string, DetectedWindow[]> = {};
    if (!args.force) {
      try {
        windows = JSON.parse(await readFile(windowsPath, "utf8")) as Record<string, DetectedWindow[]>;
      } catch {
        /* no cache */
      }
    }
    const size = await probeSize(source);
    const missing = resolvedCands.filter(c => !windows[clipKey(c)]);
    if (!missing.length) {
      log(`  loaded cached windows`);
    } else {
      const framesDir = join(outDir, "frames");
      await mkdir(framesDir, { recursive: true });
      for (const c of missing) {
        const key = clipKey(c);
        windows[key] = await detectClipWindows({
          source,
          framePath: join(framesDir, `${key}.png`),
          startSec: c.start,
          endSec: c.end,
          log: m => log(`  ${c.title.slice(0, 36)} — ${m}`),
        });
      }
      await writeFile(windowsPath, JSON.stringify(windows, null, 2));
    }
    // Compose each clip's layout from its windows + attributed speakers.
    for (const c of resolvedCands) {
      const key = clipKey(c);
      const speakers = (c.speakers ?? []).slice(0, 2).map(s => s.speaker);
      const layout = composeLayout(windows[key] ?? [], speakers, size.width, size.height);
      layouts[key] = layout;
      log(`  ${c.title.slice(0, 36)} — ${layout.kind}${layout.speakers.length ? ` (${layout.speakers.join(" / ")})` : ""}`);
    }
  }

  // Mobile (--vertical): render the slop-desktop background once (cached), to sit
  // behind the stacked tiles. Null on failure → clips still cut, just full-frame.
  let mobileBg: string | undefined;
  if (args.vertical) {
    log(`\n▸ rendering mobile desktop background…`);
    const bg = await renderMobileBackground(join(outDir, "mobile-bg.png"), { force: args.force, log: m => log(`  ${m}`) });
    mobileBg = bg ?? undefined;
    log(`  ${bg ? "✓ " + bg : "skipped — clips will be full-frame stacks"}`);
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
    mobileBg,
    limit: args.limit,
    log: m => log(`  ${m}`),
  });

  // Publish (--publish): pin the 9:16 clips + tweet copy to IPFS and produce an
  // updated manifest CID. The operator then signs setManifest with it. This is
  // the dev/back-catalog path; the server runs the same publishClips() on a
  // /admin button (see docs/clips-publishing-plan.md).
  if (args.publish) {
    if (!config.ipfsApiUrl)
      throw new Error("--publish needs IPFS_API_URL set (bgipfs /api/v0/add, e.g. http://127.0.0.1:5001 — the same node the relay pins to)");
    log(`\n▸ publishing clips to IPFS…`);
    const { clipsCid, manifestCid } = await publishClips({
      ep,
      clips,
      clipsDir: join(outDir, "clips"),
      apiUrl: config.ipfsApiUrl,
      posters: true,
      log: m => log(m),
    });
    log(`\n✓ clips bundle:      ipfs://${clipsCid}`);
    log(`✓ updated manifest:  ipfs://${manifestCid}`);
    log(`  → slop.computer/admin → paste this manifest CID → Save Manifest (your wallet signs setManifest)`);
  }

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
