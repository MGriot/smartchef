// ════════════════════════════════════════════════════════════════════════
// SmartChef — a WebDAV server as a sync v2 store (Nextcloud, ownCloud,
// Koofr, pCloud, Box, most NAS boxes). docs/plans/2026-11-01-sync-v2-
// change-log.md §4.
//
// Three verbs cover the store: PROPFIND (Depth 1) to list a folder, GET,
// and PUT. WebDAV will not create a missing parent folder on PUT (409), so
// a PUT that fails that way creates its folders with MKCOL, top down, and
// tries again; folders known to exist are remembered for the session.
// Sign-in is a username and an app password over HTTPS (Basic auth) — no
// OAuth needed, which is why WebDAV comes before the big cloud drives.
//
// Requests go through lib/nativeHttp.ts (native code in both shells), so
// no CORS; the request function is injectable for tests.
// ════════════════════════════════════════════════════════════════════════

import type { NativeHttpRequest, NativeHttpResponse } from '../nativeHttp';
import type { SyncStore } from './store';

export interface WebDavConfig {
  /** The folder the library lives in, e.g.
   *  https://cloud.example.com/remote.php/dav/files/anna/SmartChef */
  url: string;
  username: string;
  password: string;
}

export type HttpFn = (req: NativeHttpRequest) => Promise<NativeHttpResponse>;

const TIMEOUT_MS = 60_000;

function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

const encodePath = (path: string) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** Every <href> in a PROPFIND multistatus, whatever namespace prefix the
 *  server uses (d:, D:, none). Plain text matching rather than DOMParser,
 *  which the Node test environment lacks and the payload doesn't need. */
export function hrefsIn(xml: string): string[] {
  return [...xml.matchAll(/<(?:[\w-]+:)?href>\s*([^<]+?)\s*<\/(?:[\w-]+:)?href>/gi)].map((m) => m[1]);
}

export class WebDavError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function describe(status: number, action: string): WebDavError {
  if (status === 401 || status === 403) {
    return new WebDavError(`The WebDAV server refused the username or app password (${status}) while trying to ${action}. Check them in Account → Folder Sync.`, status);
  }
  if (status === 507) return new WebDavError('The WebDAV server is out of space.', status);
  return new WebDavError(`The WebDAV server answered ${status} while trying to ${action}.`, status);
}

export function createWebDavStore(config: WebDavConfig, http?: HttpFn): SyncStore {
  const base = config.url.replace(/\/+$/, '');
  const auth = basicAuth(config.username, config.password);
  const knownDirs = new Set<string>();
  const request: HttpFn = http ?? (async (req) => (await import('../nativeHttp')).nativeHttpRequest(req));
  const call = (method: string, path: string, extra: Partial<NativeHttpRequest> = {}) =>
    request({ url: `${base}/${encodePath(path)}${extra.url ?? ''}`, method, headers: { Authorization: auth, ...(extra.headers ?? {}) }, body: extra.body, timeoutMs: TIMEOUT_MS });

  async function mkdirs(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (knownDirs.has(dir)) continue;
      const res = await call('MKCOL', dir, { url: '/' });
      // 201 made, 405 already there; anything else is a real failure.
      if (res.statusCode !== 201 && res.statusCode !== 405) throw describe(res.statusCode, `create the folder ${dir}`);
      knownDirs.add(dir);
    }
  }

  return {
    async list(prefix) {
      const dir = prefix.replace(/\/+$/, '');
      const res = await call('PROPFIND', dir, { url: '/', headers: { Depth: '1', 'Content-Type': 'application/xml' } });
      if (res.statusCode === 404) return [];
      if (res.statusCode !== 207) throw describe(res.statusCode, `list ${dir}`);
      knownDirs.add(dir);
      const self = `/${encodePath(dir)}`;
      const names = new Set<string>();
      for (const raw of hrefsIn(new TextDecoder().decode(res.body))) {
        const path = decodeURIComponent(raw.replace(/^https?:\/\/[^/]+/i, '')).replace(/\/+$/, '');
        if (path.endsWith(decodeURIComponent(self)) || path === '') continue;
        const name = path.slice(path.lastIndexOf('/') + 1);
        if (name) names.add(name);
      }
      return [...names].sort();
    },

    async get(path) {
      const res = await call('GET', path);
      if (res.statusCode === 404) return null;
      if (res.statusCode < 200 || res.statusCode >= 300) throw describe(res.statusCode, `read ${path}`);
      return res.body;
    },

    async put(path, data) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent && !knownDirs.has(parent)) {
        // Cheaper to try first: most folders exist after the first sync.
        const first = await call('PUT', path, { body: data, headers: { 'Content-Type': 'application/octet-stream' } });
        if (first.statusCode >= 200 && first.statusCode < 300) { knownDirs.add(parent); return; }
        if (first.statusCode !== 409 && first.statusCode !== 404) throw describe(first.statusCode, `write ${path}`);
        await mkdirs(parent);
      }
      const res = await call('PUT', path, { body: data, headers: { 'Content-Type': 'application/octet-stream' } });
      if (res.statusCode < 200 || res.statusCode >= 300) throw describe(res.statusCode, `write ${path}`);
    },

    async remove(path) {
      const res = await call('DELETE', path);
      if (res.statusCode !== 404 && (res.statusCode < 200 || res.statusCode >= 300)) throw describe(res.statusCode, `delete ${path}`);
    },
  };
}
