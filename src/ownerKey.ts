// Turns the owner key the browser sends into the value we store.
//
// The browser sends sha256("paylinks:ownerkey:v1:<address>:<viewKey>"). We used
// to store that as-is, which meant one wallet's paylinks all shared a string,
// and that string was itself the delete credential. Hashing it again with a
// server-side secret fixes both, and the browser doesn't change.
//
// Separate module because migration 004 has to use the exact same function.

import crypto from "crypto";

/**
 * Stored form of an owner key.
 *
 * No pepper means development. It still hashes rather than storing the raw
 * value, so a missing secret can't quietly write something replayable.
 */
export function hashOwnerKey(ownerKey: string, pepper: string | null): string {
  if (!pepper) {
    return crypto.createHash("sha256").update(ownerKey).digest("hex");
  }
  return crypto.createHmac("sha256", pepper).update(ownerKey).digest("hex");
}
