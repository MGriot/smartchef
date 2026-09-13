import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let electronFlag = false;
const electronHttpRequestMock = vi.fn();
vi.mock('../electronBridge', () => ({
  isElectron: () => electronFlag,
  electronHttpRequest: (...args: unknown[]) => electronHttpRequestMock(...args),
}));

const gitHttpRequestMock = vi.fn();
const readBodyChunkMock = vi.fn();
const releaseBodyMock = vi.fn();
vi.mock('../gitHttpBridge', () => ({
  GitHttp: {
    request: (...args: unknown[]) => gitHttpRequestMock(...args),
    readBodyChunk: (...args: unknown[]) => readBodyChunkMock(...args),
    releaseBody: (...args: unknown[]) => releaseBodyMock(...args),
  },
}));

import { nativeHttpClient } from './nativeHttpClient';

async function* asyncBody(chunks: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function drain(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  if (body) for await (const chunk of body) chunks.push(chunk);
  return chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((c) => [...c]));
}

beforeEach(() => {
  electronFlag = false;
  electronHttpRequestMock.mockReset();
  gitHttpRequestMock.mockReset();
  readBodyChunkMock.mockReset();
  releaseBodyMock.mockReset();
});

describe('nativeHttpClient on Android (non-Electron)', () => {
  it('base64-encodes a request body and base64-decodes the response body', async () => {
    const requestBytes = new Uint8Array([1, 2, 3]);
    const responseBytes = new Uint8Array([9, 8, 7]);
    gitHttpRequestMock.mockResolvedValue({
      url: 'https://example.com/repo.git/git-upload-pack',
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: btoa(String.fromCharCode(...responseBytes)),
    });

    const result = await nativeHttpClient.request({
      url: 'https://example.com/repo.git/git-upload-pack',
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: asyncBody([requestBytes]),
    });

    expect(gitHttpRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com/repo.git/git-upload-pack',
      method: 'POST',
      body: btoa(String.fromCharCode(...requestBytes)),
    }));
    expect(result.statusCode).toBe(200);
    expect([...(await drain(result.body))]).toEqual([9, 8, 7]);
  });

  it('omits the body param entirely for a bodyless (GET) request', async () => {
    gitHttpRequestMock.mockResolvedValue({ url: 'https://example.com', statusCode: 200, statusMessage: 'OK', headers: {}, body: '' });

    await nativeHttpClient.request({ url: 'https://example.com', method: 'GET', headers: {} });

    expect(gitHttpRequestMock.mock.calls[0][0].body).toBeUndefined();
  });

  it('drains a multi-chunk request body into one buffer before sending', async () => {
    gitHttpRequestMock.mockResolvedValue({ url: 'https://example.com', statusCode: 200, statusMessage: 'OK', headers: {}, body: '' });

    await nativeHttpClient.request({
      url: 'https://example.com',
      method: 'POST',
      headers: {},
      body: asyncBody([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
    });

    expect(gitHttpRequestMock.mock.calls[0][0].body).toBe(btoa(String.fromCharCode(1, 2, 3, 4)));
  });
});

describe('nativeHttpClient on Electron', () => {
  beforeEach(() => {
    electronFlag = true;
  });

  it('passes raw bytes through (no base64) to electronHttpRequest', async () => {
    const requestBytes = new Uint8Array([1, 2, 3]);
    const responseBytes = new Uint8Array([9, 8, 7]);
    electronHttpRequestMock.mockResolvedValue({
      url: 'https://example.com/repo.git/git-upload-pack',
      statusCode: 200,
      statusMessage: 'OK',
      headers: {},
      body: responseBytes,
    });

    const result = await nativeHttpClient.request({
      url: 'https://example.com/repo.git/git-upload-pack',
      method: 'POST',
      headers: {},
      body: asyncBody([requestBytes]),
    });

    expect(electronHttpRequestMock).toHaveBeenCalledWith(expect.objectContaining({ body: requestBytes }));
    expect([...(await drain(result.body))]).toEqual([9, 8, 7]);
  });

  it('does not call the Android plugin bridge', async () => {
    electronHttpRequestMock.mockResolvedValue({ url: 'https://example.com', statusCode: 200, statusMessage: 'OK', headers: {}, body: new Uint8Array() });

    await nativeHttpClient.request({ url: 'https://example.com', method: 'GET', headers: {} });

    expect(gitHttpRequestMock).not.toHaveBeenCalled();
  });
});

// ── Request deadline ────────────────────────────────────────────────────
// A remote that accepts the connection and then never answers used to leave
// the request pending forever. Because gitSync.ts funnels every git
// operation through one shared queue, that wedged the queue permanently —
// no further commit/push/pull for the session, and (before saves stopped
// awaiting sync) a frozen recipe editor on every save afterwards.
//
// The deadline is 180s rather than the original 60s because the native call
// now spans the whole response download (see the streaming tests below), and
// a new device's first fetch legitimately pulls the entire repository.
describe('request deadline', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects a request the Android bridge never answers, instead of hanging forever', async () => {
    gitHttpRequestMock.mockReturnValue(new Promise(() => {})); // never settles
    const pending = nativeHttpClient.request({ url: 'https://example.com/repo.git/info/refs', method: 'GET' });
    const assertion = expect(pending).rejects.toThrow(/no response from https:\/\/example\.com/);
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
  });

  it('rejects a request the Electron bridge never answers', async () => {
    electronFlag = true;
    electronHttpRequestMock.mockReturnValue(new Promise(() => {}));
    const pending = nativeHttpClient.request({ url: 'https://git.example.org/x.git/info/refs', method: 'GET' });
    const assertion = expect(pending).rejects.toThrow(/after 180s/);
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
  });

  it('does not reject a request that answers in time', async () => {
    gitHttpRequestMock.mockResolvedValue({
      url: 'https://example.com/repo.git/info/refs',
      statusCode: 200, statusMessage: 'OK', headers: {}, body: btoa('ok'), bodyLength: 2,
    });
    const res = await nativeHttpClient.request({ url: 'https://example.com/repo.git/info/refs', method: 'GET' });
    expect(res.statusCode).toBe(200);
    // The deadline timer must be cleared on success, or a resolved request
    // would keep a 60s timer alive and hold the process open.
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Large response bodies ───────────────────────────────────────────────
// Setting up a new Android device against an existing git remote killed the
// app on the first-run "Checking this folder for existing profiles…" screen.
//
// A device's FIRST fetch has no local history to negotiate against, so the
// server answers with a pack covering the whole repository — ~16 MB for a
// real library — and GitHttpPlugin.java handed that back as one base64
// field in one JSON message. Between the doubling ByteArrayOutputStream,
// its toByteArray() copy, the base64 String, Capacitor's JSON serialization
// of it, the WebView's JSON.parse and the decoded bytes, a single response
// existed five or six times over in large contiguous allocations, and the
// renderer was killed partway through. Nothing threw: the awaiting JS
// simply never ran again, which is why the screen just stopped.
//
// So these are about peak memory: that a spilled body crosses in bounded
// slices, reassembles in order and intact, and always releases the native
// file — including when the consumer walks away early, which isomorphic-git
// does on a malformed pack.

/** Chunked for the same reason the implementation is: the per-character
 *  version is quadratic, and these fixtures are megabytes. */
function bigBytesToBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    pieces.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(pieces.join(''));
}

/** Index of the first differing byte, or -1. Used instead of toEqual, which
 *  walks a typed array element by element and takes longer on these
 *  fixtures than everything else in this file put together. */
function firstMismatch(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function pseudoRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed & 0xff;
  }
  return bytes;
}

/** Answers readBodyChunk from an in-memory buffer the way RandomAccessFile
 *  does, short read at the end included. */
function fakeSpill(path: string, body: Uint8Array) {
  readBodyChunkMock.mockImplementation((opts: { path: string; offset: number; length: number }) => {
    expect(opts.path).toBe(path);
    const slice = body.subarray(opts.offset, opts.offset + opts.length);
    return Promise.resolve({ data: bigBytesToBase64(slice), bytesRead: slice.length });
  });
  releaseBodyMock.mockResolvedValue(undefined);
  gitHttpRequestMock.mockResolvedValue({
    url: 'https://example.com/repo.git/git-upload-pack',
    statusCode: 200,
    statusMessage: 'OK',
    headers: {},
    bodyFile: path,
    bodyLength: body.length,
  });
}

describe('a response the native side spilled to a file', () => {
  it('never pulls more than one chunk across the bridge at a time', async () => {
    // Larger than one chunk and not a whole multiple of one, so the final
    // short read is exercised too.
    const body = pseudoRandomBytes(2_621_440);
    fakeSpill('/cache/git-http-bodies/abc', body);

    const res = await nativeHttpClient.request({ url: 'https://example.com/repo.git/git-upload-pack' });
    const got = await drain(res.body);

    expect(got.length).toBe(body.length);
    expect(firstMismatch(got, body)).toBe(-1);
    const lengths = readBodyChunkMock.mock.calls.map((c) => (c[0] as { length: number }).length);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1024 * 1024);
    // The bug was one crossing carrying everything; this is what actually
    // encodes "streamed" rather than merely "correct".
    expect(readBodyChunkMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('walks the file from start to end with no gaps or re-reads', async () => {
    fakeSpill('/cache/git-http-bodies/def', new Uint8Array(1024 * 1024 + 7).fill(9));

    const res = await nativeHttpClient.request({ url: 'https://example.com/repo.git/git-upload-pack' });
    await drain(res.body);

    expect(readBodyChunkMock.mock.calls.map((c) => (c[0] as { offset: number }).offset)).toEqual([0, 1024 * 1024]);
  });

  it('releases the native file once drained', async () => {
    fakeSpill('/cache/git-http-bodies/ghi', new Uint8Array(2 * 1024 * 1024).fill(1));

    const res = await nativeHttpClient.request({ url: 'https://example.com/repo.git/git-upload-pack' });
    await drain(res.body);

    expect(releaseBodyMock).toHaveBeenCalledWith({ path: '/cache/git-http-bodies/ghi' });
  });

  it('releases the native file even when the consumer stops early', async () => {
    // isomorphic-git abandons the iterator on a malformed pack. Without the
    // generator's finally block that file survives until the next sweep.
    fakeSpill('/cache/git-http-bodies/jkl', new Uint8Array(3 * 1024 * 1024).fill(2));

    const res = await nativeHttpClient.request({ url: 'https://example.com/repo.git/git-upload-pack' });
    for await (const _chunk of res.body!) break;

    expect(releaseBodyMock).toHaveBeenCalledWith({ path: '/cache/git-http-bodies/jkl' });
    expect(readBodyChunkMock.mock.calls.length).toBe(1);
  });

  it('fails loudly when the file ends before the declared length', async () => {
    // Truncated underneath us. Stopping quietly would hand isomorphic-git
    // half a pack, surfacing much later as a confusing parse error.
    releaseBodyMock.mockResolvedValue(undefined);
    readBodyChunkMock.mockResolvedValue({ data: '', bytesRead: 0 });
    gitHttpRequestMock.mockResolvedValue({
      url: 'https://example.com/repo.git/git-upload-pack',
      statusCode: 200, statusMessage: 'OK', headers: {},
      bodyFile: '/cache/git-http-bodies/mno', bodyLength: 5 * 1024 * 1024,
    });

    const res = await nativeHttpClient.request({ url: 'https://example.com/repo.git/git-upload-pack' });

    await expect(drain(res.body)).rejects.toThrow(/ended early/);
    expect(releaseBodyMock).toHaveBeenCalledWith({ path: '/cache/git-http-bodies/mno' });
  });

  it('base64s a multi-megabyte push body without quadratic concatenation', async () => {
    gitHttpRequestMock.mockResolvedValue({
      url: 'https://example.com/repo.git/git-receive-pack',
      statusCode: 200, statusMessage: 'OK', headers: {}, body: '', bodyLength: 0,
    });
    const push = pseudoRandomBytes(3 * 1024 * 1024);

    const startedAt = Date.now();
    await nativeHttpClient.request({
      url: 'https://example.com/repo.git/git-receive-pack',
      method: 'POST',
      body: asyncBody([push]),
    });
    const elapsed = Date.now() - startedAt;

    expect((gitHttpRequestMock.mock.calls[0][0] as { body: string }).body).toBe(bigBytesToBase64(push));
    // The per-character version took tens of seconds on a phone for a body
    // this size. Generous on purpose: this rules out the quadratic shape,
    // it does not benchmark the machine.
    expect(elapsed).toBeLessThan(5000);
  });
});
