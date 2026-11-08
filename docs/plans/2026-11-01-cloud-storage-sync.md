# Cloud-storage sync: Google Drive, OneDrive, Dropbox, WebDAV

*Study, 2026-11-01. No code changed.*

**Question.** Can SmartChef sync through Google Drive, OneDrive, Dropbox or WebDAV/Nextcloud, the way it syncs through GitHub/GitLab today?

**Answer.** Yes. The sync engine already talks to "a place that stores files" through a four-method interface, and that is all a cloud drive is. The recommended route is one small adapter per provider behind that interface, keeping git as the on-disk format. Merge, conflicts, history, backups and images stay as they are. The real new work is **OAuth sign-in** (none exists in the app today) and **fewer, larger uploads** (today's folder format is thousands of tiny files).

---

## 1. How sync works today

| Layer | What it is | Where |
|---|---|---|
| Live data | SQLite on each device; every screen reads it | `src/db/local.ts`, `src/services/*.local.ts` via `localRouter.ts` |
| Hidden Clone | A private git repo per device; one JSON file per entity (`recipes/<id>.json`, `units/…`, `images/<sha256>.<ext>`) | `src/lib/sync/hiddenClone.ts`, `writeEntityFile()` in `gitSync.ts` |
| Shared copy | Where devices meet: a **folder** or a **git server** | `gitObjectTransport.ts` / `gitRemoteTransport.ts` |

- **Saving** writes the entity file and schedules a debounced local commit. Nothing goes over the network on save.
- **A sync** (`syncNow`) runs at start-up, on a timer (default 5 min), on app resume and on "Sync now". The steps are pull, merge, push, with up to 3 retries.
- **Merging is field by field, in plain code** (`src/lib/structuredMerge.ts`, `mergeNormalize.ts`). Git supplies only the history: `mergeBridge.ts` calls `findMergeBase`, `listFiles` and `readBlob` to get the base, local and remote JSON of every entity. Merges are real two-parent commits (ADR 0006), so the next merge base is always the last agreed state.
- **Deletes are tombstones** (`sync_status='deleted'` / `deleted_at`). A file missing on the other side is never read as a delete.
- **Images are content-addressed**, so they never conflict.

**The two transports**

- **Folder mode** (default). isomorphic-git can only fetch and push over HTTP, so `gitObjectTransport.ts` copies git's own files (loose objects plus the `refs/heads/main` ref) to and from a folder. It reaches the folder through:

  ```ts
  interface RemoteTransport {           // gitObjectTransport.ts:36
    exists(path): Promise<boolean>;
    readFile(path): Promise<Uint8Array>;
    writeFile(path, data): Promise<void>;
    listDir(path): Promise<string[]>;
  }
  ```

  Two implementations exist, and both are tiny: `electronRemoteTransport.ts` (59 lines) and `androidRemoteTransport.ts` (70 lines, over the native `SafMirrorPlugin`).
  - **Push:** the ref is checked, written, then **read back**. `gitObjectTransport.ts:331` notes that "a plain folder has no atomic compare-and-swap"; the read-back catches a writer that landed just after.
  - **Incomplete listings:** these are detected with a high-water mark in `.git/objects.manifest`. When one is detected, the device catches up from a single-file `.git/sync.bundle` instead (`gitBundleTransport.ts`).
- **Git-remote mode.** This uses `git.fetch` / `git.push` over smart-HTTP, with a personal access token as HTTP Basic auth.
  - Push is plain (not forced), so the server rejects anything that isn't a fast-forward, and the loop re-merges.
  - All HTTP goes through `nativeHttpClient.ts`: Electron `net.fetch` in the main process, Android `GitHttpPlugin.java`. So **CORS is not a concern** for any provider API either.

## 2. What already works, and the gap

- **Windows / Electron: works today.** Point folder mode at a folder that the OneDrive, Dropbox or Google Drive desktop client syncs. The read-back and bundle fallback were built for exactly this kind of slow, eventually-consistent folder.
- **Android: this is the gap.** Folder mode on Android needs a folder picked through the Storage Access Framework (`ACTION_OPEN_DOCUMENT_TREE`). Cloud apps mostly don't offer whole folders that way:
  - **Google Drive:** does not implement tree access. Only single files can be picked ([Stack Overflow answer][so-drive-tree], [Cryptomator forum][cryptomator]).
  - **Dropbox:** reportedly doesn't implement the document intents at all ([Dropbox forum][dbx-saf]).
  - **OneDrive:** no reliable source either way. Treat it as unsupported.
  - **Nextcloud:** reportedly does support tree access. Unconfirmed, and it only helps Nextcloud users.

  **So on a phone, the only working option today is a git server (GitHub/GitLab).** A cloud drive on Android needs the app to call the provider's web API itself.

## 3. Recommended: cloud adapters behind `RemoteTransport`

Write one `RemoteTransport` per provider that calls its REST API through `nativeHttpClient`. Everything above the interface is reused unchanged: merge, conflicts UI, history, `refs/backups`, "Replace from synced data", images, the Setup File.

**Why this fits well**

- **Every file except the ref is write-once.** Git objects, packs and images are named by their own hash, so two devices writing the same name write the same bytes. A blind "create or overwrite" is safe for all of them.
- **Only one file needs a guarded write: `refs/heads/main`** (41 bytes). Where a provider offers a conditional write, the adapter can make the push truly atomic, which is better than today's folder. Where it doesn't, the existing read-back still applies, so the adapter is no worse than a Syncthing folder.

**Proposed interface change.** Make it additive and optional, so the folder transports stay as they are:

```ts
interface RemoteTransport {
  …existing four…
  /** Optional: write only if the file is still at `version` (null = must not exist).
   *  Returns the new version, or 'conflict'. */
  writeFileIfMatch?(path: string, data: Uint8Array, version: string | null): Promise<string | 'conflict'>;
  readFileWithVersion?(path: string): Promise<{ data: Uint8Array; version: string } | null>;
}
```

`pushObjectsAndRefs()` uses these for the ref when they exist, and otherwise keeps its check / write / read-back.

**The main cost is request count, not code**

- A pull lists `.git/objects`, then each of up to **256** `xx/` sub-folders (`gitObjectTransport.ts:404-408`). Then it downloads each new loose object as its own file.
- On a cloud API that is hundreds of HTTP calls per sync, and thousands on the first one. Every provider rate-limits that.
- **Fix: in cloud mode, push one pack per sync.**
  - Upload `packs/<sha1>.pack` plus `.idx` (content-named, so write-once) and update the ref.
  - Pullers list one folder and fetch only packs they don't have.
  - The building blocks exist: `gitPacking.ts` already packs, and `gitBundleTransport.ts` already imports a pack by its own SHA-1. Today, though, the bundle is a **fallback that covers only loose objects** (see its header comment). Making it the primary path is new work.
  - Packs accumulate. Rewrite one full pack occasionally (the `REWRITE_GROWTH_RATIO` idea already in `gitBundleTransport.ts`).

## 4. Considered and not recommended: plain JSON files without git

Store `recipes/<id>.json` directly in the drive, readable in the provider's web UI. Keep a local copy of each file as last agreed (plus its etag/rev) to serve as the merge base, and use provider change tokens to find what changed.

- **What it gains:** files a person can read; possibly fewer calls for small edits.
- **What it costs:**
  - It loses commit history, the History screen, `refs/backups` and "Replace from synced data".
  - It needs a second sync loop next to `gitSync.ts` (1,331 lines).
  - It has to rebuild a per-file merge base that git gives for free.
  - Every per-file write needs a conditional update, not just one ref.
- The backend's `folder-sync.service.ts` (per-device snapshot, last-write-wins by `updatedAt`) shows the simple version of this idea. It is weaker than today's field-level three-way merge.
- **Verdict:** several times the work for a worse merge. Revisit only if "readable files in my Drive" becomes a requirement in its own right.

## 5. Work every provider needs

1. **OAuth 2 with PKCE.** There is no OAuth in the app today; the only matches for "OAuth" reject pasted Google tokens.
   - *Electron:* open the system browser (`shell.openExternal`, already used in `setup.ts`) and receive the redirect on a loopback `http://127.0.0.1:<port>` listener in the main process. This avoids registering a protocol.
     - The `deepLinkingEnabled` block in `electron/src/index.ts:30` is unused template code.
     - The `second-instance` handler (`index.ts:62`) only focuses the window and ignores argv, so a protocol URL would be lost. That is another reason to prefer loopback.
   - *Android:* `AndroidManifest.xml` has only the MAIN/LAUNCHER filter. Add a VIEW/BROWSABLE intent filter for a custom scheme (e.g. `com.smartchef.app:/oauth`) and open the consent page with `@capacitor/browser` (Custom Tabs). Google and Microsoft both accept this for installed apps.
2. **Token refresh.** Access tokens last about an hour; refresh before each sync and on a 401.
3. **Token storage.** Refresh tokens are long-lived, unlike a PAT the user can revoke at a glance. Today the PAT sits in plain `@capacitor/preferences`: renderer localStorage on Electron, SharedPreferences on Android (`syncSettings.ts:29-37`). Move the cloud tokens to Electron `safeStorage` and the Android Keystore. Do the same for the git PAT while at it.
4. **App registrations.** One OAuth client per provider: Google Cloud project, Microsoft Entra app, Dropbox app. The client IDs ship in the app. With PKCE they are public, so no secret is embedded. This matters for the F-Droid build, which must not need a secret.
5. **Setup File** (`setupConfigFile.ts`). It should carry the provider and folder, **not** the refresh token. Each device signs in once. That is simpler and safer than moving a long-lived token around.
6. **Settings UI.** Add a third choice next to *Folder* and *Git server* on Account → Folder Sync, and on first-run `ServerConnect.tsx`: **Cloud drive**, followed by a provider picker, sign in, and "use/create the SmartChef folder".

## 6. Provider matrix

| | WebDAV / Nextcloud | Dropbox | OneDrive | Google Drive |
|---|---|---|---|---|
| **Sign-in** | URL + app password (no OAuth) | OAuth 2 PKCE | OAuth 2 PKCE (Microsoft Entra) | OAuth 2 PKCE |
| **Addressing** | Paths | Paths | Paths (`/me/drive/special/approot:/path`) | **IDs only**: a name can repeat in a folder, so the adapter keeps a path → id map |
| **Guarded ref write** | `PUT` with `If-Match: <etag>` → 412 on mismatch. The server may not return the new ETag, so re-read it. [nc][nc-ifmatch] | `files/upload` `mode: update` + `rev` → 409 conflict (with `autorename:false`) [dbx][dbx-rev] | `If-Match` documented on update and `createUploadSession` → 412. **Not documented for simple `PUT /content`**: test, or use an upload session for the ref. [ms][ms-session] | **No ETag in v3**; If-Match on v3 is unconfirmed. Fall back to the read-back, or compare `version` / `md5Checksum` [so][so-drive-etag] |
| **Listing** | `PROPFIND Depth:1` | `list_folder` + cursor | `children` + `@odata.nextLink`; `delta` | `files.list q='<parent>' in parents` |
| **Scope / review** | n/a | App folder (`Apps/SmartChef`), no review for personal use | `Files.ReadWrite.AppFolder`, no admin consent | `drive.file` is **non-sensitive, no security assessment**; `drive` / `drive.readonly` are restricted and need verification [google][g-scopes]. With `drive.file` the app sees only files it created, which is fine for its own sync folder. |
| **Who gets it** | Nextcloud, ownCloud, Koofr, pCloud, many NAS (Synology, QNAP), Box | Dropbox users | Windows / Microsoft 365 users | Most Android users |
| **Risk** | Server quirks (ETag handling, chunked upload) | Low | Medium (conflict defaults differ between simple PUT and upload session) | Highest (IDs, no ETag, Google consent screen) |
| **Adapter effort** | ~1–2 days | ~2 days | ~3 days | ~4–5 days |

**Suggested order:**
1. **WebDAV:** no OAuth, so it proves the adapter and pack path in isolation.
2. **Dropbox:** the cleanest conditional write.
3. **OneDrive.**
4. **Google Drive.**

If Android users matter most, Google Drive is worth the extra work, but only after the shared OAuth and pack work exists.

## 7. Phased plan

Estimates are for one developer who knows the codebase, and include tests in the style of `gitObjectTransport.test.ts` and `twoDevice.sync.integration.test.ts`.

| Phase | Scope | Estimate |
|---|---|---|
| **0. Pack-first remote format** | Optional `writeFileIfMatch` / `readFileWithVersion` on `RemoteTransport`; atomic ref push when available; one pack per push plus a pack-list pull for a "cloud" flavour of folder mode; periodic full repack. Two-device integration test over a fake HTTP drive. | 4–6 days |
| **1. WebDAV adapter + UI** | `webdavRemoteTransport.ts`; the "Cloud drive" choice in Account and first run; connection test (like `remoteAccessProbe.ts`); Setup File field. Ship. | 3–4 days |
| **2. OAuth + secure token storage** | PKCE flow (Electron loopback, Android intent filter + Custom Tabs); refresh; `safeStorage` / Keystore storage, PAT included; sign-out. | 4–5 days |
| **3. Dropbox** | Adapter (app folder, `rev` updates) + registration. Ship. | 2–3 days |
| **4. OneDrive** | Adapter (approot, eTag via upload session) + Entra app. Ship. | 3 days |
| **5. Google Drive** | Adapter with path → id cache, duplicate-name handling, `drive.file`; consent-screen setup. Ship. | 5–6 days |
| | **Total** | **≈ 4–5 weeks** |

**Risks**
- **Rate limits** on a first sync of a large library: pack-first (phase 0) is the mitigation. Add back-off on 429 / `Retry-After` in `nativeHttpClient`.
- **Eventually consistent listings** (Drive, OneDrive): already handled by the manifest high-water mark and the catch-up bundle. Keep both in cloud mode.
- **Quota.** Full-resolution images are the bulk. They are already deduplicated by hash. Consider a "sync images" toggle.
- **Review and policy.** Google's consent screen in "testing" mode is limited to 100 users until verified; `drive.file` keeps verification light. Microsoft personal accounts need no admin consent for app-folder scope.
- **F-Droid.** Bundling proprietary-cloud client IDs may need declaring under the existing `NonFreeNet` anti-feature. WebDAV has no such issue.

---

### Sources

- Microsoft Graph, [driveItem: createUploadSession][ms-session] (`if-match` → 412) and [Upload or replace contents (PUT /content)][ms-put] (`@microsoft.graph.conflictBehavior`)
- Dropbox forum, [rev / update mode and conflicts][dbx-rev]; [Dropbox and ACTION_OPEN_DOCUMENT][dbx-saf]
- Google, [Choose Google Drive API scopes][g-scopes]
- Stack Overflow (archived), [Drive does not support ACTION_OPEN_DOCUMENT_TREE][so-drive-tree]; [Drive file ETag in v3][so-drive-etag]
- Cryptomator community, [tree-intent support by cloud apps][cryptomator]
- Nextcloud desktop, [If-Match on PUT (PR 10394)][nc-ifmatch]

[ms-session]: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
[ms-put]: https://learn.microsoft.com/onedrive/developer/rest-api/api/driveitem_put_content
[dbx-rev]: https://www.dropboxforum.com/discussions/101000042/handling-of-local-and-remote-rev-differences/397757
[dbx-saf]: https://www.dropboxforum.com/discussions/101000042/why-using-intent-action-open-document-does-not-list-the-dropbox/209654
[g-scopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[so-drive-tree]: https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/a/59390835
[so-drive-etag]: https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/41307155/google-drive-file-etag-in-v3
[cryptomator]: https://community.cryptomator.org/t/cryptomator-not-usable-without-webdav-or-not-listed-cloud-storages/11933/16
[nc-ifmatch]: https://github.com/nextcloud/desktop/pull/10394
