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
│   │   │   ├── auth.ts                 # Single-instance login/setup (session JWT cookie)
│   │   │   ├── share.ts                # Export/import a recipe or collection as a portable file
│   │   │   ├── sync-folder.ts          # Multi-device sync via a shared folder + native offline snapshot pull
│   │   │   ├── backup.ts               # Manual whole-library backup export/import
│   │   │   ├── sync.ts                 # Legacy CRDT/vector-clock P2P endpoints — see "Multi-device sync" below
│   │   │   └── uploads.ts              # Image uploads (multer + sharp)
│   │   ├── services/
│   │   │   ├── matrioska.engine.ts     # ⭐ Recursive portion scaling across nested sub-recipes
│   │   │   ├── llm.parser.ts           # Ollama client — recipe extraction + ingredient-name translation
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
    │   │   ├── Login.tsx / Account.tsx  # Auth + account settings, Backup & Restore, Multi-Device Sync
    │   │   └── ServerConnect.tsx        # Native-app-only: connect to a remote SmartChef server
    │   ├── lib/api.ts                   # apiFetch — same-origin on web, absolute+cookie'd on native, offline fallback/outbox
    │   ├── lib/offlineStore.ts          # Native SQLite cache + write outbox
    │   ├── components/AppLayout.tsx     # Shared header + sidebar navigation
    │   └── store/app.store.ts           # Global state (Zustand)
    ├── android/                         # Capacitor Android project (native wrapper, see below)
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
| `get_recipe` | Full detail of a recipe (ingredients, steps, tools) |
| `scale_recipe_portions` | Matrioska engine: recalculates quantities for N portions, resolving nested sub-recipes |
| `create_recipe` | Creates a new recipe with ingredients, steps and tools |
| `list_ingredients` / `list_ingredient_categories` | Browse the pantry |
| `list_units` | Units of measure and conversion factors |
| `list_tools` | Kitchen tools |

To connect it to an MCP client (e.g. Claude Desktop) that requires a stdio transport, use a proxy like [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) pointed at `http://localhost:3002/mcp`.

---

## 📡 API Routes

All routes below live under `/api` and (aside from `/api/auth/*`) require an authenticated session cookie. This is a resource-level overview, not an exhaustive endpoint list — see `backend/src/routes/*.ts` for the full set.

| Base path | Covers |
|-----------|--------|
| `/api/auth` | First-run setup, login, logout, account settings |
| `/api/recipes` | CRUD, `?q=&tag=&tags=&ingredientCategories=&difficulty=&sort=`, `/:id/portions?servings=N` (Matrioska), `/:id/cook-sequence`, `/:id/nutrition`, `/:id/rating`, `/:id/cooked`, `/parse` (AI import) |
| `/api/ingredients` | Ingredients, `/categories`, nested `/api/units`, `/api/tools` |
| `/api/techniques` | Cooking techniques library |
| `/api/tags` | Managed tag catalog |
| `/api/collections` | Freeform recipe collections |
| `/api/menus` | Weekly meal planner |
| `/api/shopping` | Shopping list generation, item check-off, Markdown export |
| `/api/share` | Export/import a recipe, bulk recipes, or a collection as a portable `.smartchef.json` file |
| `/api/sync-folder` | Multi-device sync status/trigger + native app's offline-cache snapshot pull |
| `/api/backup` | Manual whole-library backup export/import |
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

**CRDT vector-clock P2P (`/api/sync/*`, legacy).** An earlier, more ambitious design — direct device-to-device sync with field-level conflict detection via vector clocks (`services/crdt/vector-clock.ts`, `mdns.service.ts`). The endpoints exist and respond, but no mutating route in the app ever logs a local edit into the operation log, so there's nothing real for peers to exchange — it predates and was superseded by folder-based sync. Kept in the codebase but not used by the UI; retrofitting true per-operation CRDT logging into every write path would be a large separate undertaking.

**Native app offline editing.** Separate again from both of the above: the Android app keeps a local SQLite cache of the whole library and a write outbox for edits made without connectivity, replayed against the real API on reconnect — see `frontend/src/lib/api.ts`, `offlineStore.ts`, `offlineSync.ts`.

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
| Recipe editor | Ingredients, steps, tools, inline step↔ingredient references ("Bimby-style", live-scaled quantities), translations, ratings, cook counter, delete | ✅ Complete |
| Library (Ingredients/Tools/Units/Techniques/Tags) | Full CRUD + translation editors; managed tag catalog with ingredient-driven auto-tagging | ✅ Complete |
| Nutrition | Per-serving calculation from ingredient nutrition data, resolved through nested sub-recipes | ✅ Complete |
| Collections & Meal Planner & Shopping List | Freeform recipe collections; weekly planner; shopping list from a saved menu or an ad-hoc cart, aggregated or grouped view, Markdown export | ✅ Complete |
| AI recipe import | Real Ollama-backed parsing (URL/raw text) with fuzzy ingredient/tool matching, source-language detection, progress feedback; portable-file import/export for sharing between instances | ✅ Complete |
| Auth | Single-instance login (no per-user accounts, matches the shared-household-library model), session JWT cookie | ✅ Complete |
| i18n | EN/IT UI + content translations (recipes, steps, categories, units, tools, tags, ingredients); ingredient names auto-translated to match a recipe's language | ✅ Complete |
| PWA | Manifest, service worker, icons, installable | ✅ Complete |
| MCP Server | Exposes the recipe library via Model Context Protocol (port 3002) | ✅ Complete |
| Native Android app | Capacitor wrapper, Tailscale-based remote HTTPS access, offline read cache + write outbox, native back-gesture handling | ✅ Complete |
| Multi-device sync & backup | Folder-based whole-library snapshot sync (peer status + manual trigger on the Account page) and manual backup export/restore, both LWW-merged by `updated_at` | ✅ Complete |
| Legacy CRDT vector-clock P2P sync (`/api/sync/*`) | Endpoints respond, but no write path logs local edits — nothing real for peers to exchange. Superseded by folder-based sync; no field-level conflict-resolution UI exists (or is planned) for this path | ⚠️ Legacy, inert |

---

## 📄 License

MIT
