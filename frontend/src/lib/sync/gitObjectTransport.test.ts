import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeLocalFs, putLocalText, getLocalText, createFakeRemoteTransport, putRemoteText, getRemoteText } from './testUtils/fakes';
import { pushObjectsAndRefs, pullObjectsAndRefs, DEFAULT_REMOTE_TRACKING_REF_PATH } from './gitObjectTransport';

let localFs: ReturnType<typeof createFakeLocalFs>;

beforeEach(() => {
  localFs = createFakeLocalFs();
});

describe('pushObjectsAndRefs', () => {
  it('does nothing (pushed: false) when there is no local ref yet', async () => {
    const remote = createFakeRemoteTransport();
    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);
    expect(result).toEqual({ pushed: false, objectsUploaded: 0, uploadedObjectPaths: [] });
  });

  it('uploads objects before refs/HEAD — call order, not just end state', async () => {
    putLocalText(localFs, '/hidden-clone/.git/objects/ab/cdef01', 'object-bytes');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-abc123\n');
    putLocalText(localFs, '/hidden-clone/.git/HEAD', 'ref: refs/heads/main\n');
    const remote = createFakeRemoteTransport();
    const writeSpy = vi.spyOn(remote, 'writeFile');

    await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    const paths = writeSpy.mock.calls.map((call) => call[0]);
    const objectIndex = paths.indexOf('.git/objects/ab/cdef01');
    const refIndex = paths.indexOf('.git/refs/heads/main');
    const headIndex = paths.indexOf('.git/HEAD');
    expect(objectIndex).toBeGreaterThanOrEqual(0);
    expect(objectIndex).toBeLessThan(refIndex);
    expect(objectIndex).toBeLessThan(headIndex);
  });

  it('uploads local objects and refs/HEAD to the remote', async () => {
    putLocalText(localFs, '/hidden-clone/.git/objects/ab/cdef01', 'object-bytes');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-abc123\n');
    putLocalText(localFs, '/hidden-clone/.git/HEAD', 'ref: refs/heads/main\n');
    const remote = createFakeRemoteTransport();

    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.pushed).toBe(true);
    expect(result.objectsUploaded).toBe(1);
    expect(getRemoteText(remote, '.git/objects/ab/cdef01')).toBe('object-bytes');
    expect(getRemoteText(remote, '.git/refs/heads/main')).toBe('commit-abc123\n');
    expect(getRemoteText(remote, '.git/HEAD')).toBe('ref: refs/heads/main\n');
  });

  it('never re-uploads an object the remote already has (content-addressed, immutable)', async () => {
    putLocalText(localFs, '/hidden-clone/.git/objects/ab/cdef01', 'object-bytes');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-abc123\n');
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/ab/cdef01', 'object-bytes');
    const writeSpy = vi.spyOn(remote, 'writeFile');

    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.objectsUploaded).toBe(0);
    expect(writeSpy).not.toHaveBeenCalledWith('.git/objects/ab/cdef01', expect.anything());
  });

  it('a failure partway through the objects loop never reaches refs — the remote stays consistent for a later pull', async () => {
    putLocalText(localFs, '/hidden-clone/.git/objects/aa/first01', 'first-object');
    putLocalText(localFs, '/hidden-clone/.git/objects/bb/second02', 'second-object');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-abc123\n');
    const remote = createFakeRemoteTransport();
    let call = 0;
    vi.spyOn(remote, 'writeFile').mockImplementation(async (path, data) => {
      call++;
      if (call === 2) throw new Error('simulated remote write failure');
      remote.files.set(path, data);
    });

    await expect(pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote)).rejects.toThrow('simulated remote write failure');
    expect(remote.files.has('.git/refs/heads/main')).toBe(false);
  });
});

describe('pullObjectsAndRefs', () => {
  it('does nothing (pulled: false) when the remote has no history yet', async () => {
    const remote = createFakeRemoteTransport();
    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);
    expect(result).toEqual({ pulled: false, objectsFetched: 0, fetchedObjectPaths: [], remoteRefBytes: null, complete: true });
  });

  it('fetches remote objects and writes the ref to the local tracking path — never to refs/heads/main', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/ab/cdef01', 'object-bytes');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.pulled).toBe(true);
    expect(result.objectsFetched).toBe(1);
    expect(getLocalText(localFs, '/hidden-clone/.git/objects/ab/cdef01')).toBe('object-bytes');
    expect(getLocalText(localFs, `/hidden-clone/${DEFAULT_REMOTE_TRACKING_REF_PATH}`)).toBe('commit-abc123\n');
    expect(getLocalText(localFs, '/hidden-clone/.git/refs/heads/main')).toBeUndefined();
  });

  it('never clobbers an existing local branch ref — the whole point of writing to a tracking ref instead', async () => {
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'local-commit-999\n');
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'remote-commit-abc\n');

    await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(getLocalText(localFs, '/hidden-clone/.git/refs/heads/main')).toBe('local-commit-999\n');
    expect(getLocalText(localFs, `/hidden-clone/${DEFAULT_REMOTE_TRACKING_REF_PATH}`)).toBe('remote-commit-abc\n');
  });

  it('accepts a custom tracking ref path', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');

    await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote, '.git/refs/remotes/custom/main');

    expect(getLocalText(localFs, '/hidden-clone/.git/refs/remotes/custom/main')).toBe('commit-abc123\n');
  });

  it('never re-fetches an object already present locally', async () => {
    putLocalText(localFs, '/hidden-clone/.git/objects/ab/cdef01', 'object-bytes');
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/ab/cdef01', 'object-bytes');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');
    const readSpy = vi.spyOn(remote, 'readFile');

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.objectsFetched).toBe(0);
    expect(readSpy).not.toHaveBeenCalledWith('.git/objects/ab/cdef01');
  });

  it('fetches objects before writing the tracking ref — call order, not just end state', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/ab/cdef01', 'object-bytes');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');
    const writeSpy = vi.spyOn(localFs.promises, 'writeFile');

    await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    const paths = writeSpy.mock.calls.map((call) => call[0]);
    const objectIndex = paths.indexOf('/hidden-clone/.git/objects/ab/cdef01');
    const refIndex = paths.indexOf(`/hidden-clone/${DEFAULT_REMOTE_TRACKING_REF_PATH}`);
    expect(objectIndex).toBeGreaterThanOrEqual(0);
    expect(objectIndex).toBeLessThan(refIndex);
  });
});

describe('two-device convergence', () => {
  it('device A push -> shared remote -> device B pull delivers the same object bytes', async () => {
    const deviceA = createFakeLocalFs();
    const deviceB = createFakeLocalFs();
    const sharedRemote = createFakeRemoteTransport();

    putLocalText(deviceA, '/hidden-clone/.git/objects/aa/1234ab', 'recipe blob content');
    putLocalText(deviceA, '/hidden-clone/.git/objects/bb/5678cd', 'commit object content');
    putLocalText(deviceA, '/hidden-clone/.git/refs/heads/main', 'commit-aa1234\n');
    putLocalText(deviceA, '/hidden-clone/.git/HEAD', 'ref: refs/heads/main\n');

    const pushResult = await pushObjectsAndRefs(deviceA.promises, '/hidden-clone', sharedRemote);
    expect(pushResult).toEqual({
      pushed: true,
      objectsUploaded: 2,
      uploadedObjectPaths: ['.git/objects/aa/1234ab', '.git/objects/bb/5678cd'],
    });

    const pullResult = await pullObjectsAndRefs(deviceB.promises, '/hidden-clone', sharedRemote);
    expect(pullResult.pulled).toBe(true);
    expect(pullResult.objectsFetched).toBe(2);
    expect(getLocalText(deviceB, '/hidden-clone/.git/objects/aa/1234ab')).toBe('recipe blob content');
    expect(getLocalText(deviceB, '/hidden-clone/.git/objects/bb/5678cd')).toBe('commit object content');
    // Device B has no local commits of its own yet, so its tracking ref
    // simply reflects what device A pushed — the interesting case (a local
    // ref surviving a pull untouched) is covered separately above.
    expect(getLocalText(deviceB, `/hidden-clone/${DEFAULT_REMOTE_TRACKING_REF_PATH}`)).toBe('commit-aa1234\n');
  });

  it('a second push cycle only uploads what changed since the first', async () => {
    const deviceA = createFakeLocalFs();
    const sharedRemote = createFakeRemoteTransport();
    putLocalText(deviceA, '/hidden-clone/.git/objects/aa/1234ab', 'first commit blob');
    putLocalText(deviceA, '/hidden-clone/.git/refs/heads/main', 'commit-aa1234\n');
    await pushObjectsAndRefs(deviceA.promises, '/hidden-clone', sharedRemote);

    // A second local commit adds one new object, keeps the old one.
    putLocalText(deviceA, '/hidden-clone/.git/objects/cc/9999ef', 'second commit blob');
    putLocalText(deviceA, '/hidden-clone/.git/refs/heads/main', 'commit-cc9999\n');

    const secondPush = await pushObjectsAndRefs(deviceA.promises, '/hidden-clone', sharedRemote);

    expect(secondPush.objectsUploaded).toBe(1);
    expect(secondPush.uploadedObjectPaths).toEqual(['.git/objects/cc/9999ef']);
    expect(getRemoteText(sharedRemote, '.git/refs/heads/main')).toBe('commit-cc9999\n');
  });
});

describe('pushObjectsAndRefs compare-and-swap (expectedRemoteRefBytes)', () => {
  it('writes the ref when the remote still matches what the caller last observed', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-old\n');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-new\n');

    const expected = new TextEncoder().encode('commit-old\n');
    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote, undefined, expected);

    expect(result).toEqual({ pushed: true, objectsUploaded: 0, uploadedObjectPaths: [] });
    expect(getRemoteText(remote, '.git/refs/heads/main')).toBe('commit-new\n');
  });

  it('skips the ref write and reports conflict:true when another device already changed the remote ref', async () => {
    const remote = createFakeRemoteTransport();
    // Caller last observed 'commit-old' via a pull, but by the time it
    // pushes, some other device has already advanced the remote ref —
    // exactly the race two concurrently-syncing devices can hit.
    putRemoteText(remote, '.git/refs/heads/main', 'commit-from-other-device\n');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-new\n');

    const staleExpected = new TextEncoder().encode('commit-old\n');
    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote, undefined, staleExpected);

    expect(result.pushed).toBe(false);
    expect(result.conflict).toBe(true);
    // The other device's ref must survive untouched — this is the whole point.
    expect(getRemoteText(remote, '.git/refs/heads/main')).toBe('commit-from-other-device\n');
  });

  it('reports conflict:true when another device writes the ref right after this one — read back, not assumed', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-old\n');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-new\n');
    // The other device's write lands between this device's write and its read-back.
    const writeFile = remote.writeFile.bind(remote);
    remote.writeFile = async (rel: string, data: Uint8Array) => {
      await writeFile(rel, data);
      if (rel === '.git/refs/heads/main') await writeFile(rel, new TextEncoder().encode('commit-from-other-device\n'));
    };

    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote, undefined, new TextEncoder().encode('commit-old\n'));

    expect(result.pushed).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('treats expectedRemoteRefBytes: null as "expect no ref yet" and detects a conflict if one appeared', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-from-other-device\n');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-new\n');

    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote, undefined, null);

    expect(result.pushed).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('still uploads objects even when the ref write is skipped on conflict — immutable, harmless to leave behind', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-from-other-device\n');
    putLocalText(localFs, '/hidden-clone/.git/objects/aa/1234ab', 'recipe blob content');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-new\n');

    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote, undefined, null);

    expect(result.objectsUploaded).toBe(1);
    expect(result.conflict).toBe(true);
    expect(getRemoteText(remote, '.git/objects/aa/1234ab')).toBe('recipe blob content');
  });

  it('omitting expectedRemoteRefBytes keeps the old unconditional overwrite behavior', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-from-other-device\n');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-new\n');

    const result = await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.pushed).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(getRemoteText(remote, '.git/refs/heads/main')).toBe('commit-new\n');
  });
});

describe('object-count manifest (incomplete-listing detection)', () => {
  it('a push writes a manifest recording how many objects this device pushed', async () => {
    const remote = createFakeRemoteTransport();
    putLocalText(localFs, '/hidden-clone/.git/objects/aa/1234ab', 'blob one');
    putLocalText(localFs, '/hidden-clone/.git/objects/bb/5678cd', 'blob two');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-abc\n');

    await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(JSON.parse(getRemoteText(remote, '.git/objects.manifest')!)).toEqual({ objectCount: 2 });
  });

  it('a later push never lowers the manifest count, even from a device with fewer objects', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects.manifest', JSON.stringify({ objectCount: 1400 }));
    putLocalText(localFs, '/hidden-clone/.git/objects/aa/1234ab', 'blob one');
    putLocalText(localFs, '/hidden-clone/.git/refs/heads/main', 'commit-abc\n');

    await pushObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(JSON.parse(getRemoteText(remote, '.git/objects.manifest')!)).toEqual({ objectCount: 1400 });
  });

  it('pull reports complete:true when its listing meets or exceeds the manifest count', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/aa/1234ab', 'blob one');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc\n');
    putRemoteText(remote, '.git/objects.manifest', JSON.stringify({ objectCount: 1 }));

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.complete).toBe(true);
  });

  it('pull reports complete:false when its own listing sees fewer objects than the manifest promises — the Android/Google-Drive SAF truncation case', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/aa/1234ab', 'blob one');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc\n');
    // Some other, more complete device already saw 1400 objects and
    // recorded that floor — but this pull's own listing only turned up 1
    // (this fake remote only has one object seeded above), simulating a
    // transport that silently truncated a large directory listing.
    putRemoteText(remote, '.git/objects.manifest', JSON.stringify({ objectCount: 1400 }));

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.pulled).toBe(true); // still pulled what it could see — just flagged as untrustworthy
    expect(result.complete).toBe(false);
  });

  it('pull reports complete:true when there is no manifest to compare against — an older Sync Folder', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/aa/1234ab', 'blob one');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc\n');

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.complete).toBe(true);
  });
});
