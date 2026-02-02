import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import "dotenv/config";
import { z } from "zod";
import { pool } from "./db";
import { encryptViewKey, decryptViewKey } from "./crypto";
import { buildMoneroUri } from "./moneroUri";
import { decodeStandardAddress } from "./monero/decodeAddress";
import * as subaddress from "subaddress";
import crypto from "crypto";

const MAX_SUBADDRESS_INDEX = 1_000_000;
const DEFAULT_MIN_INDEX = 1;
const DEFAULT_MAX_INDEX = 100;

function getAllowedOrigins(): string[] | true {
  const env = process.env.ALLOWED_ORIGINS;
  if (!env || env === "*") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ALLOWED_ORIGINS must be set in production (not '*')");
    }
    return true; // Allow all in development
  }
  return env.split(",").map((o) => o.trim()).filter(Boolean);
}

// --- Schemas ---
const PaylinkOptionsSchema = z
  .object({
    label: z.string().max(80).optional(),
    genMode: z.enum(["random", "sequential"]).optional(), // sequential rejected for now
    minIndex: z.number().int().positive().optional(),
    maxIndex: z.number().int().positive().optional(),
  })
  .optional();

const CreatePaylinkSchema = z.object({
  publicAddress: z.string().trim().min(20).max(200),
  privateViewKey: z.string().trim().min(20).max(200),
  options: PaylinkOptionsSchema,
});

const RequestDonationSchema = z.object({
  amount: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const s = v.trim();
      return s === "" ? undefined : s;
    },
    z
      .string()
      .max(40)
      .regex(/^\d+(\.\d+)?$/, "amount must be a number")
      .optional(),
  ),
  description: z.string().trim().max(140).optional().default(""),
});

const DeleteByOwnerKeySchema = z.object({
  ownerKey: z
    .string()
    .trim()
    .length(64)
    .regex(/^[0-9a-f]{64}$/i, "ownerKey must be 64 hex chars"),
});

function clampIndex(n: number) {
  return Math.max(1, Math.min(n, MAX_SUBADDRESS_INDEX));
}

function normalizeRange(
  minRaw: number | null | undefined,
  maxRaw: number | null | undefined,
  fallbackMin: number,
  fallbackMax: number,
) {
  const min = Number.isFinite(minRaw as any) ? Number(minRaw) : fallbackMin;
  const max = Number.isFinite(maxRaw as any) ? Number(maxRaw) : fallbackMax;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return { lo, hi };
}

function computePaylinkFingerprint(paylinkId: string) {
  const key = process.env.PAYLINKS_FINGERPRINT_KEY;
  if (!key || key.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PAYLINKS_FINGERPRINT_KEY must be set (>=16 chars) in production",
      );
    }
    return crypto
      .createHash("sha256")
      .update(paylinkId)
      .digest("hex")
      .slice(0, 16);
  }
  return crypto
    .createHmac("sha256", key)
    .update(paylinkId)
    .digest("hex")
    .slice(0, 16);
}

// return first/last chars for verification
function previewAddr(addr: string, n = 6) {
  const s = String(addr || "");
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function genericDeleteMessageSingle(id: string) {
  return `If it existed, paylink ${id} was deleted.`;
}

function genericDeleteMessageBulk() {
  return "If any existed, all paylinks associated with the provided owner key were deleted.";
}

async function uniformDelay() {
  
  const ms = 150 + crypto.randomInt(0, 120);
  await new Promise((r) => setTimeout(r, ms));
}

function computeOwnerKey(publicAddress: string, privateViewKey: string) {
  return crypto
    .createHash("sha256")
    .update(`paylinks:ownerkey:v1:${publicAddress}:${privateViewKey}`)
    .digest("hex");
}

async function main() {
  const app = Fastify({
    logger: {
      level: "info",
      redact: {
        paths: ["req.body.ownerKey", "req.body.privateViewKey"],
        remove: true,
      },
    },
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: getAllowedOrigins(), methods: ["GET", "POST"] });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.get("/health", async () => ({ ok: true }));

  // PUBLIC METADATA (used by donation page on load)
  // Returns label + fingerprint 
  app.get("/api/paylinks/:id/meta", async (req, reply) => {
    const id = (req.params as any)?.id as string;

    const client = await pool.connect();
    try {
      const r = await client.query<{
        label: string | null;
        active: boolean;
        deleted_at: string | null;
      }>(
        `
      SELECT label, active, deleted_at
      FROM paylinks
      WHERE id = $1
      LIMIT 1
      `,
        [id],
      );

      if (r.rowCount !== 1) {
        return reply.code(404).send({ error: "paylink_not_found" });
      }

      const row = r.rows[0]!;
      if (!row.active)
        return reply.code(410).send({ error: "paylink_inactive" });
      if (row.deleted_at)
        return reply.code(410).send({ error: "paylink_deleted" });

      const fingerprint = computePaylinkFingerprint(id);

      return reply.code(200).send({
        paylinkId: id,
        label: row.label ?? "",
        fingerprint,
      });
    } catch (err) {
      req.log.error({ err }, "paylink meta failed");
      return reply.code(500).send({ error: "internal_error" });
    } finally {
      client.release();
    }
  });

  // CREATE (always creates a new paylink)
  app.post("/api/paylinks", async (req, reply) => {
    const parsed = CreatePaylinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { publicAddress, privateViewKey } = parsed.data;
    const options = parsed.data.options ?? {};

    const rawLabel =
      typeof options.label === "string"
        ? options.label.trim().slice(0, 80)
        : "";

    const label = rawLabel.length > 0 ? rawLabel : null;

    // Random-only
    const genModeRaw = String(options.genMode ?? "random").toLowerCase();
    if (genModeRaw === "sequential") {
      return reply.code(400).send({
        error: "invalid_request",
        details: {
          options: {
            genMode: ["'sequential' is not supported. Use 'random'."],
          },
        },
      });
    }
    const genMode: "random" = "random";

    const minIndexRaw = Number.isFinite(options.minIndex as any)
      ? Math.trunc(Number(options.minIndex))
      : null;
    const maxIndexRaw = Number.isFinite(options.maxIndex as any)
      ? Math.trunc(Number(options.maxIndex))
      : null;

    // Validate raw bounds if provided
    if (
      minIndexRaw !== null &&
      (minIndexRaw < 1 || minIndexRaw > MAX_SUBADDRESS_INDEX)
    ) {
      return reply.code(400).send({
        error: "invalid_request",
        details: {
          options: {
            minIndex: [
              `minIndex must be between 1 and ${MAX_SUBADDRESS_INDEX}`,
            ],
          },
        },
      });
    }
    if (
      maxIndexRaw !== null &&
      (maxIndexRaw < 1 || maxIndexRaw > MAX_SUBADDRESS_INDEX)
    ) {
      return reply.code(400).send({
        error: "invalid_request",
        details: {
          options: {
            maxIndex: [
              `maxIndex must be between 1 and ${MAX_SUBADDRESS_INDEX}`,
            ],
          },
        },
      });
    }

    // Canonicalized + clamped
    const { lo, hi } = normalizeRange(
      minIndexRaw,
      maxIndexRaw,
      DEFAULT_MIN_INDEX,
      DEFAULT_MAX_INDEX,
    );
    const minIndex = clampIndex(lo);
    const maxIndex = clampIndex(hi);

    // Compute preview so the user can sanity-check in their wallet UI
    let addressPreview: string | null = null;

    try {
      const decoded = decodeStandardAddress(publicAddress);

      const addrAtMin = subaddress.getSubaddress(
        privateViewKey,
        decoded.publicSpendKeyHex,
        0,
        minIndex,
      );

      addressPreview = previewAddr(addrAtMin);
    } catch {
      return reply.code(400).send({
        error: "invalid_request",
        details: { publicAddress: ["Invalid Monero primary address."] },
      });
    }

    const { ciphertextB64, nonceB64 } = encryptViewKey(privateViewKey);

    const ownerKey = computeOwnerKey(publicAddress, privateViewKey);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertRes = await client.query<{ id: string }>(
        `
        INSERT INTO paylinks (
          label,
          public_address,
          encrypted_view_key,
          encryption_nonce,
          gen_mode,
          min_index,
          max_index,
          owner_key
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id
        `,
        [
          label,
          publicAddress,
          ciphertextB64,
          nonceB64,
          genMode,
          minIndex,
          maxIndex,
          ownerKey,
        ],
      );

      const id = insertRes.rows[0]?.id;
      if (!id) throw new Error("Failed to create paylink");

      await client.query("COMMIT");

      const donateUrl = `https://anonomi.org/paylinks/d#${id}`;
      const embedHtml =
        `<!-- Anonomi Paylinks -->\n` +
        `<a href="${donateUrl}" rel="nofollow noopener" target="_blank">Donate XMR</a>\n`;

      const fingerprint = computePaylinkFingerprint(id);

      return reply.code(201).send({
        id,
        label,
        donateUrl,
        embedHtml,
        fingerprint,
        genMode,
        minIndex,
        maxIndex,
        addressPreview,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ err }, "create paylink failed");
      return reply.code(500).send({ error: "internal_error" });
    } finally {
      client.release();
    }
  });

  // DELETE ONE (hard delete by id + ownerKey)
  app.post("/api/paylinks/:id/delete", async (req, reply) => {
    const id = (req.params as any)?.id as string;

    const parsed = DeleteByOwnerKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { ownerKey } = parsed.data;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Only deletes if BOTH match.
      await client.query(
        `
      DELETE FROM paylinks
      WHERE id = $1 AND owner_key = $2
      `,
        [id, ownerKey],
      );

      await client.query("COMMIT");

      // Random delay before responding, so that timing differences don’t leak information.
      await uniformDelay();

      // Always 200, never indicates if it existed or matched
      return reply.code(200).send({
        ok: true,
        message: genericDeleteMessageSingle(id),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ err }, "delete paylink failed");

      return reply.code(500).send({ error: "internal_error" });
    } finally {
      client.release();
    }
  });

  app.post("/api/paylinks/delete", async (req, reply) => {
    const parsed = DeleteByOwnerKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { ownerKey } = parsed.data;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
      DELETE FROM paylinks
      WHERE owner_key = $1
      `,
        [ownerKey],
      );

      await client.query("COMMIT");

      await uniformDelay();

      return reply.code(200).send({
        ok: true,
        message: genericDeleteMessageBulk(),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ err }, "bulk delete paylinks failed");
      return reply.code(500).send({ error: "internal_error" });
    } finally {
      client.release();
    }
  });

  // Donor requests a payment payload (random index each time)
  app.post("/api/paylinks/:id/request", async (req, reply) => {
    const id = (req.params as any)?.id as string;

    const parsed = RequestDonationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { amount, description } = parsed.data;

    const client = await pool.connect();
    try {
      const paylinkRes = await client.query<{
        label: string;
        public_address: string;
        encrypted_view_key: string;
        encryption_nonce: string;
        active: boolean;
        deleted_at: string | null;
        gen_mode: string;
        min_index: number;
        max_index: number;
      }>(
        `
        SELECT
          label,
          public_address,
          encrypted_view_key,
          encryption_nonce,
          active,
          deleted_at,
          gen_mode,
          min_index,
          max_index
        FROM paylinks
        WHERE id = $1
        LIMIT 1
        `,
        [id],
      );

      if (paylinkRes.rowCount !== 1) {
        return reply.code(404).send({ error: "paylink_not_found" });
      }

      const paylink = paylinkRes.rows[0]!;
      if (!paylink.active)
        return reply.code(410).send({ error: "paylink_inactive" });
      if (paylink.deleted_at)
        return reply.code(410).send({ error: "paylink_deleted" });

      // DB enforces these, but clamp anyway
      const safeLo = clampIndex(paylink.min_index);
      const safeHi = clampIndex(paylink.max_index);
      const lo = Math.min(safeLo, safeHi);
      const hi = Math.max(safeLo, safeHi);

      const index = crypto.randomInt(lo, hi + 1);

      const viewKey = decryptViewKey(
        paylink.encrypted_view_key,
        paylink.encryption_nonce,
      );
      const decoded = decodeStandardAddress(paylink.public_address);

      const address = subaddress.getSubaddress(
        viewKey,
        decoded.publicSpendKeyHex,
        0,
        index,
      );

      const uri = buildMoneroUri({
        address,
        amount: amount || undefined,
        description: description || undefined,
      });

      const fingerprint = computePaylinkFingerprint(id);

      return reply.code(200).send({
        paylinkId: id,
        label: paylink.label ?? "",
        address,
        amount: amount ?? "",
        description,
        uri,
        fingerprint,
      });
    } catch (err) {
      req.log.error({ err }, "request donation failed");
      return reply.code(500).send({ error: "internal_error" });
    } finally {
      client.release();
    }
  });

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
