# 🍳 SmartChef Ecosystem

> **Offline-first, self-hosted recipe management** — nested recipes, dynamic portions, local AI parsing, CRDT P2P sync.

---

## 📋 Indice

- [Come avviare l'app](#-come-avviare-lapp)
  - [Opzione 1 — Docker (consigliata)](#-opzione-1--docker-consigliata)
  - [Opzione 2 — Locale senza Docker](#-opzione-2--locale-senza-docker)
- [Verificare che funzioni](#-verificare-che-funzioni)
- [Problemi comuni](#️-problemi-comuni)
- [Struttura del progetto](#️-struttura-del-progetto)
- [API Routes](#-api-routes)
- [Come funziona il Matrioska Engine](#-matrioska-engine)
- [Come funziona il Sync CRDT](#-crdt-sync)
- [Stato implementazione](#️-stato-implementazione)

---

## 🚀 Come avviare l'app

### 🐳 Opzione 1 — Docker (consigliata)

**Prerequisiti:**
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installato e avviato

```bash
# 1. Entra nella cartella del progetto
cd smartchef

# 2. Copia il file di configurazione
cp .env.example .env

# 3. Avvia tutti i servizi (DB + Backend + Frontend + Ollama)
cd docker
docker compose up -d

# 4. Controlla che tutto sia partito correttamente
docker compose ps
```

Dopo ~30 secondi apri nel browser:

| Servizio       | URL                          |
|----------------|------------------------------|
| **App (UI)**   | http://localhost:8080        |
| **Backend API**| http://localhost:3000/health |
| **MCP Server** | http://localhost:3002/mcp    |
| **Ollama AI**  | http://localhost:11434       |

```bash
# 5. Scarica il modello LLM (solo al primo avvio — circa 4GB)
docker exec smartchef_ollama ollama pull llama3

# Alternativa più leggera (~4GB, più veloce):
docker exec smartchef_ollama ollama pull mistral
```

**Per fermare tutto:**
```bash
docker compose down
```

**Per fermare tutto e cancellare i dati:**
```bash
docker compose down -v
```

**Con Podman** (invece di Docker Desktop): gli stessi comandi funzionano sostituendo `docker` con `podman` — es. `podman compose up -d`, `podman compose ps`, `podman exec smartchef_ollama ollama pull llama3`.

---

### 💻 Opzione 2 — Locale senza Docker

**Prerequisiti:**
- [Node.js 20+](https://nodejs.org)
- [PostgreSQL 16](https://www.postgresql.org/download/) oppure via Homebrew: `brew install postgresql@16`
- [Ollama](https://ollama.com/download)

**1. Crea il database:**
```bash
createdb smartchef
psql smartchef < db/migrations/001_initial_schema.sql
psql smartchef < db/migrations/002_crdt_tables.sql
```

**2. Avvia il Backend** (terminale 1):
```bash
cd backend
npm install

# Crea il file .env
cp ../.env.example .env
# Apri .env e imposta:
#   DATABASE_URL=postgres://localhost:5432/smartchef
#   OLLAMA_URL=http://localhost:11434

npm run dev
# → Backend disponibile su http://localhost:3000
```

**3. Avvia il Frontend** (terminale 2):
```bash
cd frontend
npm install
npm run dev
# → App disponibile su http://localhost:5173
```

**4. Avvia Ollama** (terminale 3):
```bash
# Avvia il server
ollama serve

# In un altro terminale, scarica il modello
ollama pull llama3
```

---

## ✅ Verificare che funzioni

```bash
curl http://localhost:3000/health
```

Risposta attesa:
```json
{
  "status": "ok",
  "db": true,
  "ollama": true,
  "ollamaModels": ["llama3"],
  "version": "1.0.0"
}
```

Poi nel browser:
1. Vai su **http://localhost:8080** (Docker) o **http://localhost:5173** (locale)
2. Clicca **"Importa AI"** nella sidebar
3. Incolla l'URL di una ricetta qualsiasi (es. da giallozafferano.it)
4. Clicca **Analizza** e attendi il parsing LLM (~10–30 secondi)
5. Verifica il risultato, clicca **Salva**
6. Torna nella **Gallery** per vedere la ricetta importata

---

## ⚠️ Problemi comuni

| Problema | Soluzione |
|---|---|
| Porta 5432 già occupata | `lsof -i :5432` e chiudi Postgres locale, oppure cambia porta nel `docker-compose.yml` |
| Porta 8080 già occupata | Cambia `"8080:80"` in `"8081:80"` nel `docker-compose.yml` |
| Ollama lento al primo avvio | Normale — il modello è ~4GB, aspetta il completamento del download |
| Frontend non raggiunge l'API | In locale verifica che il proxy in `vite.config.ts` punti a `http://localhost:3000` |
| Errore `pg_trgm` | Esegui: `psql smartchef -c "CREATE EXTENSION pg_trgm;"` |
| Ollama risponde ma non parsa | Verifica che il modello sia scaricato: `ollama list` |
| `docker compose` non trovato | Aggiorna Docker Desktop all'ultima versione |

---

## 🏗️ Struttura del progetto

```
smartchef/
├── .env.example                        # Variabili d'ambiente (copia in .env)
├── docker/
│   └── docker-compose.yml              # PostgreSQL + Backend + Frontend + Ollama
├── db/
│   └── migrations/
│       ├── 001_initial_schema.sql      # Schema completo + seed unità/categorie
│       └── 002_crdt_tables.sql         # Tabelle CRDT ops log + device registry
├── shared/
│   └── types/index.ts                  # Tipi TypeScript condivisi
├── backend/
│   ├── src/
│   │   ├── db/pool.ts                  # Connessione PostgreSQL
│   │   ├── routes/
│   │   │   ├── recipes.ts              # CRUD ricette + API porzioni
│   │   │   ├── menus.ts                # Menù settimanale
│   │   │   ├── shopping.ts             # Lista spesa + export Markdown
│   │   │   ├── llm.ts                  # Import LLM (parse + confirm)
│   │   │   ├── sync.ts                 # Handshake P2P + resolve conflitti
│   │   │   └── ingredients.ts          # Ingredienti + unità di misura
│   │   ├── services/
│   │   │   ├── matrioska.engine.ts     # ⭐ Calcolo ricorsivo porzioni
│   │   │   ├── shopping.service.ts     # Aggregazione lista da menù
│   │   │   ├── llm.parser.ts           # Client Ollama
│   │   │   ├── ingredient.matcher.ts   # Fuzzy match LLM→DB (Levenshtein)
│   │   │   ├── mdns.service.ts         # Loop sync P2P + registro peer
│   │   │   └── crdt/
│   │   │       └── vector-clock.ts     # Vector clock + conflict detection
│   │   └── index.ts                    # Entry point Express
│   ├── tsconfig.json
│   ├── package.json
│   └── Dockerfile
├── mcp/
│   ├── src/
│   │   ├── backendClient.ts            # Client HTTP verso il backend REST
│   │   ├── tools.ts                    # Definizione dei tool MCP
│   │   └── index.ts                    # Entry point (Express + Streamable HTTP transport)
│   ├── tsconfig.json
│   ├── package.json
│   └── Dockerfile
└── frontend/
    ├── src/
    │   ├── pages/
    │   │   ├── Home.tsx                 # Griglia ricette + ricerca/filtri
    │   │   ├── RecipeCreate.tsx         # Creazione ricetta + link ingredienti
    │   │   ├── RecipeDetail.tsx         # Dettaglio + calcolatore Matrioska
    │   │   ├── RecipeImport.tsx         # Wizard import AI
    │   │   ├── LibraryIngredients.tsx   # Gestione ingredienti + categorie + traduzioni
    │   │   ├── LibraryTools.tsx         # Gestione strumenti
    │   │   ├── LibraryUnits.tsx         # Gestione unità di misura
    │   │   ├── Planner.tsx              # Pianificatore settimanale
    │   │   └── ShoppingList.tsx         # Lista spesa
    │   ├── components/
    │   │   └── AppLayout.tsx           # Header + sidebar navigazione (condiviso)
    │   ├── services/api.ts             # Tutte le chiamate API
    │   └── store/app.store.ts          # Stato globale Zustand
    ├── nginx.conf                      # Routing SPA + proxy API
    ├── Dockerfile
    ├── vite.config.ts
    └── package.json
```

> ⚠️ Nota: l'API di sync P2P/CRDT (`/api/sync/*`) e il relativo motore (vector clock, conflict detection) sono implementati lato backend, ma **non esiste ancora una UI frontend** per pannello di sync o risoluzione conflitti. È un'area backend-only al momento.

---

## 🔌 MCP Server

Un servizio separato (proprio `package.json`, Dockerfile e container — non gira dentro il processo del backend) espone la libreria ricette via [Model Context Protocol](https://modelcontextprotocol.io), così un assistente AI può leggere e creare ricette direttamente.

- Endpoint: `POST http://localhost:3002/mcp` (Streamable HTTP transport, stateless — ogni richiesta apre una sessione MCP a sé)
- Non tocca il database direttamente: chiama le stesse route REST del backend (`BACKEND_URL`, di default `http://backend:3000` dentro Docker)

Tool esposti:

| Tool | Descrizione |
|------|-------------|
| `list_recipes` | Cerca/filtra ricette (query, tag, difficoltà, componenti) |
| `get_recipe` | Dettaglio completo di una ricetta (ingredienti, step, strumenti) |
| `scale_recipe_portions` | Motore Matrioska: ricalcola le quantità per N porzioni risolvendo le sub-ricette annidate |
| `create_recipe` | Crea una nuova ricetta con ingredienti, step e strumenti |
| `list_ingredients` / `list_ingredient_categories` | Sfoglia la dispensa |
| `list_units` | Unità di misura e fattori di conversione |
| `list_tools` | Strumenti da cucina |

Per collegarlo a un client MCP (es. Claude Desktop) che richiede un transport stdio, usa un proxy come [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) puntato su `http://localhost:3002/mcp`.

---

## 📡 API Routes

| Method | Path | Descrizione |
|--------|------|-------------|
| GET    | `/health` | Stato di DB e Ollama |
| GET    | `/api/recipes` | Lista ricette (con `?q=&difficulty=&tag=`) |
| POST   | `/api/recipes` | Crea ricetta |
| GET    | `/api/recipes/:id` | Dettaglio ricetta con ingredienti e step |
| DELETE | `/api/recipes/:id` | Elimina (soft delete) |
| GET    | `/api/recipes/:id/portions?servings=N` | **Matrioska**: ingredienti per N porzioni |
| POST   | `/api/llm/parse` | Analizza URL o testo con Ollama |
| POST   | `/api/llm/confirm` | Salva ricetta dopo conferma |
| GET    | `/api/llm/health` | Stato Ollama + modelli disponibili |
| GET    | `/api/menus` | Lista menù |
| POST   | `/api/menus` | Crea menù |
| POST   | `/api/menus/:id/items` | Aggiunge ricetta al menù |
| DELETE | `/api/menus/:id/items/:itemId` | Rimuove ricetta dal menù |
| POST   | `/api/shopping/generate` | Genera lista spesa da menù |
| GET    | `/api/shopping/:id/export` | Esporta lista in Markdown |
| PATCH  | `/api/shopping/:id/items/:itemId/check` | Spunta/despunta voce |
| POST   | `/api/sync/handshake` | Handshake P2P (invia clock, riceve ops) |
| POST   | `/api/sync/receive` | Riceve operazioni da un peer |
| GET    | `/api/sync/peers` | Lista dispositivi conosciuti |
| POST   | `/api/sync/trigger/:deviceId` | Forza sync manuale con un peer |
| GET    | `/api/sync/conflicts` | Lista conflitti da risolvere |
| POST   | `/api/sync/resolve` | Risolve un conflitto |
| GET    | `/api/ingredients` | Lista ingredienti (con `?q=`) |
| GET    | `/api/ingredients/categories` | Categorie ingredienti |
| GET    | `/api/units` | Unità di misura |

---

## 🧩 Matrioska Engine

Le ricette possono essere nidificate infinitamente. L'engine risolve ricorsivamente tutte le sub-ricette e aggrega gli ingredienti scalati per le porzioni richieste:

```
Cena di Gala (×10 persone)
├── 500g   Pasta all'uovo          ← ingrediente semplice  (×10/4 = ×2.5)
├── 3 porz Salsa Madre             ← sub-ricetta nidificata
│   ├── 1500g  Pomodori            ← risolto: 500g × 3
│   └── 150ml  Olio EVO            ← risolto: 50ml × 3
└── q.b.   Sale                    ← quantità vaga → warning
```

```bash
GET /api/recipes/:id/portions?servings=10
```

---

## 🔄 CRDT Sync

Protocollo di sincronizzazione bidirezionale senza server centrale:

```
Device A ──► POST /sync/handshake { clock: {A:5, B:3} } ──► Device B
Device A ◄── { ops: [...mancanti], clock: {A:5, B:7} }  ◄── Device B
Device A ──► POST /sync/receive   { ops: [...mancanti] } ──► Device B
```

I conflitti concorrenti (modifiche simultanee offline) vengono rilevati tramite Vector Clock e presentati nella UI **Conflict Resolver** con diff side-by-side rosso/verde.

---

## 🗺️ Stato Implementazione

| Area | Descrizione | Stato |
|------|-------------|-------|
| Docker + Schema DB + Matrioska Engine | Scaling ricorsivo porzioni, sub-ricette annidate | ✅ Completa |
| Frontend — Gallery, ricerca, filtri | Ricerca e filtri per tag ora interrogano `?q=`/`?tag=` sul backend | ✅ Completa |
| Frontend — Creazione/modifica/eliminazione ricette | Editor completo (ingredienti, step, strumenti, portion-linking step↔ingrediente); eliminazione ora disponibile dalla UI (era mancante) | ✅ Completa |
| Frontend — Libreria (Ingredienti/Strumenti/Unità) | CRUD completo + editor traduzioni per ingredienti/categorie/unità | ✅ Completa |
| i18n contenuti | Tabelle traduzione per ricette/step/categorie/unità/strumenti; UI switcher EN attivo | ✅ Completa (solo EN per ora) |
| PWA | Manifest, service worker, icone, installabile | ✅ Completa |
| Server MCP | Espone libreria ricette via Model Context Protocol (porta 3002) | ✅ Completa |
| Meal Planner | Crea/elimina menù settimanali, assegna ricette per giorno/pasto/porzioni tramite ricerca autocomplete | ✅ Completa |
| Lista della spesa | Genera da un menù salvato **o** da un "carrello" ad-hoc di ricette (aggiunte dalla pagina ricetta o dalla Shopping List stessa); vista aggregata per ingrediente o raggruppata per ricetta, checkbox con progresso, export Markdown | ✅ Completa |
| Ricerca ingredienti nell'editor ricetta | Combobox con ricerca live al posto del menu a tendina (100+ ingredienti) | ✅ Completa |
| Libreria Tecniche | Nuova sezione (come Ingredienti/Strumenti): CRUD, traduzioni, foto di riferimento | ✅ Completa |
| Foto di riferimento | Ingredienti e strumenti supportano una o più foto (URL) con anteprima, oltre all'icona | ✅ Completa |
| Riferimenti inline negli step | Toolbar sopra il testo dello step per inserire riferimenti a ingrediente/strumento/tecnica ("stile Bimby": grassetto+sottolineato, quantità scalata dal vivo) | ✅ Completa |
| CRDT Vector Clock + protocollo sync P2P | Endpoint REST (`/api/sync/*`) funzionanti e testati; nessuna UI per gestione peer o risoluzione conflitti | ⚠️ Solo backend |
| LLM Parser (Ollama) + Ingredient Matcher | Endpoint `/api/llm/parse` e `/api/llm/confirm` funzionanti; la pagina **Import** in UI è ancora una demo statica (non chiama l'endpoint reale) | ⚠️ Backend pronto, UI da collegare |

---

## 📄 Licenza

MIT
