# Disk cleanup runbook (prod box)

When the prod box gets tight on disk — e.g. force-regenerating all clips, or
`df -h /` creeping past ~85% — work this list. **Reach for the EBS expand first;
it's cheaper than your time and non-disruptive. Delete only if you actually want
the space back.**

## The box

- ssh alias **`slopcomputer`** · EC2 `i-0d9b8eef7cced6d40` · **t3.xlarge** · `us-east-1`
- Root volume: **gp3, ext4** on `/dev/nvme0n1p1` (single attached volume)
- As of 2026-06-16 it was grown **150GB → 300GB** (~$24/mo, +$12/mo over 150GB)

```bash
ssh slopcomputer 'df -h /; echo; du -sh /home/ubuntu/* 2>/dev/null | sort -h | tail -10'
```

## What eats the disk

Two buckets dominate (the rest of `/home/ubuntu` is small):

| Path | ~Size | What it is | Safe to delete? |
|---|---|---|---|
| `/home/ubuntu/recordings/live/` | ~38G | Raw OBS captures, one per segment, going back weeks | **Yes, once the episode is processed** — the consolidated `out/<slug>/source.mp4` is what re-clipping uses, not these. Biggest, safest win. |
| `/home/ubuntu/clawd-clipper/out/<slug>/source.mp4` | ~3.2G each | Cached per-episode source video | Yes for **old/published** episodes — but deleting forces a re-extract if you ever re-clip that slug. Keep the ones you're actively iterating on. |
| `out/<slug>/clips`, `frames`, `audio`, `custom` | <1G each | Regenerable derivatives (`--force` overwrites in place) | Yes — all regenerable from `source.mp4`. Small, low priority. |
| `out/<slug>/*.json`, `index.html` | KB | Director/judge/candidates/captions metadata | **No** — tiny and the brains of the episode. |

Note: a force-regen does **not** balloon the disk — sources are cached and clip
outputs overwrite in place. Tight disk during regen means you were already near
the line, not that regen is leaking. (Verified: no `*.tmp`/`*.part` accumulation,
`/tmp` stays small.)

## Lever 1 — expand the EBS volume (preferred, ~2 min, no downtime)

gp3 grows online: no reboot, doesn't interrupt an in-flight render. You can only
**grow** (never shrink) and only once per 6h, so pick a size with headroom.

1. **AWS Console** → EC2 → Volumes (us-east-1) → the volume on `i-0d9b8eef7cced6d40`
   → **Actions → Modify Volume** → set new **Size** → keep gp3 / 3000 IOPS / 125 MB/s
   (those are the free baseline; extra cost only above them) → Modify.
   Cost = **$0.08/GB-month** (so 300GB ≈ $24/mo, 500GB ≈ $40/mo).
2. It'll show *in-use / optimizing* — already usable. Then on the box grow the
   partition + filesystem live:
   ```bash
   ssh slopcomputer 'sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1 && df -h /'
   ```
   (`growpart` expands partition 1; `resize2fs` grows the ext4 onto it. ext4 only —
   if the fs ever changes to xfs, use `sudo xfs_growfs /`.)

There is **no `aws` CLI on the box or on the local laptop** as of 2026-06-16, so
the Modify step is Console-only unless you install + credential the CLI.

## Lever 2 — prune old raw recordings (frees the most, fastest)

The `recordings/live/*.mp4` are raw and redundant once an episode's `source.mp4`
exists. Inspect, then delete by age. **Look before you delete** — confirm the
dates are old shows you've already clipped.

```bash
# Oldest first, with sizes:
ssh slopcomputer 'ls -lhtr /home/ubuntu/recordings/live/*.mp4 | head -40'

# Dry run: everything older than 30 days
ssh slopcomputer 'find /home/ubuntu/recordings/live -name "*.mp4" -mtime +30 -printf "%s\t%p\n" | sort -n'

# Delete them (only after eyeballing the dry run):
ssh slopcomputer 'find /home/ubuntu/recordings/live -name "*.mp4" -mtime +30 -delete'
```

## Lever 3 — drop cached sources for done episodes

Frees ~3.2G per slug. Only do this for episodes you're not re-clipping; the next
`yarn clip <slug>` would have to re-extract.

```bash
ssh slopcomputer 'du -sh /home/ubuntu/clawd-clipper/out/*/source.mp4 | sort -h'
# e.g. for one finished slug:
ssh slopcomputer 'rm /home/ubuntu/clawd-clipper/out/<slug>/source.mp4'
```

## Don't touch

- Any `out/<slug>/*.json` / `index.html` (metadata, tiny, irreplaceable).
- The active slug's `source.mp4` while a render is running.
- Remember the clipper runs as a **non-detached child of `slop-relay`** — don't
  `systemctl restart slop-relay` while a clip is rendering (SIGTERMs it). Same
  caution applies if a cleanup ever needs a service bounce.
