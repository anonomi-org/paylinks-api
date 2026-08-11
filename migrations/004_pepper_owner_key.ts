import type { MigrationBuilder } from "node-pg-migrate";

import { hashOwnerKey } from "../src/ownerKey";

/**
 * Stop storing a replayable owner key.
 *
 * owner_key held the exact value the delete endpoints accept, so reading the
 * table was enough to delete anyone's paylinks, and one wallet's rows all
 * shared a string that grouped them. Storing a peppered hash fixes both.
 *
 * Two-phase, like 003 did for public_address: this migration adds
 * owner_key_hmac, backfills it, and makes owner_key nullable so the new code
 * can stop writing it. A later one drops owner_key, once nothing old is
 * running. Nothing is destroyed here, so `down` is a real rollback - and the
 * old column keeps working until it's actually dropped.
 *
 * Needs PAYLINKS_OWNER_KEY_PEPPER, and it must match what the API runs with.
 * Backfill with one pepper and serve with another and nobody can delete
 * anything - silently, since delete always answers 200. Hence the check below.
 *
 * Uses pgm.db rather than the pgm builders: the builders only queue SQL, which
 * runs after this function returns, so the backfill would be reading a column
 * that doesn't exist yet. pgm.db runs immediately, in order, inside the
 * runner's transaction, and takes bound parameters.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  const pepper = process.env.PAYLINKS_OWNER_KEY_PEPPER?.trim() || null;

  if (process.env.NODE_ENV === "production" && !pepper) {
    throw new Error(
      "PAYLINKS_OWNER_KEY_PEPPER must be set to run this migration in production. " +
        "It has to match the value the API runs with, or no owner will be able " +
        "to delete their paylinks.",
    );
  }

  await pgm.db.query(`ALTER TABLE paylinks ADD COLUMN owner_key_hmac text`);

  // Through the same function the server uses. Doing it in SQL would mean
  // pgcrypto plus a second implementation to keep in step, and 001 avoided
  // requiring that extension at all.
  const rows: { id: string; owner_key: string }[] = await pgm.db.select(
    `SELECT id, owner_key FROM paylinks WHERE owner_key IS NOT NULL`,
  );

  // unnest keeps this to two bound parameters per batch, the same way the
  // address pool is written in src/store.ts.
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await pgm.db.query(
      `
      UPDATE paylinks AS p
      SET owner_key_hmac = v.hmac
      FROM unnest($1::uuid[], $2::text[]) AS v(id, hmac)
      WHERE p.id = v.id
      `,
      [
        batch.map((r) => r.id),
        batch.map((r) => hashOwnerKey(r.owner_key, pepper)),
      ],
    );
  }

  // Only now, once every existing row has one.
  await pgm.db.query(
    `CREATE INDEX paylinks_owner_key_hmac_idx ON paylinks (owner_key_hmac)`,
  );

  // The new code stops writing owner_key. Until it is dropped it has to accept
  // being absent, or every insert fails against this schema.
  await pgm.db.query(`ALTER TABLE paylinks ALTER COLUMN owner_key DROP NOT NULL`);
}

/**
 * A real rollback: owner_key was never touched, so dropping the new column puts
 * the table back as it was.
 *
 * Exception: paylinks created while the new code ran have no owner_key, and
 * nothing here can derive one. They get an empty string so NOT NULL can be
 * restored. Those rows and their addresses are intact and still serve
 * donations - only deleting them through the old code stops working.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  await pgm.db.query(`DROP INDEX IF EXISTS paylinks_owner_key_hmac_idx`);
  await pgm.db.query(`ALTER TABLE paylinks DROP COLUMN owner_key_hmac`);
  await pgm.db.query(
    `UPDATE paylinks SET owner_key = '' WHERE owner_key IS NULL`,
  );
  await pgm.db.query(`ALTER TABLE paylinks ALTER COLUMN owner_key SET NOT NULL`);
}
