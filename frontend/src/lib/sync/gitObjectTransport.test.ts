import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeLocalFs, putLocalText, getLocalText, createFakeRemoteTransport, putRemoteText, getRemoteText } from './testUtils/fakes';
import { pushObjectsAndRefs, pullObjectsAndRefs } from './gitObjectTransport';

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
    expect(result).toEqual({ pulled: false, objectsFetched: 0, fetchedObjectPaths: [] });
  });

  it('fetches remote objects and refs/HEAD into the local Hidden Clone', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/ab/cdef01', 'object-bytes');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');
    putRemoteText(remote, '.git/HEAD', 'ref: refs/heads/main\n');

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.pulled).toBe(true);
    expect(result.objectsFetched).toBe(1);
    expect(getLocalText(localFs, '/hidden-clone/.git/objects/ab/cdef01')).toBe('object-bytes');
    expect(getLocalText(localFs, '/hidden-clone/.git/refs/heads/main')).toBe('commit-abc123\n');
    expect(getLocalText(localFs, '/hidden-clone/.git/HEAD')).toBe('ref: refs/heads/main\n');
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

  it('fetches objects before writing refs/HEAD — call order, not just end state', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/objects/ab/cdef01', 'object-bytes');
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');
    const writeSpy = vi.spyOn(localFs.promises, 'writeFile');

    await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    const paths = writeSpy.mock.calls.map((call) => call[0]);
    const objectIndex = paths.indexOf('/hidden-clone/.git/objects/ab/cdef01');
    const refIndex = paths.indexOf('/hidden-clone/.git/refs/heads/main');
    expect(objectIndex).toBeGreaterThanOrEqual(0);
    expect(objectIndex).toBeLessThan(refIndex);
  });

  it('tolerates a missing remote HEAD file — refs/heads/main is what matters', async () => {
    const remote = createFakeRemoteTransport();
    putRemoteText(remote, '.git/refs/heads/main', 'commit-abc123\n');
    // no .git/HEAD on the remote at all

    const result = await pullObjectsAndRefs(localFs.promises, '/hidden-clone', remote);

    expect(result.pulled).toBe(true);
    expect(getLocalText(localFs, '/hidden-clone/.git/refs/heads/main')).toBe('commit-abc123\n');
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
    expect(getLocalText(deviceB, '/hidden-clone/.git/refs/heads/main')).toBe('commit-aa1234\n');
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
