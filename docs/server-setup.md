# Running SmartChef as a server

Server mode runs Postgres, the API and the web app together, and every
device talks to it over the network. It is the right choice when you want
one library reachable from anywhere, or more than one person using it.

If you only want the app on your own machines, you do not need any of
this — see [Standalone mode](standalone-sync.md), which has no server at
all.

> Part of the [SmartChef documentation](../README.md#documentation).

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
| **App (UI)**    | http://localhost:8888        |
| **Backend API** | http://localhost:3000/health |
| **MCP Server**  | http://localhost:3002/mcp    |
| **Ollama AI**   | http://localhost:11434       |

> The UI publishes **8888**, not the more obvious 8080. On Windows, WinNAT
> reserves TCP port ranges dynamically and had taken `7981-8080`, so nothing
> on the host — including WSL's port relay — could bind 8080 while the
> container inside the VM served happily. That combination reads exactly
> like a broken deploy. Check your own machine's reservations with
> `netsh interface ipv4 show excludedportrange protocol=tcp`, and change the
> port back in `docker/docker-compose.yml` if 8080 is free for you.

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
  "version": "1.1.0"
}
```

Then in the browser:
1. Go to **http://localhost:8888** (Docker) or **http://localhost:5173** (local)
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
| The UI port is already in use, or refuses connections | Change `"8888:80"` in `docker/docker-compose.yml` to any free port. If the container is running and healthy but the host still refuses the connection, check `netsh interface ipv4 show excludedportrange protocol=tcp` on Windows — WinNAT reserves ranges dynamically and nothing on the host can bind a port inside one |
| Ollama slow on first run | Normal — the model is a few GB, wait for the download to finish |
| Frontend can't reach the API | Locally, check that the proxy in `vite.config.ts` points at `http://localhost:3000` |
| `pg_trgm` error | Run: `psql smartchef -c "CREATE EXTENSION pg_trgm;"` |
| Ollama responds but parsing fails | Check the model is actually pulled: `ollama list` |
| `docker compose` not found | Update Docker Desktop to the latest version |
| 502 after rebuilding only the backend | nginx caches the old backend container IP — restart the frontend too: `podman restart smartchef_frontend` |

---

## 🐳 Running Compose commands from any folder

Besides `docker/docker-compose.yml` (the real services), an equivalent file sits at the project root (`./docker-compose.yml`) that includes it via the `include:` directive, so commands work without `cd docker` first:

```bash
podman compose -f docker-compose.yml up --build --force-recreate
```

Both files explicitly point at the same Compose project (`name: docker` at the top of each) — necessary because otherwise the default project name is derived from whichever folder the command is run from, and the two folders would resolve to two completely separate stacks (and two separate sets of data volumes).

---
