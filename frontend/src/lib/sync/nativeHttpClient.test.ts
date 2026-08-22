import { describe, it, expect, vi, beforeEach } from 'vitest';

let electronFlag = false;
const electronHttpRequestMock = vi.fn();
vi.mock('../electronBridge', () => ({
  isElectron: () => electronFlag,
  electronHttpRequest: (...args: unknown[]) => electronHttpRequestMock(...args),
}));

const gitHttpRequestMock = vi.fn();
vi.mock('../gitHttpBridge', () => ({
  GitHttp: { request: (...args: unknown[]) => gitHttpRequestMock(...args) },
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
