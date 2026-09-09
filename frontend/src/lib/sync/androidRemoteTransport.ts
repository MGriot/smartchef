// ════════════════════════════════════════════════════════════════════════
// SmartChef — Android SafMirror-backed RemoteTransport (wayfinder ticket
// 01's transport interface, implemented for the platform gitObjectTransport.ts
// itself deliberately knows nothing about)
//
// gitObjectTransport.ts's own docstring flags this: pushObjectsAndRefs()
// calls remote.exists() unconditionally per object, correct everywhere but
// a real cost on a transport where existence checks are expensive — a SAF
// round-trip per object was exactly what the superseded androidMirror.ts's
// persisted knownPushedObjects cache existed to avoid. This implementation
// recreates that: once a .git/objects/** path is confirmed to exist
// remotely (or this device just wrote it), it's remembered in Preferences
// and never re-checked live — safe because objects are immutable and
// content-addressed. Ref/HEAD paths are NOT cached — they change on every
// commit, so exists() always checks them for real.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { SafMirror, type SafMirrorPlugin } from '../safMirrorBridge';
import { base64ToBytes, bytesToBase64 } from '../gitfs';
import type { RemoteTransport } from './gitObjectTransport';

const KNOWN_OBJECTS_KEY = 'smartchef.sync.knownRemoteObjects';

function isObjectPath(path: string): boolean {
  return path.startsWith('.git/objects/');
}

async function getKnownObjects(): Promise<Set<string>> {
  const { value } = await Preferences.get({ key: KNOWN_OBJECTS_KEY });
  return new Set(value ? (JSON.parse(value) as string[]) : []);
}

async function rememberKnownObject(path: string): Promise<void> {
  const known = await getKnownObjects();
  if (known.has(path)) return;
  known.add(path);
  await Preferences.set({ key: KNOWN_OBJECTS_KEY, value: JSON.stringify([...known]) });
}

export function createAndroidRemoteTransport(treeUri: string, plugin: SafMirrorPlugin = SafMirror): RemoteTransport {
  return {
    async exists(path) {
      if (isObjectPath(path) && (await getKnownObjects()).has(path)) return true;
      try {
        await plugin.readFile({ uri: treeUri, path });
        if (isObjectPath(path)) await rememberKnownObject(path);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(path) {
      const { data } = await plugin.readFile({ uri: treeUri, path });
      return base64ToBytes(data);
    },
    async writeFile(path, data) {
      await plugin.writeFile({ uri: treeUri, path, data: bytesToBase64(data) });
      if (isObjectPath(path)) await rememberKnownObject(path);
    },
    async listDir(path) {
      try {
        const { entries } = await plugin.list({ uri: treeUri, path });
        return entries.map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}
