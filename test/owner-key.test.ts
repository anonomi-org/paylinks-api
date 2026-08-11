import test from "node:test";
import assert from "node:assert/strict";

import crypto from "crypto";

import { hashOwnerKey } from "../src/ownerKey";

const PEPPER = "a-pepper-of-sufficient-length";

/** Exactly what the browser sends, and what the API derives at creation. */
function browserOwnerKey(publicAddress: string, privateViewKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`paylinks:ownerkey:v1:${publicAddress}:${privateViewKey}`)
    .digest("hex");
}

test("the owner key format matches the one the browser computes", () => {
  // Pinned against the same vector asserted in the website's test suite
  // (src/lib/paylinksClient.test.ts). If these two ever disagree, every
  // existing paylink becomes undeletable, so they are checked on both sides.
  const address =
    "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge";
  const viewKey = "0".repeat(63) + "1";

  assert.equal(
    browserOwnerKey(address, viewKey),
    "c0aeb3e6dcac211c53c560b8b950b815384ab8b61b7ef59be14067e796b8ade8",
  );
});

test("peppering produces something other than what was sent", () => {
  const sent = browserOwnerKey("addr", "key");
  assert.notEqual(hashOwnerKey(sent, PEPPER), sent);
});

test("peppering is deterministic", () => {
  const sent = browserOwnerKey("addr", "key");
  assert.equal(hashOwnerKey(sent, PEPPER), hashOwnerKey(sent, PEPPER));
});

test("a different pepper produces a different stored value", () => {
  // Why losing the pepper is unrecoverable: nothing derived under one value
  // will ever match a comparison made under another.
  const sent = browserOwnerKey("addr", "key");
  assert.notEqual(hashOwnerKey(sent, PEPPER), hashOwnerKey(sent, "another-pepper-entirely"));
});

test("two wallets never collide under the same pepper", () => {
  const a = browserOwnerKey("addr", "key-a");
  const b = browserOwnerKey("addr", "key-b");
  assert.notEqual(hashOwnerKey(a, PEPPER), hashOwnerKey(b, PEPPER));
});

test("without a pepper it still hashes rather than passing the value through", () => {
  // Development has no secret configured. The stored shape has to stay a
  // digest anyway, so a missing pepper cannot quietly write a value that
  // could be replayed straight back at the delete endpoint.
  const sent = browserOwnerKey("addr", "key");
  const stored = hashOwnerKey(sent, null);

  assert.notEqual(stored, sent);
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(
    stored,
    crypto.createHash("sha256").update(sent).digest("hex"),
  );
});

test("the peppered and unpeppered forms differ", () => {
  const sent = browserOwnerKey("addr", "key");
  assert.notEqual(hashOwnerKey(sent, null), hashOwnerKey(sent, PEPPER));
});

test("the result is always a 64-character hex digest", () => {
  for (const pepper of [null, PEPPER, "x".repeat(200)]) {
    assert.match(hashOwnerKey("anything", pepper), /^[0-9a-f]{64}$/);
  }
});
