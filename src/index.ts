import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { selectCandidates, type RawCandidate } from "./candidates.js";
import { buildClips, resolveCandidates } from "./clips.js";
import { downloadFile } from "./download.js";
import { writeGallery } from "./gallery.js";
import { resolveBySlug, resolveByManifestCid, type ResolvedEpisode } from "./resolve.js";
import { transcribeVideo } from "./transcribe.js";

// CLI: clip an episode end-to-end.
//
//   yarn clip <slug>                 resolve via mainnet contract, then clip
//   yarn clip <slug> --manifest CID  skip the chain, use a manifest CID
//   yarn clip <slug> --limit 12      cap the number of clips rendered
//   yarn clip <slug> --target 25     target clip length in seconds (10-40)
//   yarn clip <slug> --force         ignore caches (re-download, re-transcribe)

type Args = {
  slug: string;
  manifest?: string;
  limit?: number;
  target?: number;
  force: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const out: Partial<Args> = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--target") out.target = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (!positional[0]) throw new Error("usage: yarn clip <slug> [--manifest CID] [--limit N] [--target SEC] [--force]");
  return { slug: positional[0], ...out, force: out.force ?? false };
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

  const resolvedCands = resolveCandidates(candidates, transcript);
  log(`  ${resolvedCands.length} anchored to real timestamps + in range`);

  log(`\n▸ cutting clips…`);
  const clips = await buildClips({
    source,
    transcript,
    resolved: resolvedCands,
    clipsDir: join(outDir, "clips"),
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
    clips,
  });

  log(`\n✓ ${clips.length} clips in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(`  open ${join(outDir, "index.html")}`);
}

main().catch(err => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
