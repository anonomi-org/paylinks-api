// Migration 004 rewrites how ownership is stored for paylinks that already
// exist. Everything here is about the one property that matters: a person who
// created a paylink before the change can still delete it after it, and their
// rows and address pools survive intact.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import crypto from "crypto";

import {
  deletePaylinkByIdAndOwner,
  deletePaylinksByOwner,
  findPaylinkMeta,
  findSubaddress,
} from "../src/store";
import { hashOwnerKey } from "../src/ownerKey";
import { createTestDb, type TestDb } from "./helpers/db";

// Migrations that existed before this change. Stopping here reproduces the
// schema the previous release was running against.
const MIGRATIONS_BEFORE_004 = 3;

const PEPPER = "test-pepper-of-sufficient-length";

/** How the browser derives an owner key, and how the old code stored it. */
function browserOwnerKey(publicAddress: string, privateViewKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`paylinks:ownerkey:v1:${publicAddress}:${privateViewKey}`)
    .digest("hex");
}

const ADDRESS = "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5Uzqt";
const VIEW_KEY = "0".repeat(63) + "1";

let db: TestDb;
let previousPepper: string | undefined;

before(async () => {
  previousPepper = process.env.PAYLINKS_OWNER_KEY_PEPPER;
  process.env.PAYLINKS_OWNER_KEY_PEPPER = PEPPER;

  db = await createTestDb({ upTo: MIGRATIONS_BEFORE_004 });
});

after(async () => {
  await db?.close();

  if (previousPepper === undefined) {
    delete process.env.PAYLINKS_OWNER_KEY_PEPPER;
  } else {
    process.env.PAYLINKS_OWNER_KEY_PEPPER = previousPepper;
  }
});

/** Insert a paylink the way the release before 004 did. */
async function insertLegacyPaylink(ownerKey: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `
    INSERT INTO paylinks (label, gen_mode, min_index, max_index, owner_key, public_address)
    VALUES ($1, 'random', 1, 10, $2, NULL)
    RETURNING id
    `,
    ["Existing paylink", ownerKey],
  );
  return res.rows[0]!.id;
}

async function insertPool(paylinkId: string): Promise<void> {
  await db.query(
    `
    INSERT INTO paylink_subaddresses (paylink_id, subaddress_index, address)
    SELECT $1, idx, 'addr' || idx FROM generate_series(1, 10) AS idx
    `,
    [paylinkId],
  );
}

test("the schema before 004 has no peppered column", async () => {
  // Proves the starting point is genuinely the old schema, so the assertions
  // below are about the migration and not about an already-migrated database.
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'paylinks'`,
  );
  const names = cols.rows.map((c) => c.column_name);
  assert.ok(names.includes("owner_key"));
  assert.ok(!names.includes("owner_key_hmac"));
});

test("migrating carries every existing paylink forward", async () => {
  const ownerKeyA = browserOwnerKey(ADDRESS, VIEW_KEY);
  const ownerKeyB = browserOwnerKey(ADDRESS, "f".repeat(64));

  const first = await insertLegacyPaylink(ownerKeyA);
  const second = await insertLegacyPaylink(ownerKeyA);
  const other = await insertLegacyPaylink(ownerKeyB);
  for (const id of [first, second, other]) await insertPool(id);

  await db.migrate();

  // Every row still exists, and so does its address pool. This is the part a
  // recipient would notice immediately: their donate links keep working.
  for (const id of [first, second, other]) {
    assert.notEqual(await findPaylinkMeta(db, id), null, `${id} disappeared`);
    assert.equal(await findSubaddress(db, id, 5), "addr5");
  }

  // The peppered value was derived from what was already stored.
  const rows = await db.query<{
    owner_key: string | null;
    owner_key_hmac: string | null;
  }>(`SELECT owner_key, owner_key_hmac FROM paylinks WHERE id = $1`, [first]);

  assert.equal(rows.rows[0]?.owner_key_hmac, hashOwnerKey(ownerKeyA, PEPPER));

  // And the original is untouched, which is what makes `down` a real rollback.
  assert.equal(rows.rows[0]?.owner_key, ownerKeyA);
});

test("the stored value is no longer the one a client sends", async () => {
  // The point of the change: reading the database does not hand you something
  // you can replay against the delete endpoint.
  const ownerKey = browserOwnerKey(ADDRESS, VIEW_KEY);
  const row = await db.query<{ owner_key_hmac: string }>(
    `SELECT owner_key_hmac FROM paylinks WHERE owner_key = $1 LIMIT 1`,
    [ownerKey],
  );
  assert.notEqual(row.rows[0]?.owner_key_hmac, ownerKey);
});

test("a paylink created before the change is still deletable by its owner", async () => {
  // The whole reason the migration backfills rather than starting fresh.
  const ownerKey = browserOwnerKey(ADDRESS, VIEW_KEY);
  const id = await insertLegacyPaylinkPostMigration(ownerKey);

  await deletePaylinkByIdAndOwner(db, id, hashOwnerKey(ownerKey, PEPPER));

  assert.equal(await findPaylinkMeta(db, id), null);
});

test("the wrong view key still deletes nothing after the change", async () => {
  const ownerKey = browserOwnerKey(ADDRESS, VIEW_KEY);
  const id = await insertLegacyPaylinkPostMigration(ownerKey);

  const wrong = browserOwnerKey(ADDRESS, "9".repeat(64));
  await deletePaylinkByIdAndOwner(db, id, hashOwnerKey(wrong, PEPPER));

  assert.notEqual(await findPaylinkMeta(db, id), null);

  // And the unpeppered value is not accepted either, which is what stops
  // anyone who has only read the old column from using it.
  await deletePaylinkByIdAndOwner(db, id, ownerKey);
  assert.notEqual(await findPaylinkMeta(db, id), null);
});

test("bulk delete still finds every paylink one wallet owns", async () => {
  const ownerKey = browserOwnerKey(ADDRESS, "a".repeat(64));
  const a = await insertLegacyPaylinkPostMigration(ownerKey);
  const b = await insertLegacyPaylinkPostMigration(ownerKey);

  const otherKey = browserOwnerKey(ADDRESS, "b".repeat(64));
  const untouched = await insertLegacyPaylinkPostMigration(otherKey);

  await deletePaylinksByOwner(db, hashOwnerKey(ownerKey, PEPPER));

  assert.equal(await findPaylinkMeta(db, a), null);
  assert.equal(await findPaylinkMeta(db, b), null);
  assert.notEqual(await findPaylinkMeta(db, untouched), null);
});

/**
 * A row in the shape 004 leaves behind: the peppered column populated, and the
 * legacy column still carrying its original value.
 */
async function insertLegacyPaylinkPostMigration(
  ownerKey: string,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `
    INSERT INTO paylinks (label, gen_mode, min_index, max_index, owner_key, owner_key_hmac)
    VALUES ($1, 'random', 1, 10, $2, $3)
    RETURNING id
    `,
    ["Existing paylink", ownerKey, hashOwnerKey(ownerKey, PEPPER)],
  );
  return res.rows[0]!.id;
}
