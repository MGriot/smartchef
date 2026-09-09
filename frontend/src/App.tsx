import { useEffect, useState, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
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

export default function App() {
  const setAccount = useStore((s) => s.setAccount);
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  // Native only: is there a configured server (or a standalone profile) to
  // even talk to yet? On web this stays `true` immediately — same-origin
  // nginx proxying needs no configuration, so the native-only connect
  // screen never renders there.
  const [serverReady, setServerReady] = useState(!isNative());
  // Standalone mode has no server at all — set once we know there's a
  // local profile, so the auth-status network call below is skipped
  // entirely rather than failing against a server that doesn't exist.
  const [standalone, setStandalone] = useState(false);
  // Whether anyone has ever signed in on this device. While false, the
  // login/profile screens offer a way back to the storage chooser — see
  // isDeviceOnboarded() in lib/api.ts for why it stops after that.
  const [onboarded, setOnboarded] = useState(true);

  const checkNativeReady = () => {
    isStandaloneMode().then((standaloneEnabled) => {
      if (!standaloneEnabled) {
        getServerUrl().then((url) => setServerReady(!!url));
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
      initLocalSchema().then(() => {
        setStandalone(true);
        setServerReady(true);
        getActiveProfile().then((profile) => {
          if (!profile) {
            // Standalone-enabled but nobody's picked a profile on this
            // device yet — either freshly switched, or this device just
            // joined an existing Sync Folder and pulled in profiles other
            // devices already created.
            setAuth({ status: "needs-profile" });
            return;
          }
          setAccount({ id: profile.id, username: profile.name, name: profile.name, role: "user", avatarUrl: profile.avatarUrl });
          setAuth({ status: "authenticated" });
        });
      });
    });
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
    setServerReady(false);
  };

  useEffect(() => {
    if (!serverReady || standalone) return;
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
  }, [setAccount, serverReady]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (standalone) {
      // No server to sync against in standalone mode — instead, the
      // folder-sync watcher reconciles this device's local SQLite data
      // against its sync folder (Electron: user-chosen, kept in sync by an
      // OS-level cloud client; Android: private storage, mirrored to a
      // user-picked SAF tree by SafMirrorPlugin — see lib/sync/gitSync.ts).
      import('./lib/sync/gitSync').then(({ startFolderSyncWatcher }) => startFolderSyncWatcher());
    } else {
      startOfflineSyncWatcher();
    }
  }, [auth.status, standalone]);

  if (!serverReady) {
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
