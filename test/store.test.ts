import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import {
  deletePaylinkByIdAndOwner,
  deletePaylinksByOwner,
  findPaylinkForRequest,
  findPaylinkMeta,
  findSubaddress,
  insertPaylink,
  insertSubaddresses,
  type NewPaylink,
} from "../src/store";
import { createTestDb, type TestDb } from "./helpers/db";

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

function paylink(overrides: Partial<NewPaylink> = {}): NewPaylink {
  return {
    label: "Coffee",
    genMode: "random",
    minIndex: 1,
    maxIndex: 10,
    ownerKey: OWNER_A,
    ...overrides,
  };
}

function pool(from: number, to: number) {
  const out: { index: number; address: string }[] = [];
  for (let i = from; i <= to; i++) {
    out.push({ index: i, address: `8addr${String(i).padStart(7, "0")}` });
  }
  return out;
}

async function countSubaddresses(paylinkId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM paylink_subaddresses WHERE paylink_id = $1`,
    [paylinkId],
  );
  return r.rows[0]!.n;
}

// --- creation --------------------------------------------------------------

test("inserts a paylink and returns its id", async () => {
  const id = await insertPaylink(db, paylink());
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test("stores no view key material at all", async () => {
  // The whole point of the precompute change: there is nowhere left to put one.
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'paylinks'`,
  );
  const names = cols.rows.map((c) => c.column_name);
  assert.ok(!names.includes("encrypted_view_key"));
  assert.ok(!names.includes("encryption_nonce"));
});

test("records no recipient address for a new paylink", async () => {
  // The column still exists so an older release keeps working, but nothing
  // writes to it now.
  const id = await insertPaylink(db, paylink());

  const r = await db.query<{ public_address: string | null }>(
    `SELECT public_address FROM paylinks WHERE id = $1`,
    [id],
  );
  assert.equal(r.rows[0]?.public_address, null);
});

test("the address column no longer demands a value", async () => {
  // What 003 had to do for the insert above to work. Checking the schema rather
  // than a row count is what catches the migration being reverted.
  const col = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'paylinks' AND column_name = 'public_address'`,
  );
  assert.equal(col.rows[0]?.is_nullable, "YES");
});

test("writes a whole address pool in one statement", async () => {
  const id = await insertPaylink(db, paylink({ minIndex: 1, maxIndex: 1000 }));
  await insertSubaddresses(db, id, pool(1, 1000));
  assert.equal(await countSubaddresses(id), 1000);
});

test("keeps each paylink's pool separate", async () => {
  const a = await insertPaylink(db, paylink());
  const b = await insertPaylink(db, paylink({ ownerKey: OWNER_B }));
  await insertSubaddresses(db, a, pool(1, 10));
  await insertSubaddresses(db, b, pool(1, 10));

  assert.equal(await findSubaddress(db, a, 5), "8addr0000005");
  assert.notEqual(a, b);
  assert.equal(await countSubaddresses(a), 10);
  assert.equal(await countSubaddresses(b), 10);
});

// --- reads -----------------------------------------------------------------

test("finds metadata for an existing paylink", async () => {
  const id = await insertPaylink(db, paylink({ label: "Tip jar" }));
  const meta = await findPaylinkMeta(db, id);
  assert.equal(meta?.label, "Tip jar");
  assert.equal(meta?.active, true);
  assert.equal(meta?.deleted_at, null);
});

test("returns null for a paylink that does not exist", async () => {
  const meta = await findPaylinkMeta(
    db,
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(meta, null);
});

test("finds the fields the donation endpoint needs", async () => {
  const id = await insertPaylink(db, paylink({ minIndex: 3, maxIndex: 42 }));
  const row = await findPaylinkForRequest(db, id);
  assert.equal(row?.min_index, 3);
  assert.equal(row?.max_index, 42);
  assert.equal(row?.gen_mode, "random");
});

test("returns an address for an index inside the pool", async () => {
  const id = await insertPaylink(db, paylink());
  await insertSubaddresses(db, id, pool(1, 10));
  assert.equal(await findSubaddress(db, id, 7), "8addr0000007");
});

test("returns null for an index outside the pool", async () => {
  const id = await insertPaylink(db, paylink());
  await insertSubaddresses(db, id, pool(1, 10));
  assert.equal(await findSubaddress(db, id, 99), null);
});

// --- deletion --------------------------------------------------------------

test("a wrong owner key deletes nothing", async () => {
  const id = await insertPaylink(db, paylink());
  await insertSubaddresses(db, id, pool(1, 10));

  await deletePaylinkByIdAndOwner(db, id, OWNER_B);

  assert.notEqual(await findPaylinkMeta(db, id), null);
  assert.equal(await countSubaddresses(id), 10);
});

test("the right owner key deletes the paylink and its whole pool", async () => {
  const id = await insertPaylink(db, paylink());
  await insertSubaddresses(db, id, pool(1, 10));

  await deletePaylinkByIdAndOwner(db, id, OWNER_A);

  assert.equal(await findPaylinkMeta(db, id), null);
  // Left behind, these rows would be addresses with no owner and no way to
  // reach them - the cascade is what keeps that from happening.
  assert.equal(await countSubaddresses(id), 0);
});

test("bulk delete removes every paylink for an owner, and no others", async () => {
  const mine1 = await insertPaylink(db, paylink({ ownerKey: OWNER_A }));
  const mine2 = await insertPaylink(db, paylink({ ownerKey: OWNER_A }));
  const theirs = await insertPaylink(db, paylink({ ownerKey: OWNER_B }));
  for (const id of [mine1, mine2, theirs]) {
    await insertSubaddresses(db, id, pool(1, 10));
  }

  await deletePaylinksByOwner(db, OWNER_A);

  assert.equal(await findPaylinkMeta(db, mine1), null);
  assert.equal(await findPaylinkMeta(db, mine2), null);
  assert.notEqual(await findPaylinkMeta(db, theirs), null);
  assert.equal(await countSubaddresses(mine1), 0);
  assert.equal(await countSubaddresses(theirs), 10);
});

// --- schema constraints ----------------------------------------------------

test("the schema refuses min_index above max_index", async () => {
  await assert.rejects(() =>
    insertPaylink(db, paylink({ minIndex: 50, maxIndex: 10 })),
  );
});

test("the schema refuses a gen_mode other than random", async () => {
  await assert.rejects(() =>
    insertPaylink(db, paylink({ genMode: "sequential" })),
  );
});

test("the schema refuses an address with no parent paylink", async () => {
  await assert.rejects(() =>
    insertSubaddresses(db, "00000000-0000-4000-8000-000000000000", pool(1, 1)),
  );
});
