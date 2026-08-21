Type: prototype
Status: resolved

## Question

Design and prototype the standalone account-creation flow: local storage is provisioned silently with a sensible per-platform default (no blocking prompt, per issue #4/ADR 0001), and a Sync Folder setup is offered but skippable (per issue #4), configurable later from Account settings if skipped. What does that offer actually look like — is it a step within the same onboarding screen as profile creation, a follow-up screen shown right after, or something else — what's the copy for "set up now" vs "skip," and does choosing "set up now" trigger the folder picker (Electron dialog / Android SAF) inline right there, or hand off elsewhere?

## Answer

Three structurally different variants were prototyped live at a throwaway route (`/prototype-account-creation`, mounted temporarily in `App.tsx`), matching `ServerConnect.tsx`'s real visual chrome:

- **A — Combined single screen**: the name field and an inline "Sync across your devices" card (Choose Folder / Skip for now) sit together in one form; both platforms get the same treatment.
- **B — Two-step wizard**: the name form submits immediately (profile + local storage provisioned right away, matching "no blocking prompt" from issue #4), then a dedicated follow-up screen offers the sync folder with a primary "Choose Folder" and a lighter "Skip — I'll do this later."
- **C — Deferred to Account**: creation stays exactly as minimal as it is today, no sync mention at all; a one-time dismissible nudge surfaces the option later, the first time the user lands in the app.

**Winner: Variant A.** Name entry and the (optional, clearly skippable) sync-folder offer both live on one screen — "Choose Folder" or "Skip for now," then "Start using SmartChef offline" submits either way. This also fixes an existing inconsistency in the real flow: today only Electron gets any sync prompt at all (a bare native OS dialog, no copy, triggered silently on submit — see `lib/standalone.ts`'s `initStandaloneProfile()`), while Android gets nothing until the user separately discovers "Change Folder" in Account. Variant A's inline card is the same on both platforms — Electron's "Choose Folder" opens the native dialog, Android's opens the SAF tree picker — with actual explanatory copy either way, rather than the current asymmetric behavior.

Prototype captured on throwaway branch `prototype/account-creation-flow` (commit `e1ea87b`), not merged to main. Folding Variant A into `ServerConnect.tsx`/`lib/standalone.ts` (including giving Android the same inline offer Electron already has, just via SAF instead of a native dialog) is implementation work for later, out of scope for this decision-only wayfinder ticket.
