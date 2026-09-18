---
Status: accepted
---

# The Setup File — carrying sync configuration to a second device, encrypted

**Context**: Setting up a second device means reproducing, by hand, what the first one already knows: the Sync Mode, the auto-sync interval and — in Git Remote mode (ADR 0004) — a repository URL, an optional username and an access token. The token is the problem. It is 40-plus characters of opaque base62 that cannot be shortened, guessed or retyped from memory, and the device it most often has to reach is a phone. The realistic ways a person gets it there today are all worse than the feature: emailing it to themselves, pasting it into a notes app that syncs to a cloud provider, or photographing a screen. Each leaves a write-capable credential lying around somewhere permanent, which is a strictly worse outcome than anything proposed here.

**Decision**: Export the portable half of a device's Folder Sync configuration as a single **Setup File**: AES-256-GCM, with the key derived by PBKDF2-HMAC-SHA256 (310,000 iterations, 16-byte random salt) from a passphrase the user chooses, wrapped in a SmartChef-specific container. A second device imports it from the first-run chooser or from Account → Folder Sync, types the passphrase once, and is configured.

The requirement as originally stated was that the file be decryptable *only by this application*. That splits into two properties which are worth keeping apart, because only one of them is security:

- **Only SmartChef can parse it.** The magic string (`smartchef.setup`), the version, and the KDF context string mixed into the derived key are ours. Nothing else knows the shape, and a generic PBKDF2 implementation given the right passphrase still derives the wrong key without the context string.
- **Only the passphrase-holder can read it.** This is the part that actually protects anything.

**What is deliberately not in the file**: the Sync Folder. In Folder mode that is a native handle — an absolute path on Windows, a Storage Access Framework tree URI on Android (`lib/syncFolderPicker.ts`) — and neither means anything on the other device. Carrying it would produce a device that believes it is configured and silently syncs nothing. The importing device picks its own folder, and both the import dialog and the first-run banner say so rather than letting the omission be discovered later.

**Implementation**:
- `frontend/src/lib/setupConfigFile.ts` is pure: payload in, encrypted text out, and back. No platform branching and no I/O, which is what lets it be unit-tested (`setupConfigFile.test.ts`, 16 cases) in a suite that runs on bare Node with no DOM — `crypto.subtle` is a global there, and is already load-bearing elsewhere in the app (`lib/localImages.ts`, `lib/sync/gitObjectTransport.ts`), so it is known-good on Chromium 114 in the Electron build and on Android's WebView.
- The header (`magic` + version) is passed to AES-GCM as **additional authenticated data**, so editing it invalidates the file rather than causing it to be read under the wrong rules.
- A wrong passphrase and a tampered file are genuinely indistinguishable to AES-GCM, and the error copy says exactly that instead of pretending to tell them apart.
- `frontend/src/lib/setupFileTransfer.ts` holds everything that touches the device: reading the current settings through `syncSettings.ts`, writing the file, and applying an imported one. Writing is the one genuinely three-way platform split in the app — Electron gets a real save dialog through a new `smartchef-save-file` IPC handler; **Android must write through `@capacitor/filesystem`**, because no `DownloadListener` is registered on the WebView (`MainActivity.java`) and the `Blob` + `<a download>` trick every other export in this app uses is a silent no-op there; the web build keeps the blob download, which is all a browser has.
- On import, the git-remote config is written *before* the mode is switched, so a sync cycle firing in between never observes "Git Remote mode, configured against nothing".

**Considered options**: a key compiled into the app, so a file opens with no passphrase (rejected — that key ships inside every APK and every Windows installer, so anyone who unpacks one can read every Setup File ever exported; it satisfies the letter of "only our application can decrypt it" while giving a leaked file no protection at all, and the file carries a credential with write access to the user's library); a QR code shown on one screen and scanned by the other (rejected for now — it avoids the file entirely and is genuinely nicer on a phone, but it needs a camera permission and a scanner dependency, and it does not help the desktop-to-desktop case; worth revisiting as a second transport for the same payload); shipping the sync folder path anyway and letting it fail on the other device (rejected, as above).

**Consequences**: A forgotten passphrase means re-exporting from the source device — there is no recovery path, by construction, and the export dialog says so at the point the passphrase is chosen. The format is versioned, and an unknown version is refused with a message telling the user to update rather than being parsed on a guess. The file is a real secret while it exists: it is not deleted automatically after import, because the common case is configuring several devices from one file, so it is the user's to delete when they are done.
