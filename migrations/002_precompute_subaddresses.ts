import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Stop storing private view keys.
 *
 * Subaddresses used to be derived on demand, which meant the service had to
 * keep every user's view key decryptable at rest. One compromise of the
 * container and its environment would have handed over enough to reconstruct
 * the full transaction history of every recipient and every donor.
 *
 * They are now derived once, while the key is in hand at creation, and stored.
 * The key itself is never written down.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("paylink_subaddresses", {
    paylink_id: {
      type: "uuid",
      notNull: true,
      references: "paylinks",
      onDelete: "CASCADE",
    },

    // Minor index under account 0, matching the paylink's min_index/max_index.
    subaddress_index: {
      type: "integer",
      notNull: true,
    },

    address: {
      type: "text",
      notNull: true,
    },
  });

  // Serving a donation is a lookup by (paylink, index), so that is the key.
  pgm.addConstraint("paylink_subaddresses", "paylink_subaddresses_pkey", {
    primaryKey: ["paylink_id", "subaddress_index"],
  });

  pgm.dropColumns("paylinks", ["encrypted_view_key", "encryption_nonce"]);
}

/**
 * Reversible in shape only. The columns come back empty because the view keys
 * they held are gone, and nothing in this service can regenerate them - that
 * is the entire point of the change. A paylink created after this migration
 * cannot be served by the old on-demand derivation code.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("paylinks", {
    encrypted_view_key: { type: "text", notNull: false },
    encryption_nonce: { type: "text", notNull: false },
  });

  pgm.dropTable("paylink_subaddresses");
}
