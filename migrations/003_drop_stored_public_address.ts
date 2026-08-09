import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Stop keeping the recipient's own address.
 *
 * public_address was written at creation and never read again - no query in
 * src/store.ts selects it, and ownership is proved against owner_key, which the
 * browser computes. It was the one column tying a paylink back to the person
 * collecting on it.
 *
 * Destructive: the UPDATE erases every address already stored, and nothing here
 * can regenerate them. Take a backup first.
 *
 * Run this before deploying the code that stops writing the column - until then
 * public_address is NOT NULL with no default, so inserts that omit it fail. The
 * column is left in place rather than dropped so the previous release keeps
 * working against this schema. Dropping it comes later, once nothing old is
 * still running.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn("paylinks", "public_address", { notNull: false });

  pgm.sql(`UPDATE paylinks SET public_address = NULL`);
}

/**
 * Reversible in shape only, like 002: the constraint comes back, the addresses
 * do not. Rows are backfilled with an empty string so NOT NULL can be applied
 * at all, which leaves the column present and meaningless.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `UPDATE paylinks SET public_address = '' WHERE public_address IS NULL`,
  );

  pgm.alterColumn("paylinks", "public_address", { notNull: true });
}
