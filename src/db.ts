import { Pool } from "pg";

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * TLS to the database.
 *
 * Off by default: in the compose file Postgres is on a private network and
 * never published.
 *
 * This is only the default. pg merges the parsed connection string over the
 * config it is given, so any sslmode/ssl/sslcert in DATABASE_URL wins over
 * this - `?ssl=0` connects in plaintext with DATABASE_SSL=true, and
 * `?sslmode=require` enables TLS with it unset. The URL is authoritative.
 */
function ssl(): { rejectUnauthorized: boolean } | false {
  if (process.env.DATABASE_SSL !== "true") return false;
  return { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== "true" };
}

/**
 * Built at startup rather than on import, so loading the server module does
 * not require a database. That is what lets the route tests drive the real
 * handlers against an in-process Postgres.
 */
export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const pool = new Pool({
    connectionString,
    ssl: ssl(),

    // Bounded so a burst cannot open connections until Postgres refuses them.
    max: positiveInt("DATABASE_POOL_MAX", 10),

    // Generous, since creating a paylink writes up to a thousand addresses.
    // It's here to stop a wedged query holding a connection forever.
    statement_timeout: positiveInt("DATABASE_STATEMENT_TIMEOUT_MS", 15_000),

    // A connection that cannot be established should fail rather than hang.
    connectionTimeoutMillis: positiveInt("DATABASE_CONNECT_TIMEOUT_MS", 10_000),
    idleTimeoutMillis: positiveInt("DATABASE_IDLE_TIMEOUT_MS", 30_000),
  });

  // An unhandled pool error takes the process down. These are idle-client
  // failures, not request failures, so log them; requests report their own.
  pool.on("error", (err) => {
    console.error("idle database client error", err);
  });

  return pool;
}
