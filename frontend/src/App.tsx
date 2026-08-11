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
import CollectionDetail from "./pages/CollectionDetail";
import Planner from "./pages/Planner";
import ShoppingList from "./pages/ShoppingList";
import Account from "./pages/Account";
import Login from "./pages/Login";
import ServerConnect from "./pages/ServerConnect";
import { useStore } from "./store/app.store";
import { apiFetch, isNative, getServerUrl, cacheAccountOffline } from './lib/api';
import { startOfflineSyncWatcher } from './lib/offlineSync';

type AuthState =
  | { status: "loading" }
  | { status: "needs-auth"; hasAccount: boolean }
  | { status: "authenticated" };

export default function App() {
  const setAccount = useStore((s) => s.setAccount);
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  // Native only: is there a configured server to even talk to yet? On web
  // this stays `true` immediately — same-origin nginx proxying needs no
  // configuration, so the native-only connect screen never renders there.
  const [serverReady, setServerReady] = useState(!isNative());

  useEffect(() => {
    if (!isNative()) return;
    getServerUrl().then((url) => setServerReady(!!url));
  }, []);

  useEffect(() => {
    if (!serverReady) return;
    apiFetch("/api/auth/status")
      .then((res) => res.json())
      .then((json) => {
        const d = json.data;
        if (d.authenticated) {
          setAccount({ name: d.name, avatarUrl: d.avatarUrl });
          if (isNative()) cacheAccountOffline({ name: d.name, avatarUrl: d.avatarUrl });
          setAuth({ status: "authenticated" });
        } else {
          setAuth({ status: "needs-auth", hasAccount: d.hasAccount });
        }
      })
      .catch(() => setAuth({ status: "needs-auth", hasAccount: false }));
  }, [setAccount, serverReady]);

  useEffect(() => {
    if (auth.status === "authenticated") startOfflineSyncWatcher();
  }, [auth.status]);

  if (!serverReady) {
    return <ServerConnect onConnected={() => setServerReady(true)} />;
  }

  if (auth.status === "loading") {
    return (
      <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center">
        <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
      </div>
    );
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
        <Route path="/planner" element={<Planner />} />
        <Route path="/shopping" element={<ShoppingList />} />
        <Route path="/account" element={<Account />} />
      </Routes>
    </BrowserRouter>
  );
}
