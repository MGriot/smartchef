// ════════════════════════════════════════════════════════════════════════
// SmartChef — Applying migrations to a database that already exists
//
// docker-compose mounts db/migrations at /docker-entrypoint-initdb.d, and
// Postgres runs that directory exactly once: when it initialises an EMPTY
// data directory. So a new migration reaches a fresh install automatically
// and never reaches an existing one — every release note so far has had to
// carry a "run this by hand" footnote, which is a bad place to keep a
// schema change.
//
// This applies whatever has not been applied yet, in filename order, each
// in its own transaction, recording what it ran in `schema_migrations`.
//
// The wrinkle is adopting a database that predates the ledger. Only some of
// the migrations are safely re-runnable (001 alone has 52 statements behind
// 3 guards), so "just run them all" would be destructive. Instead, a
// non-empty database with no ledger is refused until it is told where to
// start:
//
//     npm run migrate -- --baseline 041
//
// which records 001-041 as applied WITHOUT running them, and then applies
// 042 onward normally. Run it once; after that `npm run migrate` is enough
// forever.
// ════════════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/** Where db/migrations sits relative to this file, which differs by three
 *  ways of running it: from source via tsx (backend/scripts/), from the
 *  compiled output (backend/dist/scripts/), and inside the container,
 *  where the Dockerfile copies the SQL to /app/backend/db/migrations
 *  because the runtime image carries no repo checkout. */
const MIGRATIONS_DIR = [
  join(__dirname, "..", "..", "db", "migrations"),       // backend/scripts  -> repo/db/migrations
  join(__dirname, "..", "..", "..", "db", "migrations"), // backend/dist/scripts -> repo/db/migrations
  join(__dirname, "..", "db", "migrations"),             // backend/dist -> backend/db/migrations (image)
].find(existsSync);

interface Migration { name: string; sql: string }

function loadMigrations(): Migration[] {
  if (!MIGRATIONS_DIR) {
    console.error("Could not find db/migrations next to this script.");
    process.exit(1);
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    // Zero-padded numeric prefixes, so a plain lexical sort is the real order.
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

/** The migration whose number is <= `upTo`, by the numeric prefix rather
 *  than by string compare, so `--baseline 41` and `--baseline 041` and
 *  `--baseline 041_tag_group_translations.sql` all mean the same thing. */
function numberOf(name: string): number {
  return parseInt(name.slice(0, 3), 10);
}

async function main() {
  const args = process.argv.slice(2);
  const baselineArg = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : null;
  const dryRun = args.includes("--dry-run");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Inside the stack:");
    console.error("  docker compose -f docker/docker-compose.yml exec backend npm run migrate");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Recorded by --baseline rather than actually executed here. Kept
        -- so "why is 017 in the ledger with no seed tags in the database"
        -- has an answer.
        baselined   BOOLEAN NOT NULL DEFAULT false
      )
    `);

    const migrations = loadMigrations();
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name)
    );

    // Adopting an existing database: the ledger is empty but the schema is not.
    if (applied.size === 0) {
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.recipes') IS NOT NULL AS exists"
      );
      const alreadyInitialised = rows[0]?.exists === true;

      if (alreadyInitialised && !baselineArg) {
        console.error("This database already has a schema but no migration ledger.\n");
        console.error("Most migrations are not safe to re-run, so this will not guess. Tell it");
        console.error("which migration the database is already at — for a stack that was last");
        console.error("started before this release, that is the highest number in db/migrations");
        console.error("at the time it was first created:\n");
        console.error("  npm run migrate -- --baseline 041\n");
        console.error("That records 001-041 as applied without running them, then applies the");
        console.error("rest normally. Only needed once.");
        process.exit(2);
      }

      if (baselineArg) {
        const upTo = numberOf(baselineArg.replace(/^0*/, "").padStart(3, "0"));
        if (!Number.isFinite(upTo)) {
          console.error(`--baseline needs a migration number, got "${baselineArg}"`);
          process.exit(1);
        }
        const baselined = migrations.filter((m) => numberOf(m.name) <= upTo);
        for (const m of baselined) {
          if (!dryRun) {
            await client.query(
              "INSERT INTO schema_migrations (name, baselined) VALUES ($1, true) ON CONFLICT DO NOTHING",
              [m.name]
            );
          }
          applied.add(m.name);
        }
        console.log(`Baselined ${baselined.length} migration(s) up to ${baselineArg} (recorded, not run).`);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.name));
    if (pending.length === 0) {
      console.log(`Up to date — ${migrations.length} migration(s) applied.`);
      return;
    }

    console.log(`${pending.length} pending migration(s):`);
    for (const m of pending) console.log(`  ${m.name}`);
    if (dryRun) {
      console.log("\n--dry-run: nothing was applied.");
      return;
    }

    for (const m of pending) {
      process.stdout.write(`  applying ${m.name} ... `);
      // One transaction per migration: a failure halfway through leaves the
      // database at the last good one rather than half-migrated, and the
      // ledger row commits with the change it describes.
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }

    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
