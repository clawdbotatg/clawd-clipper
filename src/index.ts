import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { selectCandidates, type RawCandidate } from "./candidates.js";
import { buildClips, resolveCandidates, resolveManualClip, type ResolvedClip, type StitchDiag } from "./clips.js";
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
  labelSegments,
  namesFromParticipants,
  speakerSpans,
  type LiveLine,
} from "./speakers.js";
import { chatReactions, fetchChat } from "./chat.js";
import { composeLayout, detectClipWindows, labelsMatch, layoutsSimilar, type ClipLayout, type ComposeOpts, type DetectedWindow } from "./vertical.js";
import { directWindows, type Director } from "./director.js";
import { fetchGeometryLog, logHasGodGeometry, windowsAt, type GeometryLog } from "./geometry.js";
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
//   yarn clip <slug> --stitch        allow stitched (multi-span) clips — splice out a dead interjection
//   yarn clip <slug> --force         ignore caches (re-download, re-transcribe)
//
//   yarn clip <slug> --clip-at 7:18-8:05 [--clip-title "..."] [--clip-exact]
//                                    render ONE operator-chosen window instead of mining the
//                                    episode: skips the LLM picker / judge / tweets, runs the
//                                    same speakers + captions + 9:16 reframe, writes nothing to
//                                    the manifest. Implies --vertical. --clip-exact honours the
//                                    given times to the frame (default snaps edges to a sentence beat).

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
  stitch: boolean;
  force: boolean;
  // --clip-at: render ONE operator-chosen window instead of mining the episode.
  // Skips the LLM picker + judge + tweets; everything else (speakers, captions,
  // 9:16 reframe) runs as normal. clipTitle names the file; clipSnap=false
  // (--clip-exact) honours the given times to the frame instead of snapping.
  clipAt?: { start: number; end: number };
  clipTitle?: string;
  clipSnap: boolean;
};

// Parse a clip timestamp: "M:SS", "H:MM:SS", or bare seconds ("438", "438.5").
function parseClockTime(s: string): number {
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p)))
    throw new Error(`bad time "${s}" — use M:SS, H:MM:SS, or seconds`);
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const out: Partial<Args> = { force: false, judge: true, refine: true, burn: true, tweets: true, vertical: false, publish: false, stitch: false, clipSnap: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--no-judge") out.judge = false;
    else if (a === "--no-refine") out.refine = false;
    else if (a === "--no-burn") out.burn = false;
    else if (a === "--no-tweets") out.tweets = false;
    else if (a === "--vertical") out.vertical = true;
    else if (a === "--publish") ((out.publish = true), (out.vertical = true)); // publish pins the 9:16 clips → implies --vertical
    else if (a === "--stitch") out.stitch = true; // allow stitched (multi-span) clips
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--target") out.target = Number(argv[++i]);
    else if (a === "--clip-at") {
      // ONE custom clip from an explicit window: "M:SS-M:SS" (or seconds-seconds).
      const spec = argv[++i] ?? "";
      const m = spec.match(/^(.+?)\s*-\s*(.+)$/);
      if (!m) throw new Error(`--clip-at wants START-END (e.g. 7:18-8:05), got "${spec}"`);
      out.clipAt = { start: parseClockTime(m[1]!), end: parseClockTime(m[2]!) };
    } else if (a === "--clip-title") out.clipTitle = argv[++i];
    else if (a === "--clip-exact") out.clipSnap = false; // honour times to the frame (no sentence-beat snap)
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (!positional[0])
    throw new Error(
      "usage: yarn clip <slug> [--manifest CID] [--limit N] [--target SEC] [--no-judge] [--no-refine] [--no-burn] [--no-tweets] [--vertical] [--publish] [--stitch] [--force]\n" +
        "       yarn clip <slug> --clip-at 7:18-8:05 [--clip-title \"...\"] [--clip-exact]   # render ONE custom clip from an explicit window",
    );
  // A custom clip is a 9:16 reframe by definition (geometry + speaker tile is the
  // whole point), so --clip-at implies --vertical.
  if (out.clipAt) out.vertical = true;
  return {
    slug: positional[0],
    ...out,
    judge: out.judge ?? true,
    refine: out.refine ?? true,
    burn: out.burn ?? true,
    tweets: out.tweets ?? true,
    vertical: out.vertical ?? false,
    publish: out.publish ?? false,
    stitch: out.stitch ?? false,
    force: out.force ?? false,
    clipSnap: out.clipSnap ?? true,
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

  // Speaker + chat signal for the selector — recovered up front so the candidate
  // model can read "who said what" and see where the live chat lit up (the two
  // biggest signals it was previously blind to). The live transcript carries a
  // handle per line on a wall clock; alignToVideo recovers the constant offset to
  // the whisper (video) clock. We keep `liveLines` + `alignOffsetMs` and reuse
  // them for per-clip speaker attribution + the geometry-log layout below. The
  // research dossier (correctly-spelled proper nouns) is passed in by the relay
  // via CLIPPER_RESEARCH when it spawns us; absent on standalone runs.
  const research = process.env.CLIPPER_RESEARCH?.trim() || undefined;
  let alignOffsetMs: number | null = null;
  let liveLines: LiveLine[] = [];
  if (ep.manifest.transcript?.cid) {
    try {
      const names = namesFromParticipants(ep.manifest.participants);
      liveLines = await fetchLiveTranscript(ep.manifest.transcript.cid, names);
      const align = alignToVideo(liveLines, transcript);
      alignOffsetMs = align.offsetMs;
      if (alignOffsetMs != null) log(`  aligned live transcript (offset ${(alignOffsetMs / 1000).toFixed(1)}s · ${align.matches} matches)`);
      else log(`  could not align live transcript — speakers/chat signal unavailable to selector`);
    } catch (err) {
      log(`  live transcript unavailable (${err instanceof Error ? err.message : err})`);
    }
  }
  const speakerLabels = liveLines.length && alignOffsetMs != null ? labelSegments(transcript.segments, liveLines, alignOffsetMs) : undefined;
  let chatBlock: string | undefined;
  if (alignOffsetMs != null && ep.manifest.chat?.cid) {
    try {
      const chat = await fetchChat(ep.manifest.chat.cid);
      chatBlock = chatReactions(chat, alignOffsetMs, transcript.duration);
      if (chatBlock) log(`  chat reactions: ${chatBlock.split("\n").length} spike windows fed to selector`);
    } catch (err) {
      log(`  chat unavailable (${err instanceof Error ? err.message : err})`);
    }
  }

  let resolvedCands: ResolvedClip[];
  if (args.clipAt) {
    // ── Custom clip (--clip-at) ──────────────────────────────────────────────
    // Skip the LLM picker, stitch and judge entirely: the operator watched the
    // episode and chose this exact window. We build a single clip from it and
    // let the rest of the pipeline (speakers, captions, 9:16 reframe) run on it
    // unchanged. Nothing is published or folded into the manifest.
    const { start, end } = args.clipAt;
    const clip = resolveManualClip(transcript, { start, end, title: args.clipTitle }, { snap: args.clipSnap });
    resolvedCands = [clip];
    const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
    log(`\n▸ custom clip: ${fmt(clip.start)}–${fmt(clip.end)} (${clip.duration}s${args.clipSnap ? ", snapped to sentence beats" : ", exact times"}) — "${clip.title}"`);
  } else {
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
        context: { speakerLabels, chatReactions: chatBlock, research, stitch: args.stitch },
      });
      await writeFile(candPath, JSON.stringify(candidates, null, 2));
      log(`  model proposed ${candidates.length} candidates`);
    }

    // Stitch decisions are logged AND persisted to out/<slug>/stitches.json so a
    // later inspection can see exactly what the model tried, what got spliced
    // (which spans, how much dead air was cut), and why any attempt was dropped.
    const stitchDiags: StitchDiag[] = [];
    resolvedCands = resolveCandidates(candidates, transcript, {
      stitch: args.stitch,
      onStitch: d => {
        stitchDiags.push(d);
        if (d.resolved) {
          const cut = (d.cutSec ?? []).reduce((a, b) => a + b, 0);
          log(`  stitch ✓ "${d.title}" — ${d.segments!.length} spans, kept ${d.durationSec}s, cut ${cut.toFixed(1)}s of dead air`);
        } else {
          log(`  stitch ✗ "${d.title}" — dropped: ${d.reason}`);
        }
      },
    });
    const stitched = resolvedCands.filter(c => c.segments?.length).length;
    log(
      `  ${resolvedCands.length} anchored to real timestamps + in range` +
        (args.stitch ? ` · stitches: ${stitched} kept, ${stitchDiags.length - stitched} dropped (see out/${args.slug}/stitches.json)` : ""),
    );
    if (args.stitch) await writeFile(join(outDir, "stitches.json"), JSON.stringify(stitchDiags, null, 2));
  }

  if (args.judge && !args.clipAt && resolvedCands.length) {
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

  // Per-clip speaker attribution: who's talking in each clip window. Reuses the
  // live transcript + video↔wall-clock offset already recovered above (whisper
  // drops speakers; the live transcript carries them). Best-effort — no alignment
  // just leaves speakers unset. Surfaced on every clip in the gallery + index.json
  // and drives the 9:16 layout's top tile + burned nameplate below.
  if (resolvedCands.length && liveLines.length && alignOffsetMs != null) {
    log(`\n▸ attributing speakers…`);
    for (const c of resolvedCands) {
      const info = attributeWindow(liveLines, alignOffsetMs, c.start, c.end);
      if (info.primary) {
        c.speaker = info.primary;
        c.speakers = info.shares;
        // Time-resolved spans so the burned nameplate tracks who's talking.
        c.speakerSpans = speakerSpans(liveLines, alignOffsetMs, c.start, c.end);
      }
    }
    const who = [...new Set(resolvedCands.map(c => c.speaker).filter(Boolean))].join(", ");
    log(`  attributed → ${who || "none"}`);
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
      // Stitched clips re-base their captions from per-span raw words in
      // buildClips (the contiguous-window refine pass can't represent a splice),
      // so only the single-span clips go through correction here.
      captions = await refineCaptions(resolvedCands.filter(c => !c.segments?.length), transcript, ep.manifest.meta, m => log(`  ${m}`), research);
      await writeFile(capPath, JSON.stringify(captions, null, 2));
    }
  }

  // Suggested post copy (short + long tweet) per clip, ready to ship with the
  // video. Uses the corrected caption text + the judge's critique (so the copy
  // supplies the hook the clip lacks cold). Cached (tweets.json) by clip content.
  if (args.tweets && !args.clipAt && resolvedCands.length) {
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
  let altLayouts: Record<string, ClipLayout> = {};
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
    // Geometry log (manifest.geometry): the relay's record of every window's
    // exact rect over the session — the deterministic alternative to the per-clip
    // vision/pixel detector. Fetch + decide ONCE here; reused by both the
    // detection loop below and the ALT take further down. Two bases (see
    // geometry.ts for the full note):
    //   • GOD-FRAME (current upstream): rects are the windows' ACTUAL rendered
    //     boxes in the OBS-capture browser + that browser's viewport, so they map
    //     to the recorded frame with no calibration guess. Used AUTOMATICALLY (no
    //     flag) — and the per-clip vision pass is skipped.
    //   • LEGACY slot coords (older eps): a *different* composition from what OBS
    //     recorded — a single affine can't reconcile two cameras — so this basis
    //     stays behind CLIPPER_USE_GEOMETRY (default off → the pixel detector,
    //     which reads the actual recorded frame).
    // CV remains the per-clip fallback for anything geometry can't cover.
    const envGeometry = /^(1|true|yes)$/i.test(process.env.CLIPPER_USE_GEOMETRY ?? "");
    let geomLog: GeometryLog | null = null;
    if (ep.manifest.geometry?.cid) {
      try {
        const fetched = await fetchGeometryLog(ep.manifest.geometry.cid);
        if (logHasGodGeometry(fetched)) {
          geomLog = fetched;
          log(`  geometry log: ${fetched.events.length} events — god-frame rects (exact recorded geometry); using it, skipping vision`);
        } else if (envGeometry) {
          geomLog = fetched;
          log(`  geometry log: ${fetched.events.length} events — legacy slot coords via CLIPPER_USE_GEOMETRY (fitted affine)`);
        } else {
          log(`  geometry log present but legacy slot coords (≠ recorded composition); using pixel detector. CLIPPER_USE_GEOMETRY=1 to force.`);
        }
      } catch (err) {
        log(`  geometry log fetch failed, using pixels (${err instanceof Error ? err.message : err})`);
      }
    }
    const geomOffsetMs = alignOffsetMs ?? geomLog?.videoStartMs ?? null;
    const geomNames = namesFromParticipants(ep.manifest.participants);

    const missing = resolvedCands.filter(c => !windows[clipKey(c)]);
    if (!missing.length) {
      log(`  loaded cached windows`);
    } else {
      // Geometry-log fast path: replay the log to each clip's mid-frame — no
      // vision/pixel pass. Time anchor is the transcript offset (geometry shares
      // its wall clock), falling back to the log header's videoStartMs.
      const framesDir = join(outDir, "frames");
      await mkdir(framesDir, { recursive: true });
      for (const c of missing) {
        const key = clipKey(c);
        // For a stitched clip the envelope midpoint falls in the DROPPED gap, so
        // detect windows inside the first real span instead. (Window layout is
        // ~static per episode; this just guarantees a representative frame.)
        const det = c.segments?.length ? c.segments[0]! : { start: c.start, end: c.end };
        let wins: DetectedWindow[] = [];
        if (geomLog && geomOffsetMs != null) {
          const midMs = ((det.start + det.end) / 2) * 1000 + geomOffsetMs;
          wins = windowsAt(geomLog, midMs, geomNames);
          if (wins.length) log(`  ${c.title.slice(0, 36)} — ${wins.length} windows from geometry log`);
        }
        if (!wins.length) {
          wins = await detectClipWindows({
            source,
            framePath: join(framesDir, `${key}.png`),
            startSec: det.start,
            endSec: det.end,
            participants: [...new Set(Object.values(geomNames))],
            log: m => log(`  ${c.title.slice(0, 36)} — ${m}`),
          });
        }
        windows[key] = wins;
      }
      await writeFile(windowsPath, JSON.stringify(windows, null, 2));
    }
    // An "anonymous" identity — a relay anonId or a shortened address. Never a
    // real handle, so never useful for matching a speaker to a name card.
    const anonish = (s: string) => /^anon\d*$/i.test(s) || /^0x[0-9a-f]{4}…/i.test(s);

    // ── Cross-clip camera label propagation ──────────────────────────────────
    // The same camera window sits at the same desktop position all episode, but
    // vision labels it per-clip — and per-clip it sometimes whiffs (no label) or
    // reads a stale name card (shafu0x: the card said "anon6946" for a stretch
    // before resolving to the ENS). Cluster cameras across clips by position and
    // give empty/anon labels the cluster's majority label, so one good read
    // covers the whole episode. Pure computation on the (raw) cached windows —
    // re-derived every run, never written back to windows.json.
    {
      type Cluster = { cx: number; cy: number; votes: Map<string, number>; members: DetectedWindow[] };
      const clusters: Cluster[] = [];
      for (const wins of Object.values(windows)) {
        for (const w of wins) {
          if (w.kind !== "camera") continue;
          const cx = w.x + w.w / 2;
          const cy = w.y + w.h / 2;
          let cl = clusters.find(c => Math.hypot(c.cx - cx, c.cy - cy) < 0.04);
          if (!cl) {
            cl = { cx, cy, votes: new Map(), members: [] };
            clusters.push(cl);
          }
          cl.members.push(w);
          if (w.label && !anonish(w.label)) cl.votes.set(w.label, (cl.votes.get(w.label) ?? 0) + 1);
        }
      }
      let filled = 0;
      for (const cl of clusters) {
        const top = [...cl.votes.entries()].sort((a, b) => b[1] - a[1])[0];
        // Trust the majority; trust a single read only when uncontested (a lone
        // read may be wrong, but conflicting reads definitely include one).
        if (!top || (top[1] < 2 && cl.votes.size > 1)) continue;
        for (const w of cl.members) {
          if (w.label && !anonish(w.label)) continue;
          w.label = top[0];
          filled++;
        }
      }
      if (filled) log(`  propagated camera labels to ${filled} unlabeled/anon windows (by position)`);
    }

    // ── Anon speaker aliasing ─────────────────────────────────────────────────
    // A guest whose live-transcript lines carry no handle/address attributes as
    // "Anon####" — a name that can never match their camera's name card, so the
    // composer doesn't know which camera is the speaker and the burned nameplate
    // reads ANON#### (the shafu0x failure). Recover by elimination: if exactly
    // ONE anon speaker exists and exactly one camera label is left unclaimed by
    // the named speakers (with clear frequency dominance), they're the same
    // person — rewrite the speaker fields. Conservative: any ambiguity → skip.
    {
      const named = new Set(liveLines.map(l => l.speaker).filter(s => !anonish(s)));
      const camLabels = new Map<string, { label: string; n: number }>();
      for (const wins of Object.values(windows))
        for (const w of wins) {
          if (w.kind !== "camera" || !w.label || anonish(w.label)) continue;
          const k = w.label.toLowerCase().replace(/[^a-z0-9]/g, "");
          const e = camLabels.get(k);
          if (e) e.n++;
          else camLabels.set(k, { label: w.label, n: 1 });
        }
      const unclaimed = [...camLabels.values()]
        .filter(c => ![...named].some(s => labelsMatch(c.label, s)))
        .sort((a, b) => b.n - a.n);
      const anons = [...new Set(resolvedCands.flatMap(c => (c.speakers ?? []).map(s => s.speaker)).filter(anonish))];
      if (anons.length === 1 && unclaimed.length && unclaimed[0]!.n >= 2 && (unclaimed.length === 1 || unclaimed[0]!.n >= 2 * unclaimed[1]!.n)) {
        const from = anons[0]!;
        const to = unclaimed[0]!.label;
        for (const c of resolvedCands) {
          if (c.speaker === from) c.speaker = to;
          for (const s of c.speakers ?? []) if (s.speaker === from) s.speaker = to;
          for (const s of c.speakerSpans ?? []) if (s.speaker === from) s.speaker = to;
        }
        log(`  aliased anon speaker ${from} → ${to} (the one camera no named speaker claims)`);
      } else if (anons.length) {
        log(`  anon speaker(s) ${anons.join(", ")} left unaliased (${unclaimed.length} unclaimed cams — ambiguous)`);
      }
    }

    // ── Director pass — what is each clip ABOUT? ──────────────────────────────
    // One batched LLM call (cached, like judge/refine/tweets): per clip, rank
    // the detected windows the conversation actually references (a demo being
    // narrated, the chess game under discussion, …) — or rule "pure
    // conversation" so the composer prefers cameras over an incidental screen
    // share. Best-effort: a failed/missing ruling leaves that clip on the old
    // first-screen heuristic.
    log(`\n▸ directing 9:16 content…`);
    const directorPath = join(outDir, "director.json");
    let director: Director = {};
    if (!args.force) {
      try {
        director = JSON.parse(await readFile(directorPath, "utf8")) as Director;
      } catch {
        /* no cache */
      }
    }
    const directorCovered = resolvedCands.every(c => director[clipKey(c)] !== undefined);
    if (directorCovered && Object.keys(director).length) {
      log(`  loaded cached picks`);
    } else {
      director = await directWindows(resolvedCands, windows, ep.manifest.meta, m => log(`  ${m}`));
      await writeFile(directorPath, JSON.stringify(director, null, 2));
    }

    // Per-clip compose options: the director's relevance ranking + the dominant
    // speaker's share (composeLayout's SURE gate for the speaker-pinned ALT).
    const composeOpts = (c: (typeof resolvedCands)[number]): ComposeOpts => ({
      feature: director[clipKey(c)],
      primaryPct: c.speakers?.[0]?.pct,
    });

    // Compose each clip's layout from its windows + attributed speakers.
    for (const c of resolvedCands) {
      const key = clipKey(c);
      const speakers = (c.speakers ?? []).slice(0, 2).map(s => s.speaker);
      const layout = composeLayout(windows[key] ?? [], speakers, size.width, size.height, composeOpts(c));
      layouts[key] = layout;
      const picks = director[key];
      log(`  ${c.title.slice(0, 36)} — ${layout.kind}${layout.speakers.length ? ` (${layout.speakers.join(" / ")})` : ""}${picks?.length ? ` · about: ${picks.join(", ")}` : ""}`);
    }

    // ── ALT 9:16 layouts — a second, deliberately-different take ──────────────
    // Composed from the SAME windows via composeLayout({alt:true}): when speaker
    // attribution is SURE (≥70% share + camera matched) the speaker keeps the
    // top tile and only the bottom window changes; otherwise the take swaps
    // speakers / goes screen-full to hedge a wrong default. Reuses the geometry
    // log + offset already decided above (god-frame automatically, or legacy slot
    // coords only under CLIPPER_USE_GEOMETRY) — when usable it gives the ALT a
    // genuinely different, geometry-true composition. Doubles the vertical render
    // (opt-in downstream as the admin "ALT 9:16" button).
    let altGeomCount = 0;
    let altMixedCount = 0;
    for (const c of resolvedCands) {
      const key = clipKey(c);
      const speakers = (c.speakers ?? []).slice(0, 2).map(s => s.speaker);
      // For a stitch, the envelope midpoint lands in the dropped gap — sample the
      // first real span instead (mirrors the primary detection above).
      const altDet = c.segments?.length ? c.segments[0]! : { start: c.start, end: c.end };
      const geomWins = geomLog && geomOffsetMs != null ? windowsAt(geomLog, ((altDet.start + altDet.end) / 2) * 1000 + geomOffsetMs, geomNames) : [];
      let alt = geomWins.length ? composeLayout(geomWins, speakers, size.width, size.height, composeOpts(c)) : null;
      const def = layouts[key];
      if (!alt || (def && layoutsSimilar(alt, def))) {
        // No (usable) geometry take → alternate composition of the same windows.
        alt = composeLayout(windows[key] ?? [], speakers, size.width, size.height, { ...composeOpts(c), alt: true });
        altMixedCount++;
      } else {
        altGeomCount++;
      }
      altLayouts[key] = alt;
    }
    log(`  ALT 9:16: ${altGeomCount} from geometry picks, ${altMixedCount} alt-composed (speaker pinned when attribution is sure)`);
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
  // A custom clip renders into its own out/<slug>/custom/ dir so it never
  // clobbers the auto-generated gallery (out/<slug>/clips + index.{json,html}).
  const clipsDir = join(outDir, args.clipAt ? "custom" : "clips");
  const clips = await buildClips({
    source,
    transcript,
    resolved: resolvedCands,
    clipsDir,
    captions,
    burn: args.burn,
    vertical: args.vertical,
    layouts,
    altLayouts,
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
    // Machine-readable result so a caller (the relay's /admin/generate-clips
    // route) can pick up the CIDs without scraping logs.
    await writeFile(
      join(outDir, "publish.json"),
      JSON.stringify({ slug: args.slug, clipsCid: `ipfs://${clipsCid}`, manifestCid: `ipfs://${manifestCid}`, count: clips.filter(c => c.mobileFile).length, generatedAt: new Date().toISOString() }, null, 2),
    );
    log(`\n✓ clips bundle:      ipfs://${clipsCid}`);
    log(`✓ updated manifest:  ipfs://${manifestCid}`);
    log(`  → slop.computer/admin → paste this manifest CID → Save Manifest (your wallet signs setManifest)`);
  }

  const generatedAt = new Date(t0).toISOString();

  if (args.clipAt) {
    // Custom clip: don't touch the gallery or the manifest — just emit a small
    // descriptor of what was rendered so the relay's /admin/clip-at route can
    // find + serve the file back to the admin (paths are relative to out/<slug>).
    const c = clips[0];
    const descriptor = {
      slug: args.slug,
      title: c?.title ?? args.clipTitle ?? "custom clip",
      start: c?.start ?? args.clipAt.start,
      end: c?.end ?? args.clipAt.end,
      duration: c?.duration,
      dir: "custom",
      file: c?.file, // landscape mp4 (clips-dir-relative)
      mobileFile: c?.mobileFile, // 9:16 stacked-tile mp4
      altMobileFile: c?.altMobileFile, // the ALT 9:16 take
      srt: c?.srt,
      speaker: c?.speaker,
      generatedAt,
    };
    await writeFile(join(outDir, "custom-clip.json"), JSON.stringify(descriptor, null, 2));
    log(`\n✓ custom clip in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    log(`  ${join(clipsDir, c?.mobileFile ?? c?.file ?? "")}`);
    log(`  descriptor: ${join(outDir, "custom-clip.json")}`);
    return;
  }

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
