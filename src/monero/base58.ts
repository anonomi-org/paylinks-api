// src/monero/base58.ts
//
// Monero "cnBase58" implementation (NOT Bitcoin base58).
// Matches the block sizing used by Monero:
// - encode: 8-byte blocks -> 11 chars
// - last block uses special encoded sizes
//
// Ported from your Java MoneroBase58.java (logic-equivalent).

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;

const FULL_BLOCK_SIZE = 8;
const FULL_ENCODED_BLOCK_SIZE = 11;

// decoded bytes -> encoded chars
function getEncodedBlockSize(decodedSize: number): number {
  switch (decodedSize) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 5;
    case 4:
      return 6;
    case 5:
      return 7;
    case 6:
      return 9;
    case 7:
      return 10;
    case 8:
      return 11;
    default:
      throw new Error(`Invalid decoded block size: ${decodedSize}`);
  }
}

// encoded chars -> decoded bytes
function getDecodedBlockSize(encodedSize: number): number {
  switch (encodedSize) {
    case 2:
      return 1;
    case 3:
      return 2;
    case 5:
      return 3;
    case 6:
      return 4;
    case 7:
      return 5;
    case 9:
      return 6;
    case 10:
      return 7;
    case 11:
      return 8;
    default:
      throw new Error(`Invalid encoded block size: ${encodedSize}`);
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  // Big-endian
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  return n;
}

function bigIntToFixedBytes(n: bigint, size: number): Uint8Array {
  // big-endian, zero-padded to `size`
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function encodeBlock(data: Uint8Array, encodedSize: number): string {
  let num = bytesToBigInt(data);
  const chars: string[] = [];

  for (let i = 0; i < encodedSize; i++) {
    const rem = Number(num % BASE);
    chars.push(ALPHABET[rem]!);
    num = num / BASE;
  }

  // Reverse because we built least-significant first
  chars.reverse();
  return chars.join("");
}

function decodeBlock(data: string, decodedSize: number): Uint8Array {
  let num = 0n;

  for (const c of data) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error(`Invalid Base58 character: ${c}`);
    num = num * BASE + BigInt(digit);
  }

  // Convert to bytes, then left-pad / truncate to decodedSize
  // (Same as Java: take last decodedSize bytes)
  const full = bigIntToBytesMinimal(num);

  const out = new Uint8Array(decodedSize);
  const start = full.length > decodedSize ? full.length - decodedSize : 0;
  const length = Math.min(full.length, decodedSize);

  out.set(full.subarray(start, start + length), decodedSize - length);
  return out;
}

function bigIntToBytesMinimal(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  bytes.reverse();
  return new Uint8Array(bytes);
}

/**
 * Encode bytes to Monero cnBase58.
 */
export function cnBase58Encode(data: Uint8Array): string {
  const parts: string[] = [];

  const fullBlockCount = Math.floor(data.length / FULL_BLOCK_SIZE);
  const lastBlockSize = data.length % FULL_BLOCK_SIZE;

  for (let i = 0; i < fullBlockCount; i++) {
    const start = i * FULL_BLOCK_SIZE;
    const block = data.subarray(start, start + FULL_BLOCK_SIZE);
    parts.push(encodeBlock(block, FULL_ENCODED_BLOCK_SIZE));
  }

  if (lastBlockSize > 0) {
    const block = data.subarray(fullBlockCount * FULL_BLOCK_SIZE);
    const encodedSize = getEncodedBlockSize(lastBlockSize);
    parts.push(encodeBlock(block, encodedSize));
  }

  return parts.join("");
}

/**
 * Decode Monero cnBase58 string to bytes.
 */
export function cnBase58Decode(encoded: string): Uint8Array {
  const bytes: number[] = [];

  const fullBlockCount = Math.floor(encoded.length / FULL_ENCODED_BLOCK_SIZE);
  const lastBlockSize = encoded.length % FULL_ENCODED_BLOCK_SIZE;

  for (let i = 0; i < fullBlockCount; i++) {
    const start = i * FULL_ENCODED_BLOCK_SIZE;
    const blockStr = encoded.slice(start, start + FULL_ENCODED_BLOCK_SIZE);
    const decodedBlock = decodeBlock(blockStr, FULL_BLOCK_SIZE);
    for (const b of decodedBlock) bytes.push(b);
  }

  if (lastBlockSize > 0) {
    const blockStr = encoded.slice(fullBlockCount * FULL_ENCODED_BLOCK_SIZE);
    const decodedSize = getDecodedBlockSize(lastBlockSize);
    const decodedBlock = decodeBlock(blockStr, decodedSize);
    for (const b of decodedBlock) bytes.push(b);
  }

  return Uint8Array.from(bytes);
}