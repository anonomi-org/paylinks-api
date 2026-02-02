// src/monero/decodeAddress.ts
import { cnBase58Decode } from "./base58";

export type DecodedMoneroAddress = {
  prefix: number;
  publicSpendKeyHex: string; // 64 hex chars
  publicViewKeyHex: string;  // 64 hex chars
  checksumHex: string;       // 8 hex chars
};

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function decodeStandardAddress(address: string): DecodedMoneroAddress {
  const decoded = cnBase58Decode(address);

  if (decoded.length !== 69) {
    throw new Error(`Invalid decoded address length: ${decoded.length}`);
  }

  const prefix = decoded[0]!; // Safe: length validated above
  const publicSpend = decoded.slice(1, 33);
  const publicView = decoded.slice(33, 65);
  const checksum = decoded.slice(65, 69);

  return {
    prefix,
    publicSpendKeyHex: bytesToHex(publicSpend),
    publicViewKeyHex: bytesToHex(publicView),
    checksumHex: bytesToHex(checksum),
  };
}