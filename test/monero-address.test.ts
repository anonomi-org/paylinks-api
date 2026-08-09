import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import {
  assertValidPrimaryAddressAndViewKey,
  deriveSubaddress,
  deriveSubaddressRange,
  shutdown,
  warmup,
} from "../src/monero/address";

import {
  MALFORMED_VIEW_KEYS,
  REJECT_ADDRESSES,
  SUBADDRESSES,
  UNRELATED_VIEW_KEY,
  VALID,
} from "./vectors";

before(async () => {
  await warmup();
});

// The WASM worker holds the event loop open, so without this the suite passes
// and then hangs forever instead of exiting.
after(async () => {
  await shutdown();
});

// --- what must be accepted -------------------------------------------------

test("accepts a genuine mainnet primary address with its own view key", async () => {
  await assertValidPrimaryAddressAndViewKey(
    VALID.primaryAddress,
    VALID.privateViewKey,
  );
});

// --- what must be rejected -------------------------------------------------
//
// Each of these decodes to 69 bytes, so nothing here is caught by a length check.

for (const [name, address] of Object.entries(REJECT_ADDRESSES)) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(() =>
      assertValidPrimaryAddressAndViewKey(address, VALID.privateViewKey),
    );
  });
}

test("rejects a view key that belongs to a different wallet", async () => {
  // This is the one that loses money silently: the paylink looks healthy and
  // every donation lands on a subaddress the real wallet never scans.
  await assert.rejects(() =>
    assertValidPrimaryAddressAndViewKey(
      VALID.primaryAddress,
      UNRELATED_VIEW_KEY,
    ),
  );
});

for (const key of MALFORMED_VIEW_KEYS) {
  test(`rejects malformed view key ${JSON.stringify(key.slice(0, 12))} (len ${key.length})`, async () => {
    await assert.rejects(() =>
      assertValidPrimaryAddressAndViewKey(VALID.primaryAddress, key),
    );
  });
}

test("rejects an address that is not base58 at all", async () => {
  await assert.rejects(() =>
    assertValidPrimaryAddressAndViewKey("not an address", VALID.privateViewKey),
  );
});

// --- derivation ------------------------------------------------------------
//
// These lock the derivation output to known values. They passed against the
// `subaddress` package before the monero-ts migration and must keep passing
// after it, otherwise every paylink already in the database breaks.

for (const [index, expected] of Object.entries(SUBADDRESSES)) {
  test(`derives the expected subaddress at index ${index}`, async () => {
    const got = await deriveSubaddress(
      VALID.primaryAddress,
      VALID.privateViewKey,
      Number(index),
    );
    assert.equal(got, expected);
  });
}

test("derived subaddresses are distinct per index", async () => {
  const seen = new Set<string>();
  for (const index of [1, 2, 3, 100, 999]) {
    seen.add(
      await deriveSubaddress(
        VALID.primaryAddress,
        VALID.privateViewKey,
        index,
      ),
    );
  }
  assert.equal(seen.size, 5);
});

// --- batch derivation ------------------------------------------------------
//
// This is the path that lets the service avoid storing a view key: the whole
// pool is derived once at creation. If it ever disagreed with single derivation
// a paylink would serve addresses its owner's wallet does not watch.

test("batch derivation agrees with the golden vectors", async () => {
  const range = await deriveSubaddressRange(
    VALID.primaryAddress,
    VALID.privateViewKey,
    1,
    1000,
  );
  const byIndex = new Map(range.map((r) => [r.index, r.address]));

  for (const [index, expected] of Object.entries(SUBADDRESSES)) {
    const i = Number(index);
    if (i > 1000) continue;
    assert.equal(byIndex.get(i), expected, `index ${i}`);
  }
});

test("batch derivation agrees with single derivation", async () => {
  const range = await deriveSubaddressRange(
    VALID.primaryAddress,
    VALID.privateViewKey,
    7,
    11,
  );
  for (const { index, address } of range) {
    const single = await deriveSubaddress(
      VALID.primaryAddress,
      VALID.privateViewKey,
      index,
    );
    assert.equal(address, single, `index ${index}`);
  }
});

test("batch derivation covers the range inclusively and in order", async () => {
  const range = await deriveSubaddressRange(
    VALID.primaryAddress,
    VALID.privateViewKey,
    5,
    9,
  );
  assert.deepEqual(
    range.map((r) => r.index),
    [5, 6, 7, 8, 9],
  );
  assert.equal(new Set(range.map((r) => r.address)).size, 5);
});

test("batch derivation of a single index still works", async () => {
  const range = await deriveSubaddressRange(
    VALID.primaryAddress,
    VALID.privateViewKey,
    1,
    1,
  );
  assert.equal(range.length, 1);
  assert.equal(range[0]!.address, SUBADDRESSES[1]);
});

test("batch derivation rejects credentials it should not accept", async () => {
  await assert.rejects(() =>
    deriveSubaddressRange(
      VALID.primaryAddress,
      UNRELATED_VIEW_KEY,
      1,
      5,
    ),
  );
});

test("a derived subaddress is never the primary address", async () => {
  for (const index of [1, 2, 1_000_000]) {
    const got = await deriveSubaddress(
      VALID.primaryAddress,
      VALID.privateViewKey,
      index,
    );
    assert.notEqual(got, VALID.primaryAddress);
  }
});
