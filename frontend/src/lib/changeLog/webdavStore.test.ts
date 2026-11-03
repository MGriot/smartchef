import { describe, it, expect } from 'vitest';
import { createWebDavStore, hrefsIn, type HttpFn } from './webdavStore';

/** A small WebDAV server in memory, strict like Nextcloud: PUT into a
 *  missing folder is 409, MKCOL on an existing one is 405, PROPFIND of a
 *  missing folder is 404, wrong credentials are 401. */
function fakeServer(rootPath = '/remote.php/dav/files/anna/SmartChef') {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['']);
  const calls: string[] = [];
  const http: HttpFn = async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname.slice(rootPath.length)).replace(/^\/+|\/+$/g, '');
    calls.push(`${req.method} ${rel}`);
    const ok = (statusCode: number, body = '') => ({ statusCode, headers: {}, body: new TextEncoder().encode(body) });
    if (req.headers.Authorization !== `Basic ${btoa('anna:secret')}`) return ok(401);
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    switch (req.method) {
      case 'PUT':
        if (!dirs.has(parent)) return ok(409);
        files.set(rel, req.body!);
        return ok(201);
      case 'GET': {
        const f = files.get(rel);
        return f ? { statusCode: 200, headers: {}, body: f } : ok(404);
      }
      case 'MKCOL':
        if (dirs.has(rel)) return ok(405);
        if (!dirs.has(parent)) return ok(409);
        dirs.add(rel);
        return ok(201);
      case 'PROPFIND': {
        if (!dirs.has(rel)) return ok(404);
        const prefix = rel ? `${rel}/` : '';
        const children = new Set<string>();
        for (const p of [...files.keys(), ...dirs]) {
          if (p && p.startsWith(prefix) && p !== rel) children.add(p.slice(prefix.length).split('/')[0]);
        }
        const href = (p: string) => `<d:response><d:href>${rootPath}/${p.split('/').map(encodeURIComponent).join('/')}</d:href></d:response>`;
        return ok(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${href(rel)}${[...children].map((c) => href(prefix + c)).join('')}</d:multistatus>`);
      }
      default:
        return ok(405);
    }
  };
  return { http, files, calls };
}

const cfg = { url: 'https://cloud.example.com/remote.php/dav/files/anna/SmartChef/', username: 'anna', password: 'secret' };
const text = (s: string) => new TextEncoder().encode(s);

describe('webdav store', () => {
  it('creates missing folders on first write, then writes straight away', async () => {
    const server = fakeServer();
    const store = createWebDavStore(cfg, server.http);
    await store.put('devices/A/log/1-3.json.gz', text('log'));
    expect(server.calls).toEqual(['PUT devices/A/log/1-3.json.gz', 'MKCOL devices', 'MKCOL devices/A', 'MKCOL devices/A/log', 'PUT devices/A/log/1-3.json.gz']);
    server.calls.length = 0;
    await store.put('devices/A/log/4-5.json.gz', text('more'));
    expect(server.calls).toEqual(['PUT devices/A/log/4-5.json.gz']);
  });

  it('lists a folder by name, and an empty or missing one as []', async () => {
    const server = fakeServer();
    const store = createWebDavStore(cfg, server.http);
    expect(await store.list('devices')).toEqual([]);
    await store.put('devices/A/head.json', text('{}'));
    await store.put('devices/Bé b/head.json', text('{}'));
    expect(await store.list('devices')).toEqual(['A', 'Bé b']);
    expect(await store.list('devices/A')).toEqual(['head.json']);
  });

  it('reads back what it wrote; a missing file is null', async () => {
    const store = createWebDavStore(cfg, fakeServer().http);
    await store.put('format.json', text('{"v":1}'));
    expect(new TextDecoder().decode((await store.get('format.json'))!)).toBe('{"v":1}');
    expect(await store.get('nope.json')).toBeNull();
  });

  it('says what to fix when the credentials are wrong', async () => {
    const store = createWebDavStore({ ...cfg, password: 'wrong' }, fakeServer().http);
    await expect(store.get('format.json')).rejects.toThrow(/username or app password/);
  });

  it('reads hrefs with any namespace prefix', () => {
    expect(hrefsIn('<D:href>/a/</D:href><href>/b</href><d:href> /c </d:href>')).toEqual(['/a/', '/b', '/c']);
  });
});
