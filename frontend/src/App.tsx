import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import RecipeDetail from "./pages/RecipeDetail";
import RecipeCreate from "./pages/RecipeCreate";
import RecipeImport from "./pages/RecipeImport";
import LibraryTools from "./pages/LibraryTools";
import LibraryIngredients from "./pages/LibraryIngredients";
import LibraryUnits from "./pages/LibraryUnits";
import LibraryTechniques from "./pages/LibraryTechniques";
import LibraryTags from "./pages/LibraryTags";
import LibrarySeasonality from "./pages/LibrarySeasonality";
import CollectionDetail from "./pages/CollectionDetail";
import Planner from "./pages/Planner";
import CookHistory from "./pages/CookHistory";
import ShoppingList from "./pages/ShoppingList";
import Account from "./pages/Account";
import ManageUsers from "./pages/ManageUsers";
import SyncHistory from "./pages/SyncHistory";
import Downloads from "./pages/Downloads";
import Login from "./pages/Login";
import ServerConnect from "./pages/ServerConnect";
import ProfilePicker from "./pages/ProfilePicker";
import { useStore } from "./store/app.store";
import { apiFetch, isNative, getServerUrl, cacheAccountOffline } from './lib/api';
import { isStandaloneMode, getActiveProfile } from './lib/standalone';
import { initLocalSchema } from './db/local';
import { startOfflineSyncWatcher } from './lib/offlineSync';

type AuthState =
  | { status: "loading" }
  | { status: "needs-auth"; hasAccount: boolean }
  | { status: "needs-profile" }
  | { status: "authenticated" };

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
    checkNativeReady();
  }, []);

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
      <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center">
        <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
      </div>
    );
  }

  if (auth.status === "needs-profile") {
    return <ProfilePicker onPicked={checkNativeReady} />;
  }

  if (auth.status === "needs-auth") {
    return (
      <Login
        hasAccount={auth.hasAccount}
        onAuthenticated={() => setAuth({ status: "authenticated" })}
      />
    );
  }

  return (
    <BrowserRouter>
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
      </Routes>
    </BrowserRouter>
  );
}
