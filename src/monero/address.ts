// Monero address handling for paylinks.
//
// This module is the single place allowed to interpret a Monero address or a
// private view key. Everything else in the service treats them as opaque
// strings. All of it is delegated to monero-ts, which wraps the same C++ the
// reference wallet uses, so checksums, network prefixes, address types and
// key-to-address binding are all checked by code that Monero itself maintains.

import * as moneroTs from "monero-ts";

const NETWORK = moneroTs.MoneroNetworkType.MAINNET;

/**
 * The submitted address and view key are not a usable mainnet primary pair.
 * Distinct from an internal failure so callers can answer 400 rather than 500.
 */
export class InvalidMoneroCredentials extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneroCredentials";
  }
}

let warming: Promise<unknown> | null = null;

/**
 * Load the WASM module up front. It costs roughly 300ms the first time and
 * well under a millisecond afterwards, so this belongs at boot rather than in
 * the first unlucky request.
 */
export async function warmup(): Promise<void> {
  if (!warming) warming = moneroTs.LibraryUtils.loadWasmModule();
  await warming;
}

/**
 * Tear down the WASM worker. Node keeps running while it is alive, so anything
 * that is meant to exit - the test suite, a one-off script - has to call this.
 * The long-lived server does not.
 */
export async function shutdown(): Promise<void> {
  await moneroTs.shutdown();
}

/**
 * Open a keys-only wallet from an address and view key.
 *
 * This single call rejects a malformed or non-base58 address, a bad checksum,
 * an address from the wrong network, a view key that is not a valid scalar,
 * and a view key belonging to a different wallet. The caller is responsible
 * for closing the handle.
 */
async function openKeysWallet(publicAddress: string, privateViewKey: string) {
  try {
    return await moneroTs.createWalletKeys({
      networkType: NETWORK,
      primaryAddress: publicAddress,
      privateViewKey,
    });
  } catch (err) {
    throw new InvalidMoneroCredentials(
      err instanceof Error ? err.message : "invalid address or view key",
    );
  }
}

/**
 * Reject anything that is not a mainnet *primary* address paired with its own
 * private view key.
 *
 * Opening the wallet covers checksum, network and key binding. Comparing the
 * canonical primary address back against the submitted string adds two things
 * on top: a subaddress cannot masquerade as a primary address, and a
 * base58-malleated spelling that decodes to the same bytes is rejected because
 * it is not the canonical encoding.
 */
export async function assertValidPrimaryAddressAndViewKey(
  publicAddress: string,
  privateViewKey: string,
): Promise<void> {
  const wallet = await openKeysWallet(publicAddress, privateViewKey);
  try {
    const canonical = await wallet.getPrimaryAddress();
    if (canonical !== publicAddress) {
      throw new InvalidMoneroCredentials(
        "address is not the canonical primary address for this wallet",
      );
    }
  } finally {
    await wallet.close();
  }
}

/** Derive the subaddress at account 0, minor index `index`. */
export async function deriveSubaddress(
  publicAddress: string,
  privateViewKey: string,
  index: number,
): Promise<string> {
  const wallet = await openKeysWallet(publicAddress, privateViewKey);
  try {
    return await wallet.getAddress(0, index);
  } finally {
    await wallet.close();
  }
}

/**
 * Derive every subaddress from `fromIndex` to `toIndex` inclusive.
 *
 * One wallet handle is opened for the whole range rather than one per address,
 * which is what makes precomputing a pool at creation time affordable. The
 * caller is expected to have bounded the range already.
 */
export async function deriveSubaddressRange(
  publicAddress: string,
  privateViewKey: string,
  fromIndex: number,
  toIndex: number,
): Promise<{ index: number; address: string }[]> {
  const wallet = await openKeysWallet(publicAddress, privateViewKey);
  try {
    const out: { index: number; address: string }[] = [];
    for (let index = fromIndex; index <= toIndex; index++) {
      out.push({ index, address: await wallet.getAddress(0, index) });
    }
    return out;
  } finally {
    await wallet.close();
  }
}
