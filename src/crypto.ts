import crypto from "crypto";

function getMasterKey(): Buffer {
  const b64 = process.env.PAYLINKS_MASTER_KEY_B64;
  if (!b64) throw new Error("PAYLINKS_MASTER_KEY_B64 is not set");

  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("PAYLINKS_MASTER_KEY_B64 must decode to 32 bytes");
  return key;
}

export function encryptViewKey(viewKey: string): { ciphertextB64: string; nonceB64: string } {
  const key = getMasterKey();
  const nonce = crypto.randomBytes(12); // GCM recommended nonce size
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);

  const plaintext = Buffer.from(viewKey, "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // store enc||tag together so decrypt can split last 16 bytes
  const payload = Buffer.concat([enc, tag]);

  return {
    ciphertextB64: payload.toString("base64"),
    nonceB64: nonce.toString("base64"),
  };
}

export function decryptViewKey(ciphertextB64: string, nonceB64: string): string {
  const key = getMasterKey();
  const nonce = Buffer.from(nonceB64, "base64");
  const payload = Buffer.from(ciphertextB64, "base64");

  if (nonce.length !== 12) throw new Error("Invalid nonce length");

  // payload = enc || tag (tag is last 16 bytes)
  if (payload.length < 16) throw new Error("Invalid ciphertext payload");
  const enc = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);

  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
