// Monero address handling for paylinks.
//
// This module is the single place allowed to interpret a Monero address or a
// private view key. Everything else in the service treats them as opaque strings.

import * as subaddress from "subaddress";
import { decodeStandardAddress } from "./decodeAddress";

/**
 * Preload anything the address backend needs so the first request doesn't pay
 * for it. The current backend is synchronous and has nothing to warm.
 */
export async function warmup(): Promise<void> {
  // no-op
}

/**
 * Reject anything that is not a mainnet primary address paired with its own
 * private view key.
 *
 * NOTE: the current implementation does none of that. It only confirms the
 * address decodes to 69 bytes, which lets through corrupted checksums,
 * subaddresses, testnet and stagenet addresses, base58-malleated forms, and
 * view keys belonging to a completely different wallet. The tests covering
 * this function fail on purpose until the backend is replaced.
 */
export async function assertValidPrimaryAddressAndViewKey(
  publicAddress: string,
  _privateViewKey: string,
): Promise<void> {
  decodeStandardAddress(publicAddress);
}

/** Derive the subaddress at account 0, minor index `index`. */
export async function deriveSubaddress(
  publicAddress: string,
  privateViewKey: string,
  index: number,
): Promise<string> {
  const { publicSpendKeyHex } = decodeStandardAddress(publicAddress);
  return subaddress.getSubaddress(privateViewKey, publicSpendKeyHex, 0, index);
}
