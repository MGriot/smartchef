// ════════════════════════════════════════════════════════════════════════
// SmartChef — Reading a response body the GitHttp plugin spilled to disk
//
// GitHttpPlugin.java returns a large response as a file in the app cache
// rather than as one base64 field, because crossing the Capacitor bridge
// whole multiplied it into five or six large contiguous allocations and
// killed the WebView renderer outright — see that file's header, and
// sync/nativeHttpClient.test.ts, for the first-run crash that came from.
//
// Both callers of GitHttp.request() need to undo that the same way, but
// need different shapes at the end: isomorphic-git consumes a response as
// an async iterator and never needs it whole (sync/nativeHttpClient.ts),
// while the LLM provider calls want one buffer (nativeHttp.ts). Hence a
// generator plus a collector over it, in one place — the chunk walk, the
// short-read check and the release-on-abandon are subtle enough that two
// copies would drift.
//
// Deliberately its own module rather than living in gitHttpBridge.ts:
// nativeHttpClient's tests mock that module wholesale to stand in for the
// native plugin, and code under test must not arrive through the mock.
// ════════════════════════════════════════════════════════════════════════

import { GitHttp } from './gitHttpBridge';
import { base64ToBytes } from './gitfs';

/** How much to pull across the bridge at once. Purely a peak-memory knob:
 *  one slice base64'd in Java, one JSON string, one decoded Uint8Array —
 *  all bounded by this, whatever the response weighs. */
export const BODY_CHUNK_BYTES = 1024 * 1024;

/** Streams a spilled body back in bounded slices.
 *
 *  The `finally` is load-bearing: it runs when the consumer abandons the
 *  iterator early as well as on normal completion — isomorphic-git does
 *  exactly that if it hits a malformed pack — so the cache file is dropped
 *  either way rather than left for the next launch's sweep. */
export async function* spilledBodyChunks(path: string, length: number): AsyncIterableIterator<Uint8Array> {
  try {
    let offset = 0;
    while (offset < length) {
      const chunk = await GitHttp.readBodyChunk({ path, offset, length: BODY_CHUNK_BYTES });
      const { data, bytesRead } = chunk;
      // The native side echoes the offset it actually read from. This check
      // exists because that went wrong silently for eight releases: Java
      // read every chunk from offset 0 (Capacitor's getLong() ignores an
      // Integer-typed JSON number), so a large response came back as its
      // first megabyte repeated — no error anywhere, just a corrupt pack
      // that isomorphic-git then spun on until the WebView stopped
      // responding. Older native builds do not echo it, hence the undefined
      // allowance; a MISMATCH is never tolerated.
      if (chunk.offset !== undefined && chunk.offset !== offset) {
        throw new Error(
          `SmartChef: native layer read offset ${chunk.offset} when asked for ${offset} — refusing to return corrupted data`
        );
      }
      // A short read before the declared length means the file was
      // truncated under us; stopping silently here would hand the caller a
      // half response, which surfaces much later as a confusing parse error.
      if (bytesRead <= 0) throw new Error(`SmartChef: response body ended early at ${offset} of ${length} bytes`);
      yield base64ToBytes(data);
      offset += bytesRead;
    }
  } finally {
    await GitHttp.releaseBody({ path }).catch(() => {});
  }
}

/** Same walk, assembled into one buffer for callers that can't take a
 *  stream. The final buffer is unavoidably whole-sized; what this still
 *  avoids is the base64 string, the JSON message and the native-side copy
 *  all being whole-sized at the same time. */
export async function readSpilledBody(path: string, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  for await (const chunk of spilledBodyChunks(path, length)) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return offset === length ? out : out.subarray(0, offset);
}
