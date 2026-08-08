// Known-answer test vectors for Monero address handling.
//
// Provenance: generated from the throwaway mnemonic below with monero-ts 0.11.8.
// The seed is committed on purpose so anyone can regenerate and audit every value
// here. It holds no funds and must never be used for anything but these tests.
//
// The subaddress table was cross-checked against the `subaddress` package at every
// index listed and matched byte-for-byte, which is what makes it safe to swap the
// derivation backend without invalidating paylinks that already exist in the wild.

export const SEED =
  "gone cool possible jackets younger agony giant lower scuba iris okay reruns " +
  "library midst school cycling airport pouch alley yesterday baptism ruthless " +
  "lush mammal cycling";

/** A real mainnet primary address and the view key that actually belongs to it. */
export const VALID = {
  primaryAddress:
    "49YpRdMYkkR6RYpuF2RQeEaP1X7xSNnxLNzvkwZAPBen45RKJcTuJd6CzH8BSA2iW9cSA1a4R6MwnWNst8cFz97G71x9X1E",
  privateViewKey:
    "088e5ba6d3987568e3a248461b3a02ede2915893e6c6a22ef3e77ae39155dc0e",
  publicSpendKeyHex:
    "d127a68202b7fa206c6b8de1687bbbc79012627535cd958385990966067cf712",
} as const;

/** Expected subaddress for account 0 at each minor index. */
export const SUBADDRESSES: Record<number, string> = {
  1: "87ehLFMH1Ye2uQQvjD7qJp1Ca38ac9vhQBDeXQbQPx5Xjo7kWMUni4SaZqeTfL5Cw51gL6Wf3deNnMbCd8WWobfD24zi5F5",
  2: "85bsonB2sCQj3guUaTVvtGSocBm9zXemGNVN2TGAuP73Z7nPjujT11YAfHH2hyyvDmDo5Wqx5qEX5PLbGv16gVsM7877mCu",
  3: "85jzGFVTGVEaVtpJh5QHsQS5V7A5iZQLUKCN5tMiNApnBoLKgb7FWdiSQaeaadXY4uR5taTSLTwqN1bftMRpdJntFctukLR",
  100: "88ZkjxVA1odGuEMJgUixhiEWjrjBnZdn6dRE1Wx4oRoFcXzmdYvRsQq7LGSnAZoSKjGsAVS2rAgHPZtdcGuZzC4YDnSRQjk",
  999: "89ToTX7RDrvMdej3MRj42aGA3XCNgRGeKKi8S9icPqtFWBiopZNTeJoPXw3YZWefS9cXvJPxdzLq94orPSufo3W4Sv1yHes",
  1000: "85Vz2bn8HADQ7rDfdKYR8SMypxA6ha8ebA3m9EKFruMK3METsCZhFdnKfK5p2cWqWwELBqKJ4x8ry6rBWXth8YMaLEaCj3k",
  65535: "84VMyLo7XZXguvEv4fR5duERmuh7h6yJqKp3XC5iGmPp1jbFiGNRh7e5zrvUM9qqPzWxMoz6Ls13dC3eiM9jMp47ReCXPYV",
  999999: "89dVBftkrAyaAuUdjPAe4HZzrFBdrnMW6ZDmCQiAJFiPiFAEpMps8pMSAWZ8Ht4jSC64kznsLNAgN9H5qqVVxYe8DUfaBHX",
  1000000: "88vQfxVNzyA8iCjWpL25P34N9FcFRG3hjaXDVdyQt2BKdWbVWey5HhZ5neuLhnfhG61CRbtfqk48ebA58DvhGnBDJ1eq6i1",
};

/**
 * Addresses that must never be accepted as a paylink's primary address.
 * Every one of these is 69 bytes and decodes cleanly, so a length check alone
 * lets all of them through.
 */
export const REJECT_ADDRESSES = {
  /** Same spend key as VALID, last checksum byte flipped. A wallet catches this typo; we must too. */
  corruptedChecksum:
    "49YpRdMYkkR6RYpuF2RQeEaP1X7xSNnxLNzvkwZAPBen45RKJcTuJd6CzH8BSA2iW9cSA1a4R6MwnWNst8cFz97G74E6R5v",

  /**
   * A different base58 string that decodes to exactly the same bytes as VALID,
   * by overflowing the first 11-character block past 2^64. Accepting this means
   * one wallet can hold two distinct paylinks and any address-keyed dedup is moot.
   */
  malleated:
    "ny51zGypREq6RYpuF2RQeEaP1X7xSNnxLNzvkwZAPBen45RKJcTuJd6CzH8BSA2iW9cSA1a4R6MwnWNst8cFz97G71x9X1E",

  /** A real subaddress (prefix 42). Deriving from a subaddress produces funds nobody can spend. */
  subaddress:
    "87ehLFMH1Ye2uQQvjD7qJp1Ca38ac9vhQBDeXQbQPx5Xjo7kWMUni4SaZqeTfL5Cw51gL6Wf3deNnMbCd8WWobfD24zi5F5",

  /** Wrong network (prefix 53). */
  testnetPrimary:
    "9tVuTexdwbxBngUTM5THPPCRpY9vpVRNvh6QqWTTVhS9HMD6ioLHNTnBoQ4ftpJ37CUJg31PqAAEPgbsfMK9DUaf2VZ5qCD",

  /** Wrong network (prefix 24). */
  stagenetPrimary:
    "59owvKANvH55U5WzZK3zQJUpitPicPqg2EsK5L9oNDqdV9rvafR9FvUaTUZ9JGGjttF5YMsBGiBnz9He8DHpwdP5PdVF9Rx",
} as const;

/** A well-formed view key belonging to a different wallet entirely. */
export const UNRELATED_VIEW_KEY =
  "6dc9933d31d880db862592186b927161e345b00293a9acfcc4228b92c1c6c805";

/** View keys that are not valid Monero scalars at all. */
export const MALFORMED_VIEW_KEYS = [
  "deadbeef", // too short
  "z".repeat(64), // right length, not hex
  "0".repeat(20), // the old schema's lower bound
  "0".repeat(200), // the old schema's upper bound
  "", // empty
] as const;
