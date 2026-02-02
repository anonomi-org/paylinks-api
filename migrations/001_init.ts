import type { MigrationBuilder } from "node-pg-migrate";

const MAX_INDEX = 1_000_000;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Ensure pgcrypto for gen_random_uuid()
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  pgm.createTable("paylinks", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },

    // User-defined label (optional, can be null)
    label: {
      type: "text",
      notNull: false,
    },

    // Monero primary address (contains public spend key + public view key)
    public_address: {
      type: "text",
      notNull: true,
    },

    // AES-256-GCM encrypted private view key (base64)
    encrypted_view_key: {
      type: "text",
      notNull: true,
    },

    // GCM nonce/IV used for encryption (base64)
    encryption_nonce: {
      type: "text",
      notNull: true,
    },

    // Subaddress generation mode (only 'random' supported)
    gen_mode: {
      type: "text",
      notNull: true,
      default: "'random'",
    },

    // Subaddress index range
    min_index: {
      type: "integer",
      notNull: true,
      default: 1,
    },

    max_index: {
      type: "integer",
      notNull: true,
      default: 100,
    },

    // SHA-256 hash of publicAddress + privateViewKey for ownership verification
    owner_key: {
      type: "text",
      notNull: true,
    },

    // Soft delete / active flag
    active: {
      type: "boolean",
      notNull: true,
      default: true,
    },

    deleted_at: {
      type: "timestamptz",
      notNull: false,
    },

    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // Enforce random-only mode
  pgm.addConstraint("paylinks", "paylinks_gen_mode_random_chk", {
    check: "gen_mode = 'random'",
  });

  // Validate index ranges
  pgm.addConstraint("paylinks", "paylinks_min_index_range_chk", {
    check: `min_index >= 1 AND min_index <= ${MAX_INDEX}`,
  });

  pgm.addConstraint("paylinks", "paylinks_max_index_range_chk", {
    check: `max_index >= 1 AND max_index <= ${MAX_INDEX}`,
  });

  pgm.addConstraint("paylinks", "paylinks_min_le_max_chk", {
    check: "min_index <= max_index",
  });

  // Indexes for common queries
  pgm.createIndex("paylinks", ["owner_key"], { name: "paylinks_owner_key_idx" });
  pgm.createIndex("paylinks", ["active"], { name: "paylinks_active_idx" });
  pgm.createIndex("paylinks", ["created_at"], { name: "paylinks_created_at_idx" });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("paylinks");
}
