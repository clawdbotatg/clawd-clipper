import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Stream the (possibly multi-GB) episode mp4 from the IPFS gateway straight
// to disk — never buffer it in RAM. Cached: a second run with the file
// already present and non-empty is skipped unless `force`.

export async function downloadFile(url: string, dest: string, force = false): Promise<{ path: string; cached: boolean }> {
  if (!force) {
    try {
      const s = await stat(dest);
      if (s.size > 0) return { path: dest, cached: true };
    } catch {
      /* not present yet */
    }
  }
  await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${res.status} from ${url}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  return { path: dest, cached: false };
}
