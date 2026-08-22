# 🍳 SmartChef Ecosystem

> **Offline-first, self-hosted recipe management** — nested recipes, dynamic portions, local AI import, multi-device sync, and a native Android app.

---

## 📋 Table of Contents

- [How to start the app](#-how-to-start-the-app)
  - [Option 1 — Docker (recommended)](#-option-1--docker-recommended)
  - [Option 2 — Local, without Docker](#-option-2--local-without-docker)
- [Checking it works](#-checking-it-works)
- [Admin Access](#-admin-access)
- [Common problems](#️-common-problems)
- [Project structure](#️-project-structure)
- [MCP Server](#-mcp-server)
- [API Routes](#-api-routes)
- [Matrioska Engine](#-matrioska-engine)
- [Multi-device sync](#-multi-device-sync)
- [Standalone Mode (Windows & Android, No Server)](#-standalone-mode-windows--android-no-server)
- [Mobile App (Android) & Remote Access via Tailscale](#-mobile-app-android--remote-access-via-tailscale)
- [Running Compose commands from any folder](#-running-compose-commands-from-any-folder)
- [Implementation status](#️-implementation-status)

---

## 🚀 How to start the app

### 🐳 Option 1 — Docker (recommended)

**Prerequisites:**
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running (or Podman — see below)

```bash
# 1. Enter the project folder
cd smartchef

# 2. Copy the config file
cp docker/.env.example docker/.env

# 3. Start every service (DB + Backend + Frontend + Ollama)
cd docker
docker compose up -d

# 4. Check everything came up correctly
docker compose ps
```

After ~30 seconds, open in your browser:

| Service         | URL                          |
|-----------------|-------------------------------|
| **App (UI)**    | http://localhost:8080        |
| **Backend API** | http://localhost:3000/health |
| **MCP Server**  | http://localhost:3002/mcp    |
| **Ollama AI**   | http://localhost:11434       |

```bash
# 5. Pull the LLM model (first run only — a few GB)
docker exec smartchef_ollama ollama pull gemma3:4b
```

The model name must match `OLLAMA_MODEL` in `docker/docker-compose.yml` (defaults to `gemma3:4b`, chosen for good multilingual output on CPU-only inference — swap both if you'd rather use something else).

**To stop everything:**
```bash
docker compose down
```

**To stop everything and delete the data:**
```bash
docker compose down -v
```

**With Podman** (instead of Docker Desktop): the same commands work by swapping `docker` for `podman` — e.g. `podman compose up -d`, `podman compose ps`, `podman exec smartchef_ollama ollama pull gemma3:4b`.

---

### 💻 Option 2 — Local, without Docker

**Prerequisites:**
- [Node.js 20+](https://nodejs.org)
- [PostgreSQL 16](https://www.postgresql.org/download/) or via Homebrew: `brew install postgresql@16`
- [Ollama](https://ollama.com/download)

**1. Create the database:**
```bash
createdb smartchef
for f in db/migrations/*.sql; do psql smartchef < "$f"; done
```

**2. Start the Backend** (terminal 1):
```bash
cd backend
npm install

# Create the .env file
cp ../docker/.env.example .env
# Open .env and set:
#   DATABASE_URL=postgres://localhost:5432/smartchef
#   OLLAMA_URL=http://localhost:11434

npm run dev
# → Backend available at http://localhost:3000
```

**3. Start the Frontend** (terminal 2):
```bash
cd frontend
npm install
npm run dev
# → App available at http://localhost:5173
```

**4. Start Ollama** (terminal 3):
```bash
# Start the server
ollama serve

# In another terminal, pull the model
ollama pull gemma3:4b
```

---

## ✅ Checking it works

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "db": true,
  "ollama": true,
  "ollamaModels": ["gemma3:4b"],
  "version": "1.0.0"
}
```

Then in the browser:
1. Go to **http://localhost:8080** (Docker) or **http://localhost:5173** (local)
2. On first run, set up the instance name/password, then log in
3. Click **Smart Import** in the sidebar
4. Paste the URL of any recipe (e.g. from giallozafferano.it), or switch to raw text
5. Click **Start AI Transformation** and wait for the LLM parse (CPU-only inference — can take a few minutes; a progress bar shows elapsed time)
6. Review the matched ingredients/steps, click **Create & Review Recipe**
7. Head back to the **Gallery** to see the imported recipe

---

## 🔐 Admin Access

This instance's first (admin) account:

| Username | Password |
|---|---|
| `admin` | `admin2026` |

> ⚠️ **Change this password** (Account → Save Changes) before sharing this repo
> or its history publicly — it's a weak, default-style password and this file
> is version-controlled. Additional users can be added by an admin from
> Account → Manage Users.

---

## ⚠️ Common problems

| Problem | Solution |
|---|---|
| Port 5432 already in use | `lsof -i :5432` and stop the local Postgres, or change the port in `docker/docker-compose.yml` |
| Port 8080 already in use | Change `"8080:80"` to `"8081:80"` in `docker/docker-compose.yml` |
| Ollama slow on first run | Normal — the model is a few GB, wait for the download to finish |
| Frontend can't reach the API | Locally, check that the proxy in `vite.config.ts` points at `http://localhost:3000` |
| `pg_trgm` error | Run: `psql smartchef -c "CREATE EXTENSION pg_trgm;"` |
| Ollama responds but parsing fails | Check the model is actually pulled: `ollama list` |
| `docker compose` not found | Update Docker Desktop to the latest version |
| 502 after rebuilding only the backend | nginx caches the old backend container IP — restart the frontend too: `podman restart smartchef_frontend` |

---

## 🏗️ Project structure

```
smartchef/
├── docker/
│   ├── docker-compose.yml              # PostgreSQL + Backend + Frontend + MCP + Ollama
│   └── .env.example                    # Environment variables (copy to docker/.env)
├── docker-compose.yml                  # Thin root-level entrypoint, includes docker/docker-compose.yml
├── db/
│   └── migrations/                     # Sequential SQL migrations — full schema history
├── shared/
│   └── types/index.ts                  # Shared TypeScript types (backend ⇄ frontend ⇄ MCP)
├── backend/
│   ├── src/
│   │   ├── db/pool.ts                  # PostgreSQL connection pool
│   │   ├── middleware/requireAuth.ts   # Session-cookie auth guard (mounted on all of /api except /api/auth)
│   │   ├── routes/
│   │   │   ├── recipes.ts              # Recipe CRUD, portion scaling, LLM parse, cook-sequence, nutrition
│   │   │   ├── ingredients.ts          # Ingredients, categories, tools, units
│   │   │   ├── techniques.ts           # Cooking techniques library
│   │   │   ├── tags.ts                 # Managed tag catalog + auto-tagging rules
│   │   │   ├── collections.ts          # Freeform recipe collections
│   │   │   ├── menus.ts                # Weekly meal planner
│   │   │   ├── shopping.ts             # Shopping list generation + Markdown export
│   │   │   ├── auth.ts                 # Login/setup, multi-user (admin-invited), LLM provider config (session JWT cookie)
│   │   │   ├── share.ts                # Export/import a recipe or collection as a portable file
│   │   │   ├── sync-folder.ts          # Multi-device sync via a shared folder + native offline snapshot pull
│   │   │   ├── backup.ts               # Manual whole-library backup export/import
│   │   │   ├── cook-log.ts             # Cook-history calendar (GET /cook-log?from=&to=)
│   │   │   ├── geocode.ts              # Nominatim proxy for free-text region geocoding
│   │   │   ├── sync.ts                 # Legacy CRDT/vector-clock P2P endpoints — see "Multi-device sync" below
│   │   │   └── uploads.ts              # Image uploads (multer + sharp)
│   │   ├── services/
│   │   │   ├── matrioska.engine.ts     # ⭐ Recursive portion scaling across nested sub-recipes (incl. weight/volume-based sub-recipe yield)
│   │   │   ├── llm.parser.ts           # Provider dispatch (Ollama/Anthropic/Gemini/OpenAI) — recipe extraction, translation, ingredient-name translation
│   │   │   ├── llm.providers.ts        # Anthropic/Gemini/OpenAI API clients
│   │   │   ├── crypto.service.ts       # AES-256-GCM encrypt/decrypt for stored LLM API keys
│   │   │   ├── ingredient.matcher.ts   # Fuzzy match LLM output → DB (Levenshtein), auto-creates missing ones
│   │   │   ├── tags.service.ts         # Ingredient-driven auto-tagging
│   │   │   ├── nutrition.service.ts    # Per-serving nutrition calculation
│   │   │   ├── folder-sync.service.ts  # Whole-library snapshot export/merge (multi-device sync + backups)
│   │   │   ├── device-identity.service.ts
│   │   │   └── crdt/vector-clock.ts    # Legacy — not wired into any write path, kept for the old sync.ts routes
│   │   └── index.ts                    # Express entry point
│   └── Dockerfile
├── mcp/
│   ├── src/
│   │   ├── backendClient.ts            # HTTP client against the backend REST API
│   │   ├── tools.ts                    # MCP tool definitions
│   │   └── index.ts                    # Entry point (Express + Streamable HTTP transport)
│   └── Dockerfile
└── frontend/
    ├── src/
    │   ├── pages/
    │   │   ├── Home.tsx                 # Gallery: search/filters, sort, adjustable grid density, Collections tab
    │   │   ├── RecipeCreate.tsx         # New recipe editor
    │   │   ├── RecipeDetail.tsx         # View/edit + Matrioska portion calculator + kitchen mode
    │   │   ├── RecipeImport.tsx         # AI import wizard (URL / raw text / portable-file import)
    │   │   ├── LibraryIngredients.tsx   # Ingredients + categories + translations
    │   │   ├── LibraryTools.tsx / LibraryUnits.tsx / LibraryTechniques.tsx / LibraryTags.tsx
    │   │   ├── Planner.tsx              # Weekly meal planner
    │   │   ├── ShoppingList.tsx         # Shopping list
    │   │   ├── CollectionDetail.tsx     # Recipe collection view
    │   │   ├── CookHistory.tsx          # Cook-history month calendar
    │   │   ├── Login.tsx / Account.tsx  # Auth + account settings (avatar presets, LLM provider), Backup & Restore, Multi-Device Sync
    │   │   ├── ManageUsers.tsx          # Admin-only: invite/list/remove instance users
    │   │   └── ServerConnect.tsx        # Native-app-only: connect to a remote SmartChef server
    │   ├── lib/api.ts                   # apiFetch — same-origin on web, absolute+cookie'd on native, offline fallback/outbox, routes to standalone mode's local router when active
    │   ├── lib/offlineStore.ts          # Native SQLite cache + write outbox (server-mode Android's offline read cache)
    │   ├── lib/countries.ts             # Country code → centroid lat/lng for the region map
    │   ├── lib/standalone.ts            # Standalone-mode profile (display name, no password) + first-run init
    │   ├── lib/electronBridge.ts        # Renderer-side helpers for Electron's IPC bridge (folder picker, fs primitives)
    │   ├── lib/gitfs.ts                 # isomorphic-git fs adapter — @capacitor/filesystem on Android, IPC-to-main-process on Electron
    │   ├── lib/sync/gitSync.ts          # Folder Sync engine: git commit/pull + LWW merge for standalone mode
    │   ├── db/local.ts                  # Local SQLite datastore (standalone mode) — same query/queryOne/withTransaction shape as backend/src/db/pool.ts
    │   ├── services/*.local.ts          # Standalone-mode ports of the backend routes (recipes, ingredients/units/tools, backup import) — called directly, no HTTP layer
    │   ├── services/localRouter.ts      # Dispatches apiFetch calls to the *.local.ts services when standalone mode is active
    │   ├── components/AppLayout.tsx     # Shared header + sidebar navigation
    │   ├── components/RegionPicker.tsx / RegionsMap.tsx  # Recipe geolocation chip picker + Leaflet map
    │   └── store/app.store.ts           # Global state (Zustand)
    ├── android/                         # Capacitor Android project (native wrapper, see below)
    ├── electron/                        # Capacitor Electron project — the Windows desktop app (standalone mode section below)
    ├── nginx.conf                       # SPA routing + API proxy
    └── vite.config.ts
```

---

## 🔌 MCP Server

A separate service (its own `package.json`, Dockerfile, and container — it doesn't run inside the backend process) exposes the recipe library via [Model Context Protocol](https://modelcontextprotocol.io), so an AI assistant can read and create recipes directly.

- Endpoint: `POST http://localhost:3002/mcp` (Streamable HTTP transport, stateless — each request opens its own MCP session)
- Doesn't touch the database directly: it calls the backend's own REST routes (`BACKEND_URL`, defaulting to `http://backend:3000` inside Docker)

Exposed tools:

| Tool | Description |
|------|-------------|
| `list_recipes` | Search/filter recipes (query, tag, difficulty, components) |
| `get_recipe` | Full detail of a recipe (ingredients, steps, tools, techniques) |
| `scale_recipe_portions` | Matrioska engine: recalculates quantities for N portions, resolving nested sub-recipes |
| `create_recipe` | Creates a new recipe with ingredients (incl. groups), steps (incl. tagged techniques), tools, storage instructions and tips |
| `update_recipe` | Updates an existing recipe's fields |
| `delete_recipe` | Deletes a recipe |
| `list_ingredients` / `list_ingredient_categories` | Browse the pantry |
| `list_units` | Units of measure and conversion factors |
| `list_tools` | Kitchen tools |
| `list_techniques` | Cooking techniques library |

To connect it to an MCP client (e.g. Claude Desktop) that requires a stdio transport, use a proxy like [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) pointed at `http://localhost:3002/mcp`.

---

## 📡 API Routes

All routes below live under `/api` and (aside from `/api/auth/*`) require an authenticated session cookie. This is a resource-level overview, not an exhaustive endpoint list — see `backend/src/routes/*.ts` for the full set.

| Base path | Covers |
|-----------|--------|
| `/api/auth` | First-run setup, username/password login, logout, account settings (incl. LLM provider config), admin-only user management (`/users`) |
| `/api/recipes` | CRUD, `?q=&tag=&tags=&ingredientCategories=&regions=&difficulty=&sort=&seasonalOnly=&seasonalMonth=`, `/:id/portions?servings=N` (Matrioska), `/:id/cook-sequence`, `/:id/nutrition`, `/:id/rating`, `/:id/cooked`, `/:id/translate/:lang` (AI translation), `/:id/collections`, `/parse` (AI import), `/filter-by-pantry` (reserved stub for a future pantry/inventory app — returns 501) |
| `/api/ingredients` | Ingredients (incl. `seasonalMonths`), `/categories`, nested `/api/units`, `/api/tools` |
| `/api/techniques` | Cooking techniques library |
| `/api/tags` | Managed tag catalog |
| `/api/collections` | Freeform recipe collections |
| `/api/menus` | Weekly meal planner |
| `/api/shopping` | Shopping list generation, item check-off, Markdown export |
| `/api/share` | Export/import a recipe, bulk recipes, or a collection as a portable `.smartchef.json` file |
| `/api/sync-folder` | Multi-device sync status/trigger + native app's offline-cache snapshot pull |
| `/api/backup` | Manual whole-library backup export/import |
| `/api/cook-log` | Cook-history calendar (`GET ?from=&to=`), backing the "I cooked this" log |
| `/api/geocode` | Server-side Nominatim proxy for free-text region geocoding (cached) |
| `/api/sync` | Legacy CRDT/vector-clock P2P endpoints — see [Multi-device sync](#-multi-device-sync) |
| `/api/uploads` | Image uploads |
| `/health` | DB + Ollama status (no auth required) |

---

## 🧩 Matrioska Engine

Recipes can be nested infinitely. The engine recursively resolves every sub-recipe and aggregates ingredients scaled to the requested number of portions:

```
Gala Dinner (×10 people)
├── 500g   Egg pasta              ← plain ingredient  (×10/4 = ×2.5)
├── 3 srv  Mother Sauce           ← nested sub-recipe
│   ├── 1500g  Tomatoes           ← resolved: 500g × 3
│   └── 150ml  Olive oil          ← resolved: 50ml × 3
└── to taste  Salt                ← vague quantity → warning
```

```bash
GET /api/recipes/:id/portions?servings=10
```

---

## 🔄 Multi-device sync

Two independent mechanisms exist — worth being precise about which one actually does what:

**Folder-based sync (the one that works).** Each device writes a full-library snapshot (`smartchef-<deviceId>.json`) into a shared folder — a plain local folder, or one kept in sync by a desktop client like OneDrive/Google Drive. On every cycle, a device reads every *other* device's file and merges each row in by id, last-write-wins on `updated_at`. No central server, no pairing handshake. Enable it with `SYNC_ENABLED=true` + `SYNC_FOLDER_HOST_PATH` in `docker/.env`; status, peer list, and a manual "Sync Now" (with a per-entity change summary) are on the **Account** page. The same snapshot format also powers the **Backup & Restore** feature (manual export/import, independent of sync being enabled) and the native app's offline read cache.

*This is the server-mode mechanism, backed by the Docker/Postgres backend.* **Standalone mode** (no server at all — see [below](#-standalone-mode--windows--android-no-server)) has its own, separate Folder Sync built on real git commit history (`frontend/src/lib/sync/gitSync.ts`, via `isomorphic-git`) instead of snapshot files — same LWW-by-`updated_at` idea, different implementation, since there's no backend process to run the sync loop.

**CRDT vector-clock P2P (`/api/sync/*`, legacy).** An earlier, more ambitious design — direct device-to-device sync with field-level conflict detection via vector clocks (`services/crdt/vector-clock.ts`, `mdns.service.ts`). The endpoints exist and respond, but no mutating route in the app ever logs a local edit into the operation log, so there's nothing real for peers to exchange — it predates and was superseded by folder-based sync. Kept in the codebase but not used by the UI; retrofitting true per-operation CRDT logging into every write path would be a large separate undertaking.

**Native app offline editing.** Separate again from both of the above: the Android app keeps a local SQLite cache of the whole library and a write outbox for edits made without connectivity, replayed against the real API on reconnect — see `frontend/src/lib/api.ts`, `offlineStore.ts`, `offlineSync.ts`.

---

## 📴 Standalone Mode (Windows & Android, No Server)

Everything above assumes a running Docker/Postgres backend. SmartChef also runs **fully offline, with no server at all**: the Windows desktop app and the Android app can each keep their own local SQLite database, work indefinitely with zero connectivity, and — if you want more than one device — converge with each other through a shared folder using real git history instead of a central server.

### Building the apps

Both are built from the same `frontend/` React codebase via [Capacitor](https://capacitorjs.com); there's no hosted download, so build (or re-build) them yourself:

**Windows** (`frontend/electron/`, an Electron wrapper):
```bash
cd frontend
npm install
npm run electron:build
```
Produces an NSIS installer at `frontend/electron/dist/SmartChef Setup 1.0.0.exe`.

**Android**:
```bash
cd frontend
npx cap sync android
cd android
./gradlew assembleDebug
```
Produces `frontend/android/app/build/outputs/apk/debug/app-debug.apk` — install via `adb install app-debug.apk`, or transfer the file to the phone and open it directly (requires allowing "install from unknown sources").

### First run: standalone vs. server

On first launch, both apps ask **"Connect to a server"** (the Tailscale setup described below) or **"Use offline on this device."** Choosing offline asks for a display name and an optional avatar — no password, since each device's local data is already private to whoever holds the device.

### Household Profiles — more than one person sharing a standalone library

Standalone mode isn't limited to one name per device. **Profiles** (who's currently using the app — for labeling recipes you create and cooks you log) are their own synced entity, distinct from **Local Storage** and the **Sync Folder** below: a profile created on one device becomes pickable on every other device sharing the same Sync Folder, the same way a recipe or ingredient does.

- **Creating the first profile**: the "Use offline on this device" screen asks for a name (+ optional avatar) and creates the first profile — same as any first-run today.
- **Joining an existing household**: if you point a *new* device at a Sync Folder that already has profiles synced into it (choose the folder before finishing setup), the app syncs once and offers **"pick who you are"** instead of forcing a redundant new profile — pick an existing one, or still create a new one if this is genuinely a new person.
- **Switching who's using a shared device**: Account → **Switch Profile** brings back the "Who's cooking?" picker without touching the local library, the Sync Folder, or any other profile — distinct from **Log Out**, which forgets this device's standalone setup entirely.

### Getting your existing recipes into a fresh standalone install

If you already run the server-mode Docker stack with a real library built up, you don't have to re-create it by hand on a new standalone device:

1. On the **server-mode** instance (the one with your data, e.g. `http://localhost:8080`), go to **Account → Backup & Restore → Export Backup**. This downloads one JSON file containing your whole library — recipes, ingredients, tools, tags, ingredient categories, and cooking techniques, with all translations.
2. On the **new standalone device** (Windows or Android), finish the offline first-run setup, then go to **Account → Backup & Restore → Restore from Backup** and pick that same JSON file.

Restoring is additive, not destructive, and safe to run more than once: every item is matched by its original id, so anything already present locally is left untouched rather than duplicated or overwritten — importing the same backup twice, or two backups that partially overlap, is a harmless no-op for whatever's already there.

Standalone mode's own **Export Backup** button is intentionally not available — Folder Sync (below) is standalone's real, continuous backup mechanism instead of a one-shot file, and it also gives you full history. Restore still works normally in standalone mode either way, specifically for pulling data in from an existing server-mode library like this.

### Folder Sync — converging multiple standalone devices

Standalone devices never talk to each other directly, and never require both to be online at once. Local Storage — the live SQLite database + images every screen actually reads and writes — is always a fixed, per-platform location (`Documents/SmartChef` on Windows; a private app-data folder on Android), not something you pick. How devices actually exchange changes is a choice, set per device in Account → Folder Sync (or noted during first-run setup): **Folder mode** (the original design) or **Git Remote mode**.

**Folder mode** points at a *separate* location — a plain local folder, a mapped network drive/SMB share, or a folder already kept in sync by [Syncthing](https://syncthing.net), OneDrive, Google Drive, or Dropbox's desktop client. On Android this is the system's folder picker (Storage Access Framework) instead, which can point at the same kinds of targets via whichever apps expose a folder handle to it — Syncthing is the most reliable option here, since the mainstream cloud-storage Android apps don't genuinely keep an arbitrary folder two-way synced the way their desktop clients do.

Under the hood, a Folder-mode Sync Folder is a **bare-style git remote** — it only ever holds git objects and refs, never a checked-out working tree. Each device keeps its own private **Hidden Clone** (a real git repository, invisible in the UI, distinct from both Local Storage and the Sync Folder) where every local change gets committed. Syncing pulls the Hidden Clone against the Sync Folder over a hand-rolled object/ref transport (isomorphic-git's own fetch/push only speak HTTP, and a Sync Folder is just files on disk) before ever pushing — never the other way around, so a device can't overwrite the shared ref before it's looked at what's actually there — then pushes with a compare-and-swap check so a concurrent write from another device is detected and retried, not silently clobbered. Object transfers run several at a time (not strictly one-by-one) to keep sync fast even against a transport with real per-call overhead, like Android's Storage Access Framework — and if a device's own folder listing ever looks incomplete (the Google Drive/Android case above), it automatically falls back to downloading a single git-bundle-format snapshot instead of enumerating objects one by one, rather than merging against a silently partial view.

**Git Remote mode** points at a real git server instead — GitHub, GitLab, or self-hosted — reached over git's actual push/fetch protocol (Account → Folder Sync → Git Remote: repository URL, optional username, an access token). Unlike most git-in-the-browser tools, this doesn't need a CORS proxy for GitHub/GitLab — the request runs through native code (Electron's main process, or a small Android plugin), which was never subject to the browser's CORS policy in the first place, the same trick this app already uses for filesystem access. No file-sync tool is in the loop at all in this mode either way: the server owns atomic ref updates natively and always knows its own true object set, so the failure modes above (ref races, incomplete listings) don't apply. See [ADR 0004](./docs/adr/0004-git-remote-sync-mode.md) for the full story, including the public CORS-proxy dead end this replaced.

Both modes run **Structured Merge** — a field-by-field three-way merge, not git's textual merge — to reconcile whatever changed on both sides since they last agreed. A field genuinely edited on both devices becomes a **Conflict**, surfaced in its own list (Account → Folder Sync) for you to resolve rather than silently auto-picked; everything else about that sync still finishes normally. Covers recipes (steps, ingredients, ingredient groups, tagged techniques included), ingredients, tools, tags, cooking techniques, and household profiles — deletions propagate as tombstones the same way any other edit does. Device-record tracking ("Known Devices") is Folder-mode-only for now; Git Remote mode doesn't show it.

Once two devices are pointed at the same Sync Folder or git remote — however it got that way — Account → **Sync Now** pushes local changes and pulls in whatever changed elsewhere; a recipe created on one device shows up on the other the next time both sync. How often that happens automatically (besides on app resume and a manual Sync Now) is also configurable there, per device — a value plus a unit (minutes/hours/days/weeks/months, e.g. "every 3 days"), not just minutes. The full commit history is browsable on either device at Account → Folder Sync → **History**. See [`CONTEXT.md`](./CONTEXT.md) for the full glossary of these terms and [`docs/adr/`](./docs/adr/) for the architecture decisions behind them.

---

## 📱 Mobile App (Android) & Remote Access via Tailscale

SmartChef is already an installable PWA, but for a native Android app with a real offline cache, a [Capacitor](https://capacitorjs.com) wrapper (`frontend/android/`) was added, reusing the entire existing React frontend. For it to work — both at home and away — the backend needs a reachable HTTPS address, provided by [Tailscale](https://tailscale.com) instead of a traditional reverse proxy/public domain: no router ports to open, one stable address that's identical on LAN and remote.

### 1. Install Tailscale on both devices

- **On the PC acting as server:** `winget install Tailscale.Tailscale`, then `tailscale up` (opens a login URL to complete in the browser).
- **On the phone:** install the Tailscale app from the Play Store, sign in with the same account.
- **Enable HTTPS certificates** (one-time, per tailnet) in the admin console: <https://login.tailscale.com/admin/dns> → "HTTPS Certificates" section → Enable.

### 2. Expose the app over HTTPS

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Makes the app reachable at `https://<machine-name>.<your-tailnet>.ts.net` with a real certificate (Let's Encrypt, auto-renewed by Tailscale) — no need to configure Caddy/nginx for certs. Verify with `tailscale serve status` and `tailscale status` (shows the exact machine name and whether the phone is already connected to the same tailnet).

### 3. Configure session cookies and CORS

The native app runs on a fixed origin (`https://localhost`, Capacitor's default `androidScheme`) different from the backend's — unlike a regular browser, which goes through the same domain via the frontend's nginx proxy. This needs explicit config in `docker/.env` (copy from `docker/.env.example`):

```bash
COOKIE_SAME_SITE=none
COOKIE_SECURE=true
CORS_ORIGIN=https://<machine-name>.<your-tailnet>.ts.net,https://localhost
```

`CORS_ORIGIN` accepts a comma-separated list — it must include **both** the Tailscale address (for browser access) **and** `https://localhost` (the Android WebView's fixed origin, independent of which server the app is configured to talk to). Then:

```bash
podman compose up -d --build backend
podman restart smartchef_frontend   # otherwise nginx keeps caching the backend's old IP
```

### 4. Build the Android app

```bash
cd frontend
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is generated at `frontend/android/app/build/outputs/apk/debug/app-debug.apk`. Install it on the phone (via `adb install app-debug.apk`, or transfer the file and open it directly — requires allowing "install from unknown sources").

### 5. Connect the app to the server

On first launch the app shows a "Connect to your SmartChef server" screen — enter the Tailscale address (`https://<machine-name>.<your-tailnet>.ts.net`). The app checks `/health` before saving the address; if that check fails, confirm Tailscale is connected on the phone and steps 2–3 above are complete.

### Offline mode

Once logged in, the phone keeps a local cache (SQLite) of the whole library (recipes, ingredients, tags, tools, collections) and a queue of changes made without connectivity (creating/editing recipes and ingredients, ratings, deletions, logging a cook), automatically replayed against the backend as soon as the connection returns.

---

## 🐳 Running Compose commands from any folder

Besides `docker/docker-compose.yml` (the real services), an equivalent file sits at the project root (`./docker-compose.yml`) that includes it via the `include:` directive, so commands work without `cd docker` first:

```bash
podman compose -f docker-compose.yml up --build --force-recreate
```

Both files explicitly point at the same Compose project (`name: docker` at the top of each) — necessary because otherwise the default project name is derived from whichever folder the command is run from, and the two folders would resolve to two completely separate stacks (and two separate sets of data volumes).

---

## 🗺️ Implementation status

| Area | Description | Status |
|------|-------------|--------|
| Docker + DB schema + Matrioska Engine | Recursive portion scaling, nested sub-recipes | ✅ Complete |
| Gallery — search, filters, sort, density | Search across title/description/ingredients, tag + ingredient-category filters, sort (recent/newest/oldest/A-Z), adjustable 2/3/4-column grid | ✅ Complete |
| Recipe editor | Ingredients (with optional sub-groups), steps (taggable with techniques), tools, storage instructions & tips, inline step↔ingredient references ("Bimby-style", live-scaled quantities), translations, ratings, cook counter, delete | ✅ Complete |
| Scaling warnings | Flags when a requested portion count scales a recipe more than 3x up or down from its original yield, since ingredient ratios/cook times stop being reliable past that range | ✅ Complete |
| Library (Ingredients/Tools/Units/Techniques/Tags) | Full CRUD + translation editors; managed tag catalog with ingredient-driven auto-tagging | ✅ Complete |
| Nutrition | Per-serving calculation from ingredient nutrition data, resolved through nested sub-recipes | ✅ Complete |
| Collections & Meal Planner & Shopping List | Freeform recipe collections; weekly planner; shopping list from a saved menu or an ad-hoc cart, aggregated or grouped view, Markdown export | ✅ Complete |
| AI recipe import | Real Ollama-backed parsing (URL/raw text) with fuzzy ingredient/tool matching, source-language detection, progress feedback, fills every recipe field (ingredient groups, step techniques, storage instructions, tips included); portable-file import/export for sharing between instances | ✅ Complete |
| Auth | Username/password login, admin-invited multi-user accounts (recipes stay a shared household cookbook — accounts drive attribution + private shopping list/planner/collections, not access control), session JWT cookie | ✅ Complete |
| Cloud LLM providers | Optional Anthropic/Gemini/OpenAI for recipe-import parsing and AI translation, per-instance encrypted API keys (Account page); local Ollama stays the default | ✅ Complete |
| AI recipe translation | One-click translate a recipe's title/description/steps/ingredient notes into another language via whichever LLM provider is configured | ✅ Complete |
| Cook-history calendar | Month-view log of "I cooked this" events per recipe, linked from the recipe page | ✅ Complete |
| Recipe geolocation | Chip-based region picker (country list + free-text sub-national, geocoded via a Nominatim proxy), Leaflet map (CARTO tiles, degrades gracefully offline), Gallery region filter | ✅ Complete |
| Ingredient seasonality | Per-ingredient in-season months set from the Library, a calendar-style browse page (Library → Seasonality), and a Gallery "in season" filter — an ingredient with no seasonality data never excludes a recipe | ✅ Complete |
| Sub-recipe-as-ingredient | Pick an existing recipe as an ingredient line from the recipe editor UI; optional recipe "yield" field lets sub-recipe amounts be specified by weight/volume instead of only by servings | ✅ Complete |
| Avatar presets | Original cartoon-chef SVGs, adaptively discovered from `frontend/src/assets/avatars/` (drop in a new file, no code change) | ✅ Complete |
| i18n | EN/IT/FR/ES UI + content translations (recipes, steps, categories, units, tools, tags, ingredients); ingredient names auto-translated to match a recipe's language | ✅ Complete |
| PWA | Manifest, service worker, icons, installable — service worker only registers on web; the native Android build skips it (files are already bundled in the APK) | ✅ Complete |
| MCP Server | Exposes the recipe library via Model Context Protocol (port 3002) | ✅ Complete |
| Native Android app | Capacitor wrapper, Tailscale-based remote HTTPS access, offline read cache + write outbox, native back-gesture handling | ✅ Complete |
| Multi-device sync & backup | Folder-based whole-library snapshot sync (peer status + manual trigger on the Account page) and manual backup export/restore, both LWW-merged by `updated_at` | ✅ Complete |
| Standalone mode (no server) | Local SQLite datastore ported from the server routes (`frontend/src/db/local.ts` + `services/*.local.ts`), first-run "use offline on this device" flow, no password | ✅ Complete |
| Standalone gallery list performance | Batches tag lookups for the whole recipe list into 2 queries total instead of one query pair per tag per recipe (`services/recipes.local.ts`'s `buildTagsDisplayBatch()`) — the old per-tag loop meant every gallery load paid `recipes × tags` sequential round-trips through `@capacitor-community/sqlite`'s native plugin bridge, visibly slow on Android as the library grew | ✅ Complete |
| Local git object packing (Folder Sync) | Packs+prunes loose Hidden Clone objects into one local packfile after each sync cycle's push confirms them durably on the remote (`lib/sync/gitPacking.ts`), instead of leaving thousands of tiny loose files behind forever — isomorphic-git reads packed objects transparently, so local `commit`/`merge`/`checkout` get faster as the library grows without any other call site changing; see `docs/plans/2026-08-22-android-performance-plan.md` for the full safety argument and its one documented tradeoff | ✅ Complete |
| Household Profiles | More than one named profile per shared standalone library (`profiles` table, synced like any other entity); "who's cooking?" picker on a device with no active profile yet, joining an existing Sync Folder offers its existing profiles instead of forcing a new one, Account → Switch Profile to change who a shared device is using without touching local data | ✅ Complete |
| Windows desktop app | Electron wrapper (`frontend/electron/`) around the same React frontend, real native SQLite via `better-sqlite3-multiple-ciphers`, native folder-picker for Folder Sync | ✅ Complete |
| Folder Sync (standalone git sync) | Real `isomorphic-git` commit history pushed/pulled between a private per-device Hidden Clone and a bare-style Sync Folder (local/network-share/cloud-synced, native picker on Windows, SAF picker on Android); field-level Structured Merge with surfaced Conflicts on genuine double-edits; covers recipes, ingredients, tools, tags, techniques and profiles; object transfers run concurrently (not one-by-one) for real-world speed; live push/pull progress and a per-entity-type summary on the Account page; commit history browsable per device | ✅ Complete |
| Standalone Backup & Restore | Export and Restore both work fully offline in standalone mode now (export was previously server-only); idempotent by id | ✅ Complete |
| Ingredient/Tag catalog management | Merge two duplicate ingredients or catalog tags (repoints every recipe/association, tombstones the loser); merge or rename a whole tag group at once; delete a tag (catalog or free-text/"custom") from every recipe carrying it; surfaces free-text recipe tags that were never added to the catalog with one-click "add to catalog" | ✅ Complete |
| Ingredient varieties & synonyms | Optional "variety of" self-reference (e.g. Red Apple → Apple, purely organizational — no inherited fields) shown nested in the Library; optional alternate names (synonyms) on tags/ingredients/tools/techniques, matched by every existing name search | ✅ Complete |
| Ingredients library UX | Grid/list view toggle (photo-forward cards vs. dense table) and a read-only detail card (photo, nutrition, seasonality, synonyms, translations, tags) separate from the edit form | ✅ Complete |
| Git Remote sync mode | A second Folder Sync transport, chosen per device (Account → Folder Sync): a real git server (GitHub/GitLab/self-hosted) over git's actual push/fetch protocol instead of a file-sync-tool-mirrored folder — no ref races or listing truncation, since the server owns atomic ref updates natively; configurable auto-sync interval for both modes; see [ADR 0004](./docs/adr/0004-git-remote-sync-mode.md). Device-record tracking ("Known Devices") is Folder-mode-only for now | ✅ Complete |
| Legacy CRDT vector-clock P2P sync (`/api/sync/*`) | Endpoints respond, but no write path logs local edits — nothing real for peers to exchange. Superseded by folder-based sync; no field-level conflict-resolution UI exists (or is planned) for this path | ⚠️ Legacy, inert |

---

## 📄 License

MIT
