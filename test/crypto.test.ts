import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { decryptViewKey, encryptViewKey } from "../src/crypto";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");

// A realistic payload: a 64-hex private view key.
const VIEW_KEY =
  "088e5ba6d3987568e3a248461b3a02ede2915893e6c6a22ef3e77ae39155dc0e";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.PAYLINKS_MASTER_KEY_B64;
  process.env.PAYLINKS_MASTER_KEY_B64 = KEY_A;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PAYLINKS_MASTER_KEY_B64;
  else process.env.PAYLINKS_MASTER_KEY_B64 = saved;
});

// --- the happy path --------------------------------------------------------

test("round-trips a view key", () => {
  const { ciphertextB64, nonceB64 } = encryptViewKey(VIEW_KEY);
  assert.equal(decryptViewKey(ciphertextB64, nonceB64), VIEW_KEY);
});

test("never stores the plaintext", () => {
  const { ciphertextB64 } = encryptViewKey(VIEW_KEY);
  const payload = Buffer.from(ciphertextB64, "base64");
  // Compare raw bytes: if encryption were ever short-circuited to a pass-through,
  // the plaintext bytes would appear verbatim in what we persist.
  assert.equal(payload.includes(Buffer.from(VIEW_KEY, "utf8")), false);
});

test("uses a fresh nonce every time", () => {
  const nonces = new Set<string>();
  const ciphertexts = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { ciphertextB64, nonceB64 } = encryptViewKey(VIEW_KEY);
    nonces.add(nonceB64);
    ciphertexts.add(ciphertextB64);
  }
  // Nonce reuse under GCM is catastrophic, so this is worth asserting outright.
  assert.equal(nonces.size, 50);
  assert.equal(ciphertexts.size, 50);
});

test("nonce is the 12 bytes GCM expects", () => {
  const { nonceB64 } = encryptViewKey(VIEW_KEY);
  assert.equal(Buffer.from(nonceB64, "base64").length, 12);
});

// --- tampering must be detected, not silently decrypted --------------------

function flipByte(b64: string, index: number): string {
  const buf = Buffer.from(b64, "base64");
  buf[index] = buf[index]! ^ 0xff;
  return buf.toString("base64");
}

test("rejects a tampered ciphertext body", () => {
  const { ciphertextB64, nonceB64 } = encryptViewKey(VIEW_KEY);
  assert.throws(() => decryptViewKey(flipByte(ciphertextB64, 0), nonceB64));
});

test("rejects a tampered auth tag", () => {
  const { ciphertextB64, nonceB64 } = encryptViewKey(VIEW_KEY);
  const len = Buffer.from(ciphertextB64, "base64").length;
  assert.throws(() => decryptViewKey(flipByte(ciphertextB64, len - 1), nonceB64));
});

test("rejects a tampered nonce", () => {
  const { ciphertextB64, nonceB64 } = encryptViewKey(VIEW_KEY);
  assert.throws(() => decryptViewKey(ciphertextB64, flipByte(nonceB64, 0)));
});

test("rejects a nonce of the wrong length", () => {
  const { ciphertextB64 } = encryptViewKey(VIEW_KEY);
  const shortNonce = crypto.randomBytes(8).toString("base64");
  assert.throws(() => decryptViewKey(ciphertextB64, shortNonce));
});

test("rejects a payload too short to hold a tag", () => {
  const { nonceB64 } = encryptViewKey(VIEW_KEY);
  assert.throws(() =>
    decryptViewKey(crypto.randomBytes(8).toString("base64"), nonceB64),
  );
});

// --- key handling ----------------------------------------------------------

test("a ciphertext from one master key does not open with another", () => {
  const { ciphertextB64, nonceB64 } = encryptViewKey(VIEW_KEY);
  process.env.PAYLINKS_MASTER_KEY_B64 = KEY_B;
  assert.throws(() => decryptViewKey(ciphertextB64, nonceB64));
});

test("refuses to run without a master key", () => {
  delete process.env.PAYLINKS_MASTER_KEY_B64;
  assert.throws(() => encryptViewKey(VIEW_KEY), /not set/);
});

test("refuses a master key that is not 32 bytes", () => {
  process.env.PAYLINKS_MASTER_KEY_B64 = crypto.randomBytes(16).toString("base64");
  assert.throws(() => encryptViewKey(VIEW_KEY), /32 bytes/);
});
