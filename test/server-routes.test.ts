// The routes, driven over real HTTP against a real database.
//
// Everything else tests a layer: hashOwnerKey on its own, the store queries on
// their own, the migration on its own. Nothing was checking that server.ts
// wires them together correctly - that a delete request actually peppers what
// it was given before comparing, that a wrong key really is refused, that the
// headers go out. app.inject drives the Fastify instance in-process, so this
// needs no port, no Docker and no network.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import crypto from "crypto";

import { buildApp } from "../src/server";
import { loadConfig, type AppConfig } from "../src/config";
import { hashOwnerKey } from "../src/ownerKey";
import { insertPaylink, insertSubaddresses, type PoolLike } from "../src/store";
import { createTestDb, type TestDb } from "./helpers/db";

const PEPPER = "route-test-pepper-long-enough";

/** What the browser sends. */
function browserOwnerKey(publicAddress: string, privateViewKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`paylinks:ownerkey:v1:${publicAddress}:${privateViewKey}`)
    .digest("hex");
}

const OWNER_VIEW_KEY = "1".repeat(64);
const OTHER_VIEW_KEY = "2".repeat(64);
const ADDRESS = "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5Uzqt";

let db: TestDb;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;

before(async () => {
  db = await createTestDb();

  // One shared connection standing in for a pool. release() is a no-op; the
  // handlers only ever check a client out and put it back.
  const pool: PoolLike = {
    connect: async () => ({
      query: (text: string, values?: unknown[]) => db.query(text, values),
      release: () => {},
    }),
  };

  config = loadConfig({
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "http://site.onion",
    DONATE_BASE_URL: "http://site.onion/paylinks/d#",
    PAYLINKS_FINGERPRINT_KEY: "f".repeat(32),
    PAYLINKS_OWNER_KEY_PEPPER: PEPPER,
    // High enough that the limiter never fires in the tests that are not
    // about rate limiting.
    RATE_LIMIT_MAX: "10000",
    RATE_LIMIT_REQUEST_MAX: "10000",
    RATE_LIMIT_DELETE_MAX: "10000",
  });

  app = await buildApp({ config, pool });
  await app.ready();
});

after(async () => {
  await app?.close();
  await db?.close();
});

/** A paylink owned by `viewKey`, stored the way the server stores one. */
async function createPaylink(viewKey: string): Promise<string> {
  const id = await insertPaylink(db, {
    label: "Tip jar",
    genMode: "random",
    minIndex: 1,
    maxIndex: 5,
    ownerKeyHmac: hashOwnerKey(browserOwnerKey(ADDRESS, viewKey), PEPPER),
  });

  await insertSubaddresses(
    db,
    id,
    [1, 2, 3, 4, 5].map((i) => ({ index: i, address: `8address${i}` })),
  );

  return id;
}

// --- ownership -------------------------------------------------------------

test("the owner's key deletes their paylink", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  const res = await app.inject({
    method: "POST",
    url: `/api/paylinks/${id}/delete`,
    payload: { ownerKey: browserOwnerKey(ADDRESS, OWNER_VIEW_KEY) },
  });

  assert.equal(res.statusCode, 200);

  const meta = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
  assert.equal(meta.statusCode, 404);
});

test("someone else's key does not delete it", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  const res = await app.inject({
    method: "POST",
    url: `/api/paylinks/${id}/delete`,
    payload: { ownerKey: browserOwnerKey(ADDRESS, OTHER_VIEW_KEY) },
  });

  // Answers exactly as a successful delete does, so nothing is learned from it.
  assert.equal(res.statusCode, 200);

  const meta = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
  assert.equal(meta.statusCode, 200, "the paylink was deleted by a wrong key");
});

test("the stored value cannot be replayed as an owner key", async () => {
  // What someone reading the database would have. Before peppering, this was
  // the credential itself.
  const id = await createPaylink(OWNER_VIEW_KEY);
  const stored = hashOwnerKey(browserOwnerKey(ADDRESS, OWNER_VIEW_KEY), PEPPER);

  const res = await app.inject({
    method: "POST",
    url: `/api/paylinks/${id}/delete`,
    payload: { ownerKey: stored },
  });

  assert.equal(res.statusCode, 200);

  const meta = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
  assert.equal(meta.statusCode, 200, "a stored value was accepted as a credential");
});

test("bulk delete takes every paylink for one wallet and no others", async () => {
  const mine = await createPaylink(OWNER_VIEW_KEY);
  const alsoMine = await createPaylink(OWNER_VIEW_KEY);
  const theirs = await createPaylink(OTHER_VIEW_KEY);

  const res = await app.inject({
    method: "POST",
    url: "/api/paylinks/delete",
    payload: { ownerKey: browserOwnerKey(ADDRESS, OWNER_VIEW_KEY) },
  });
  assert.equal(res.statusCode, 200);

  for (const id of [mine, alsoMine]) {
    const meta = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
    assert.equal(meta.statusCode, 404);
  }

  const survived = await app.inject({
    method: "GET",
    url: `/api/paylinks/${theirs}/meta`,
  });
  assert.equal(survived.statusCode, 200, "another wallet's paylink was deleted");
});

test("a malformed owner key is refused outright", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  for (const ownerKey of ["", "short", "z".repeat(64), "a".repeat(63)]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/paylinks/${id}/delete`,
      payload: { ownerKey },
    });
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(ownerKey)}`);
  }

  const meta = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
  assert.equal(meta.statusCode, 200);
});

// --- what the donate page sees ---------------------------------------------

test("meta returns the label and a fingerprint, and no owner material", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  const res = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.label, "Tip jar");
  assert.match(body.fingerprint, /^[0-9a-f]{16}$/);

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("owner"), "meta leaked something owner-shaped");
  assert.ok(!/[0-9a-f]{64}/.test(serialized), "meta leaked a 64-hex value");
});

test("a donation request returns an address from the paylink's own pool", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  const res = await app.inject({
    method: "POST",
    url: `/api/paylinks/${id}/request`,
    payload: { amount: "0.15", description: "coffee" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.match(body.address, /^8address[1-5]$/);
  assert.ok(body.uri.startsWith(`monero:${body.address}`));
  assert.ok(body.uri.includes("tx_amount=0.15"));
});

test("an unknown paylink is indistinguishable from a deleted one", async () => {
  const missing = "00000000-0000-4000-8000-000000000000";

  const meta = await app.inject({ method: "GET", url: `/api/paylinks/${missing}/meta` });
  const request = await app.inject({
    method: "POST",
    url: `/api/paylinks/${missing}/request`,
    payload: {},
  });

  assert.equal(meta.statusCode, 404);
  assert.equal(request.statusCode, 404);
  assert.deepEqual(meta.json(), { error: "paylink_unavailable" });
  assert.deepEqual(request.json(), { error: "paylink_unavailable" });
});

test("a paylink id that is not a uuid is refused without touching the database", async () => {
  for (const id of ["not-a-uuid", "../../etc/passwd", "1"]) {
    const res = await app.inject({
      method: "GET",
      url: `/api/paylinks/${encodeURIComponent(id)}/meta`,
    });
    assert.equal(res.statusCode, 404, `accepted ${id}`);
  }
});

test("a bad amount is rejected rather than passed into the URI", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  for (const amount of ["-1", "abc", "1.0000000000000", "1e5"]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/paylinks/${id}/request`,
      payload: { amount },
    });
    assert.equal(res.statusCode, 400, `accepted amount ${amount}`);
  }
});

// --- headers ---------------------------------------------------------------

test("responses say they must not be stored", async () => {
  const id = await createPaylink(OWNER_VIEW_KEY);

  const res = await app.inject({ method: "GET", url: `/api/paylinks/${id}/meta` });
  assert.match(res.headers["cache-control"] as string, /no-store/);
});

test("HSTS stays off unless it is asked for", async () => {
  // A hidden service is plain HTTP and must never send it.
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.headers["strict-transport-security"], undefined);
});

test("the referrer is never sent onward", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

// --- CORS ------------------------------------------------------------------

test("the configured origin is allowed", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://site.onion" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "http://site.onion");
});

test("an origin that was not configured gets no CORS header", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://evil.onion" },
  });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

// --- timing ----------------------------------------------------------------

test("a missing paylink takes as long to answer as a real one", async () => {
  // The floor is what stops someone finding out which ids exist by timing the
  // replies. Compared as a floor rather than to each other, since the exact
  // durations vary and jitter is added on top.
  const id = await createPaylink(OWNER_VIEW_KEY);

  const time = async (url: string) => {
    const started = process.hrtime.bigint();
    await app.inject({ method: "GET", url });
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const real = await time(`/api/paylinks/${id}/meta`);
  const missing = await time("/api/paylinks/00000000-0000-4000-8000-000000000000/meta");

  assert.ok(real >= 200, `existing paylink answered in ${real}ms`);
  assert.ok(missing >= 200, `missing paylink answered in ${missing}ms`);
});

test("health is not held to the paylink response floor", async () => {
  const started = process.hrtime.bigint();
  const res = await app.inject({ method: "GET", url: "/health" });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(res.statusCode, 200);
  assert.ok(ms < 200, `health took ${ms}ms`);
});
