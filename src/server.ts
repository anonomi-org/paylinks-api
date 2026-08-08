import Fastify, {
  type FastifyError,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import "dotenv/config";
import { z } from "zod";
import { pool } from "./db";
import { buildMoneroUri } from "./moneroUri";
import {
  deletePaylinkByIdAndOwner,
  deletePaylinksByOwner,
  findPaylinkForRequest,
  findPaylinkMeta,
  findSubaddress,
  insertPaylink,
  insertSubaddresses,
} from "./store";
import {
  assertValidPrimaryAddressAndViewKey,
  deriveSubaddressRange,
  warmup as warmupMoneroAddressing,
} from "./monero/address";
import crypto from "crypto";

const MAX_SUBADDRESS_INDEX = 1_000_000;
const DEFAULT_MIN_INDEX = 1;
const DEFAULT_MAX_INDEX = 100;

// How many addresses a single paylink may reserve. Subaddresses are derived up
// front so the view key never has to be stored, which turns the index range
// into real work and storage: roughly 0.4ms and 95 bytes per address, so a
// thousand costs about 400ms and 93KB. The donate page requests exactly one
// address per visit, so this is a generous ceiling rather than a tight one.
const MAX_POOL_SIZE = 1_000;

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

function getDonateBaseUrl(): string {
  const env = process.env.DONATE_BASE_URL;
  if (!env) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DONATE_BASE_URL must be set in production");
    }
    return "https://anonomi.org/paylinks/d#"; // Default for development
  }
  // Ensure it ends with # for the fragment identifier
  return env.endsWith("#") ? env : `${env}#`;
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
  // Shape only. Whether these are a genuine mainnet primary address and its
  // matching view key is decided in src/monero/address.ts, not here.
  publicAddress: z.string().trim().min(20).max(200),
  privateViewKey: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "privateViewKey must be 64 hex chars"),
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
      .max(30)
      // Max 15 whole digits, max 12 decimal places (Monero has 12 decimal places)
      .regex(/^\d{1,15}(\.\d{1,12})?$/, "invalid amount format")
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

const PaylinkIdSchema = z.string().uuid();

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

// Generic error that doesn't reveal if paylink exists, is inactive, or deleted
const PAYLINK_UNAVAILABLE_ERROR = { error: "paylink_unavailable" } as const;

// Response-time floor for the paylink API.
//
// Every paylink response is held to at least MIN_RESPONSE_TIME_MS and then
// given jitter on top, so a caller cannot tell an existing paylink from a
// missing one, or a matching owner key from a wrong one, by timing the reply.
//
// This is applied in an onSend hook rather than at each return statement. The
// previous version padded only the not-found branches, which left the success
// paths answering in single-digit milliseconds and preserved the exact
// enumeration signal the padding was meant to remove.
const MIN_RESPONSE_TIME_MS = 200;
const MAX_JITTER_MS = 100;

/** Wall clock can step backwards; hrtime cannot, so the pad stays bounded. */
function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function padToFloor(startedAtMs: number): Promise<void> {
  const elapsed = monotonicNowMs() - startedAtMs;

  // Jitter is added unconditionally rather than only when the response came in
  // under the floor. A response that already took longer than the floor is
  // exactly the case where the underlying work was slow enough for its timing
  // to say something, so it needs noise too.
  const toFloor = Math.max(MIN_RESPONSE_TIME_MS - elapsed, 0);
  const jitter = crypto.randomInt(0, MAX_JITTER_MS + 1); // 0-100 inclusive

  await new Promise((r) => setTimeout(r, toFloor + jitter));
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
        // Fastify's own request logging never carried a body, so the previous
        // "req.body.*" paths could not match anything. These are the shapes an
        // explicit log call would actually produce, so they fire if someone
        // later writes req.log.info({ body }) or logs a field directly.
        paths: [
          "ownerKey",
          "privateViewKey",
          "publicAddress",
          "body.ownerKey",
          "body.privateViewKey",
          "body.publicAddress",
        ],
        remove: true,
      },
    },
    // The donate page keeps the paylink id in the URL fragment specifically so
    // it never reaches a server log. Fastify's request logging would undo that:
    // it writes the id - which is in the API path - next to the caller's IP on
    // every hit, producing exactly the access record the fragment avoids. On a
    // service that offers Tor deployment and advertises no tracking, that trade
    // is not worth an access log.
    disableRequestLogging: true,
    bodyLimit: 16384, // 16KB max body size
  });

  // CORS configuration
  const allowedOrigins = getAllowedOrigins();
  const allowNullOrigin = process.env.ALLOW_NULL_ORIGIN === "true";

  // Security headers - configured for JSON API (not HTML)
  // Disabled headers that can interfere with CORS/Tor
  // HSTS disabled for Tor deployments (.onion uses HTTP, Tor provides encryption)
  const enableHsts =
    process.env.NODE_ENV === "production" && !allowNullOrigin;

  await app.register(helmet, {
    contentSecurityPolicy: false, // API doesn't serve HTML
    crossOriginEmbedderPolicy: false, // Can interfere with CORS
    crossOriginOpenerPolicy: false, // Not relevant for API
    crossOriginResourcePolicy: false, // Let CORS handle this
    originAgentCluster: false, // Not relevant for API
    dnsPrefetchControl: { allow: false },
    frameguard: { action: "deny" },
    hsts: enableHsts ? { maxAge: 31536000 } : false,
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
    xssFilter: true,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Tor Browser sends "null" as origin for privacy
      // Only allow if ALLOW_NULL_ORIGIN=true (for Tor deployments)
      if ((origin === null || origin === "null") && allowNullOrigin) {
        return cb(null, "*");
      }
      // In development, allow all origins
      if (allowedOrigins === true) {
        return cb(null, true);
      }
      // Check against allowed origins list
      if (origin && allowedOrigins.includes(origin)) {
        return cb(null, origin);
      }
      // Origin not allowed
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Global rate limit
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  // Response-time floor, applied to every paylink response in one place.
  //
  // onSend runs after the handler has returned, which means the padding no
  // longer happens while the handler still holds a database client. The old
  // per-route version slept inside the try block that owned the connection, so
  // a handful of concurrent requests could empty the pool for a quarter second.
  const requestStart = new WeakMap<FastifyRequest, number>();

  const isPaddedRoute = (req: FastifyRequest) =>
    req.method !== "OPTIONS" && req.url.startsWith("/api/paylinks");

  app.addHook("onRequest", async (req) => {
    if (isPaddedRoute(req)) requestStart.set(req, monotonicNowMs());
  });

  app.addHook("onSend", async (req, _reply, payload) => {
    const startedAt = requestStart.get(req);
    if (startedAt !== undefined) await padToFloor(startedAt);
    return payload;
  });

  // Fastify gates its default 5xx log behind disableRequestLogging, so turning
  // request logging off would otherwise leave server errors completely silent.
  // Its default handler also logs the serialized request, which would put the
  // paylink id and the caller's IP straight back into the log we just removed.
  // Log the error on its own instead: enough to diagnose a fault, nothing that
  // records who asked for which paylink.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(500).send({ error: "internal_error" });
    }

    return reply.code(statusCode).send(err);
  });

  app.get("/health", async () => ({ ok: true }));

  // PUBLIC METADATA (used by donation page on load)
  // Returns label + fingerprint
  app.get("/api/paylinks/:id/meta", async (req, reply) => {
    const idResult = PaylinkIdSchema.safeParse((req.params as any)?.id);
    if (!idResult.success) {
      return reply.code(404).send(PAYLINK_UNAVAILABLE_ERROR);
    }
    const id = idResult.data;

    const client = await pool.connect();
    try {
      const row = await findPaylinkMeta(client, id);

      // Same response for not found, inactive, or deleted - no info leakage
      if (!row || !row.active || row.deleted_at) {
        return reply.code(404).send(PAYLINK_UNAVAILABLE_ERROR);
      }

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

    // Every subaddress is derived up front, so the range is also the amount of
    // work and storage a single request can ask for. The indices themselves may
    // still be large; it is the count that has to stay bounded.
    const poolSize = maxIndex - minIndex + 1;
    if (poolSize > MAX_POOL_SIZE) {
      return reply.code(400).send({
        error: "invalid_request",
        details: {
          options: {
            maxIndex: [
              `minIndex and maxIndex may span at most ${MAX_POOL_SIZE} addresses (requested ${poolSize})`,
            ],
          },
        },
      });
    }

    // Derive the whole pool now, while the view key is in hand. After this
    // request the key is gone - it is never written to the database, so a
    // compromise of this service cannot reconstruct anybody's payment history.
    let subaddresses: { index: number; address: string }[];
    try {
      // Rejects a bad checksum, a subaddress, the wrong network, a malleated
      // encoding, and - the one that used to lose money silently - a view key
      // that does not belong to this address.
      await assertValidPrimaryAddressAndViewKey(publicAddress, privateViewKey);

      subaddresses = await deriveSubaddressRange(
        publicAddress,
        privateViewKey,
        minIndex,
        maxIndex,
      );
    } catch {
      return reply.code(400).send({
        error: "invalid_request",
        details: {
          publicAddress: [
            "Not a valid Monero mainnet address, or the view key does not match it.",
          ],
        },
      });
    }

    // Preview so the user can sanity-check the first address in their wallet.
    const addressPreview = previewAddr(subaddresses[0]!.address);

    const ownerKey = computeOwnerKey(publicAddress, privateViewKey);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const id = await insertPaylink(client, {
        label,
        publicAddress,
        genMode,
        minIndex,
        maxIndex,
        ownerKey,
      });

      await insertSubaddresses(client, id, subaddresses);

      await client.query("COMMIT");

      const donateUrl = `${getDonateBaseUrl()}${id}`;
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
    const idResult = PaylinkIdSchema.safeParse((req.params as any)?.id);
    if (!idResult.success) {
      // Same response as success - no info leakage about ID validity
      return reply.code(200).send({
        ok: true,
        message: genericDeleteMessageSingle((req.params as any)?.id ?? ""),
      });
    }
    const id = idResult.data;

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
      await deletePaylinkByIdAndOwner(client, id, ownerKey);

      await client.query("COMMIT");

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

      await deletePaylinksByOwner(client, ownerKey);

      await client.query("COMMIT");


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
    const idResult = PaylinkIdSchema.safeParse((req.params as any)?.id);
    if (!idResult.success) {
      return reply.code(404).send(PAYLINK_UNAVAILABLE_ERROR);
    }
    const id = idResult.data;

    const parsed = RequestDonationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { amount, description } = parsed.data;

    const client = await pool.connect();
    try {
      const paylink = await findPaylinkForRequest(client, id);

      // Same response for not found, inactive, or deleted - no info leakage
      if (!paylink || !paylink.active || paylink.deleted_at) {
        return reply.code(404).send(PAYLINK_UNAVAILABLE_ERROR);
      }

      // DB enforces these, but clamp anyway
      const safeLo = clampIndex(paylink.min_index);
      const safeHi = clampIndex(paylink.max_index);
      const lo = Math.min(safeLo, safeHi);
      const hi = Math.max(safeLo, safeHi);

      const index = crypto.randomInt(lo, hi + 1);

      // The pool was derived and stored at creation time, so serving a donation
      // is a primary-key lookup and this service holds no key material at all.
      const address = await findSubaddress(client, id, index);
      if (!address) {
        // The row's stored range disagrees with the pool that was written for
        // it, so the paylink cannot be served. Same opaque answer as a missing
        // paylink rather than a distinguishable error.
        req.log.error(
          { subaddressIndex: index },
          "paylink has no address at the requested index",
        );
        return reply.code(404).send(PAYLINK_UNAVAILABLE_ERROR);
      }

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

  // Loading the Monero WASM module takes roughly 300ms. Do it before the port
  // opens so the first real request doesn't wear that cost, and so a broken
  // install fails at boot rather than on someone's donation.
  await warmupMoneroAddressing();

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
