// An in-process Postgres for the tests.
//
// PGlite is real Postgres compiled to WASM, so the migrations and queries run
// against the actual engine rather than an emulator - no daemon, no container,
// nothing to install beyond a devDependency. That matters because the schema
// carries real behaviour we depend on: the check constraints, and the foreign
// key that drops a paylink's address pool when the paylink goes.

import path from "node:path";

import type { Queryable } from "../../src/store";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export type TestDb = Queryable & {
  close: () => Promise<void>;

  /**
   * Apply further migrations - the next `count`, or all that remain.
   *
   * This is what lets a test stand on an older schema, write rows the way that
   * release wrote them, and then migrate forward over real data.
   */
  migrate: (count?: number) => Promise<void>;
};

/**
 * A fresh database. Each call is completely isolated.
 *
 * `upTo` stops after that many migrations instead of running them all, so a
 * test can reproduce the schema a previous release was running.
 */
export async function createTestDb(
  options: { upTo?: number } = {},
): Promise<TestDb> {
  // Both packages are ESM-only and this file is CommonJS, so they are pulled
  // in dynamically rather than with a top-level import.
  const { PGlite } = await import("@electric-sql/pglite");
  const { runner } = await import("node-pg-migrate");

  // No extensions: the schema deliberately relies only on core Postgres.
  const pg = new PGlite();
  await pg.waitReady;

  // node-pg-migrate drives a pg-shaped client; PGlite's query() is close
  // enough that this thin adapter is all it needs.
  const dbClient: any = {
    query: (text: any, values?: any) =>
      typeof text === "string"
        ? pg.query(text, values)
        : pg.query(text.text, text.values),
    connect: async () => {},
    end: async () => {},
  };

  const migrate = async (count?: number) => {
    await runner({
      dbClient,
      dir: MIGRATIONS_DIR,
      direction: "up",
      migrationsTable: "pgmigrations",
      verbose: false,
      ...(count === undefined ? {} : { count }),
    });
  };

  await migrate(options.upTo);

  return {
    query: (text: string, values?: unknown[]) =>
      pg.query(text, values as any[]) as any,
    close: () => pg.close(),
    migrate,
  };
}
