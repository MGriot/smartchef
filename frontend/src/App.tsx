import { useEffect, useState, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Login from "./pages/Login";
import ServerConnect from "./pages/ServerConnect";
import ProfilePicker from "./pages/ProfilePicker";
// ── Routes are code-split ────────────────────────────────────────────────
// Every page used to be a static import, so the main bundle carried all of
// them plus everything they pull in — most expensively lib/worldGeo.ts,
// whose 739KB of country boundaries were parsed at startup whether or not a
// map was ever opened.
//
// The three screens below stay eager: they are what renders before anything
// else, and lazy-loading them would only add a blank frame to the first
// paint.
const Home = lazy(() => import("./pages/Home"));
const RecipeDetail = lazy(() => import("./pages/RecipeDetail"));
const RecipeCreate = lazy(() => import("./pages/RecipeCreate"));
const RecipeImport = lazy(() => import("./pages/RecipeImport"));
const LibraryTools = lazy(() => import("./pages/LibraryTools"));
const LibraryIngredients = lazy(() => import("./pages/LibraryIngredients"));
const LibraryUnits = lazy(() => import("./pages/LibraryUnits"));
const LibraryTechniques = lazy(() => import("./pages/LibraryTechniques"));
const LibraryTags = lazy(() => import("./pages/LibraryTags"));
const LibrarySeasonality = lazy(() => import("./pages/LibrarySeasonality"));
const CollectionDetail = lazy(() => import("./pages/CollectionDetail"));
const Planner = lazy(() => import("./pages/Planner"));
const CookHistory = lazy(() => import("./pages/CookHistory"));
const ShoppingList = lazy(() => import("./pages/ShoppingList"));
const Account = lazy(() => import("./pages/Account"));
const ManageUsers = lazy(() => import("./pages/ManageUsers"));
const SyncHistory = lazy(() => import("./pages/SyncHistory"));
const Downloads = lazy(() => import("./pages/Downloads"));
const Atlas = lazy(() => import("./pages/Atlas"));
const Pantry = lazy(() => import("./pages/Pantry"));

import { useStore } from "./store/app.store";
import { apiFetch, isNative, getServerUrl, cacheAccountOffline, isDeviceOnboarded, markDeviceOnboarded, resetDeviceStorageChoice } from './lib/api';
import { isStandaloneMode, getActiveProfile } from './lib/standalone';
import { initLocalSchema } from './db/local';
import { startOfflineSyncWatcher } from './lib/offlineSync';

type AuthState =
  | { status: "loading" }
  | { status: "needs-auth"; hasAccount: boolean }
  | { status: "needs-profile" }
  | { status: "authenticated" };

/** Where this device is in the "which storage does it use" question.
 *
 *  This used to be a boolean (`serverReady`) initialised to `!isNative()`,
 *  which meant every native launch started out indistinguishable from a
 *  device that had never been set up — and since `!serverReady` renders
 *  ServerConnect, the FIRST-RUN STORAGE CHOOSER was what the app showed
 *  while it was still booting. On a cold boot the async work below (a
 *  Preferences read, then initLocalSchema() opening a multi-megabyte SQLite
 *  file and PRAGMA-checking every column) takes seconds, so a returning
 *  user watched their configured app ask them to choose local-or-server
 *  again. Worse, clicking through it calls initStandaloneProfile(), which
 *  mints a BRAND-NEW profile rather than reusing the existing one — real
 *  damage, not just a confusing frame (five duplicate profiles in one
 *  install before this was found).
 *
 *  So "we don't know yet" is now its own state, distinct from "we know this
 *  device needs setting up", and only the latter is allowed to render the
 *  chooser. */
type SetupState = "unknown" | "needs-setup" | "ready";

/** Runs `fn` once the first screen has had a chance to paint.
 *
 *  `requestIdleCallback` is the right tool and is what this uses when it
 *  exists — but the app's Electron target is Chromium 114 in a WebView and
 *  Android's WebView version is whatever the device shipped, so the timeout
 *  fallback is not dead code. The idle deadline is capped so a device that
 *  never goes idle (a slow first sync, a busy render) still gets there. */
function afterFirstPaint(fn: () => void): void {
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(fn, { timeout: 3000 });
  else setTimeout(fn, 1200);
}

/** Shown while a route's chunk loads. Deliberately the same spinner as the
 *  boot state, so a cold navigation looks like the app starting rather than
 *  like something broke. */
function RouteFallback() {
  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center">
      <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
    </div>
  );
}

/** Startup failed for a reason that is not "this device isn't set up yet" —
 *  a local database that won't open, a Preferences read that threw. The one
 *  thing this must not do is offer to reconfigure storage: the device's
 *  choice is intact, the data is intact, and re-running first-run setup
 *  would create a duplicate profile on top of a transient failure. Retry
 *  re-runs exactly the same check. */
function BootErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white dark:bg-zinc-900 rounded-[32px] p-8 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
        <span className="material-symbols-outlined text-4xl text-amber-500">database_off</span>
        <h1 className="mt-4 text-2xl font-black text-zinc-900 dark:text-zinc-100 tracking-tighter">
          {t('boot.title')}
        </h1>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
          {t('boot.hint')}
        </p>
        <p className="mt-4 text-xs font-mono text-left bg-zinc-50 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-400 rounded-2xl p-3 break-words">
          {message}
        </p>
        <button
          onClick={onRetry}
          className="mt-6 w-full py-3 rounded-2xl bg-primary text-white font-bold text-sm"
        >
          {t('common.tryAgain')}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const setAccount = useStore((s) => s.setAccount);
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  // Native only: is there a configured server (or a standalone profile) to
  // even talk to yet? On web this is "ready" immediately — same-origin
  // nginx proxying needs no configuration, so the native-only connect
  // screen never renders there.
  const [setup, setSetup] = useState<SetupState>(isNative() ? "unknown" : "ready");
  // A failure inside checkNativeReady() — a local schema that won't open, a
  // Preferences read that throws. Previously this chain had no error
  // handling at all, so any rejection left the app parked on the storage
  // chooser forever, which reads as "the app forgot everything" when the
  // truth is "the database didn't open". Show what actually happened.
  const [bootError, setBootError] = useState<string | null>(null);
  // Standalone mode has no server at all — set once we know there's a
  // local profile, so the auth-status network call below is skipped
  // entirely rather than failing against a server that doesn't exist.
  const [standalone, setStandalone] = useState(false);
  // Whether anyone has ever signed in on this device. While false, the
  // login/profile screens offer a way back to the storage chooser — see
  // isDeviceOnboarded() in lib/api.ts for why it stops after that.
  const [onboarded, setOnboarded] = useState(true);

  const checkNativeReady = () => {
    setBootError(null);
    // One linear async body with a single catch, rather than the nested
    // .then() chain this used to be: every level of that chain was an
    // unhandled rejection waiting to happen, and none of them ever moved
    // the setup state, so a throw anywhere in here left the storage
    // chooser on screen permanently with no indication anything failed.
    void (async () => {
      try {
        if (!(await isStandaloneMode())) {
          const url = await getServerUrl();
          setSetup(url ? "ready" : "needs-setup");
          return;
        }
        // First-run (ServerConnect.tsx) / a profile pick only ever calls
        // initLocalSchema() once, at that moment — a device that's had
        // standalone mode enabled since before some later app version added
        // new columns/tables would otherwise never pick up their
        // addColumnIfMissing() backfills, and every write touching a newer
        // field would throw "no such column" on this device forever.
        // Re-running it here on every launch is cheap (CREATE TABLE IF NOT
        // EXISTS + a PRAGMA table_info check per column) and keeps existing
        // devices' schemas current.
        await initLocalSchema();
        setStandalone(true);
        setSetup("ready");
        const profile = await getActiveProfile();
        if (!profile) {
          // Standalone-enabled but nobody's picked a profile on this
          // device yet — either freshly switched, or this device just
          // joined an existing Sync Folder and pulled in profiles other
          // devices already created.
          setAuth({ status: "needs-profile" });
          return;
        }
        // The profile's OWN role, not a hardcoded "user". getActiveProfile()
        // has always returned it (lib/standalone.ts) and profiles.local.ts
        // makes the first profile in a library an admin — but flattening it
        // to "user" here meant `account.role` was never 'admin' in standalone
        // mode, so every surface gated on it silently rendered nothing. The
        // visible casualty was Account.tsx's StorageModeCard ("Where your
        // library lives"), i.e. the switch between offline and a server: it
        // was there the whole time and no standalone device could see it.
        setAccount({ id: profile.id, username: profile.name, name: profile.name, role: profile.role ?? "user", avatarUrl: profile.avatarUrl });
        setAuth({ status: "authenticated" });
      } catch (err) {
        console.error("SmartChef: startup check failed:", err);
        setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  useEffect(() => {
    if (!isNative()) return;
    isDeviceOnboarded().then(setOnboarded);
    checkNativeReady();
  }, []);

  // Latched, never un-latched: reaching an authenticated state once is what
  // "this device is set up" means.
  useEffect(() => {
    if (auth.status !== 'authenticated' || !isNative()) return;
    markDeviceOnboarded().then(() => setOnboarded(true));
  }, [auth.status]);

  /** First-run escape hatch on the login/profile screens: forget this
   *  device's storage choice (not its data) and show the chooser again. */
  const handleChangeStorage = async () => {
    await resetDeviceStorageChoice();
    setStandalone(false);
    setAuth({ status: 'loading' });
    setBootError(null);
    setSetup('needs-setup');
  };

  useEffect(() => {
    if (setup !== "ready" || standalone) return;
    apiFetch("/api/auth/status")
      .then((res) => res.json())
      .then((json) => {
        const d = json.data;
        if (d.authenticated) {
          const account = { id: d.id, username: d.username, name: d.name, role: d.role, avatarUrl: d.avatarUrl };
          setAccount(account);
          if (isNative()) cacheAccountOffline(account);
          setAuth({ status: "authenticated" });
        } else {
          setAuth({ status: "needs-auth", hasAccount: d.hasAccount });
        }
      })
      .catch(() => setAuth({ status: "needs-auth", hasAccount: false }));
  }, [setAccount, setup]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (standalone) {
      // No server to sync against in standalone mode — instead, the
      // folder-sync watcher reconciles this device's local SQLite data
      // against its sync folder (Electron: user-chosen, kept in sync by an
      // OS-level cloud client; Android: private storage, mirrored to a
      // user-picked SAF tree by SafMirrorPlugin — see lib/sync/gitSync.ts).
      //
      // Deliberately deferred rather than started inline. Both of these do
      // real work on the same thread that renders the first screen, and both
      // queue against db/local.ts's single SQLite mutex — so starting them
      // here used to mean the very first gallery load raced a full sync
      // cycle for the bridge and the database at once. A beat of delay costs
      // nothing (the sync interval is measured in minutes) and hands the
      // first paint an uncontended thread.
      afterFirstPaint(() => {
        import('./lib/sync/gitSync').then(({ startFolderSyncWatcher }) => startFolderSyncWatcher());
        // One-time, self-skipping once there is nothing left inline: moves
        // images that were base64-encoded into database columns (by an older
        // backup restore) into the content-addressed store. See
        // lib/inlineImageMigration.ts for why that matters so much more on
        // Android than on desktop.
        import('./lib/inlineImageMigration').then(({ migrateInlineImagesIfNeeded }) => migrateInlineImagesIfNeeded());
      });
    } else {
      startOfflineSyncWatcher();
    }
  }, [auth.status, standalone]);

  // Order matters: an unresolved boot must NEVER fall through to
  // ServerConnect — that screen is the first-run storage chooser, and
  // showing it to an already-configured device is what made a slow cold
  // boot look like the app had forgotten its settings.
  if (bootError) {
    return <BootErrorScreen message={bootError} onRetry={checkNativeReady} />;
  }

  if (setup === "unknown") {
    return (
      <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center">
        <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
      </div>
    );
  }

  if (setup === "needs-setup") {
    return <ServerConnect onConnected={checkNativeReady} />;
  }

  if (auth.status === "loading") {
    return (
      <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center">
        <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
      </div>
    );
  }

  if (auth.status === "needs-profile") {
    return (
      <ProfilePicker
        onPicked={checkNativeReady}
        onChangeStorage={isNative() && !onboarded ? handleChangeStorage : undefined}
      />
    );
  }

  if (auth.status === "needs-auth") {
    return (
      <Login
        hasAccount={auth.hasAccount}
        onAuthenticated={() => setAuth({ status: "authenticated" })}
        onChangeStorage={isNative() && !onboarded ? handleChangeStorage : undefined}
      />
    );
  }

  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/recipe/new" element={<RecipeCreate />} />
        <Route path="/recipe/:id" element={<RecipeDetail />} />
        <Route path="/collection/:id" element={<CollectionDetail />} />
        <Route path="/import" element={<RecipeImport />} />
        <Route path="/library/tools" element={<LibraryTools />} />
        <Route path="/library/ingredients" element={<LibraryIngredients />} />
        <Route path="/library/units" element={<LibraryUnits />} />
        <Route path="/library/techniques" element={<LibraryTechniques />} />
        <Route path="/library/tags" element={<LibraryTags />} />
        <Route path="/library/seasonality" element={<LibrarySeasonality />} />
        <Route path="/planner" element={<Planner />} />
        <Route path="/history" element={<CookHistory />} />
        <Route path="/shopping" element={<ShoppingList />} />
        <Route path="/account" element={<Account />} />
        <Route path="/manage-users" element={<ManageUsers />} />
        <Route path="/sync-history" element={<SyncHistory />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/atlas" element={<Atlas />} />
        <Route path="/pantry" element={<Pantry />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
