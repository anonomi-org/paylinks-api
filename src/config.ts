// All env config is read and checked here, once, at boot.
//
// It used to be read wherever it happened to be needed, so a missing value in
// production showed up as a 500 mid-request instead of a service that refuses
// to start. DONATE_BASE_URL was the worst: it was read after the paylink had
// already been committed.
//
// Takes env as an argument so the rules can be tested without a live process.

export type TrustProxy = boolean | number | string;

export type AppConfig = {
  isProduction: boolean;

  port: number;
  host: string;

  /** true means "any origin", which is unreachable in production. */
  allowedOrigins: string[] | true;
  allowNullOrigin: boolean;

  /** Always ends with '#': the paylink id is appended as a fragment. */
  donateBaseUrl: string;

  /** Null only outside production, where the fingerprint falls back to a hash. */
  fingerprintKey: string | null;

  trustProxy: TrustProxy;

  rateLimit: {
    window: string;
    max: number;
    createMax: number;
    requestMax: number;
    deleteMax: number;
  };

  /** Fastify leaves request and connection off by default. */
  timeouts: {
    request: number;
    connection: number;
    keepAlive: number;
  };

  hsts: {
    enabled: boolean;
    maxAge: number;
    includeSubDomains: boolean;
  };
};

/** Collected so a bad deployment reports everything at once. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Whether to believe X-Forwarded-For, and how far down it to look.
 *
 * Off unless explicitly set. Trusting that header with no proxy in front lets
 * any client claim any address, which forges the rate-limit key and removes the
 * limit altogether - a worse failure than the one it fixes.
 *
 * Accepts "true", a hop count, or a comma-separated list of trusted addresses
 * or subnets, all of which Fastify understands directly.
 */
function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const problems: string[] = [];

  let allowedOrigins: string[] | true;
  const originsRaw = env.ALLOWED_ORIGINS;
  if (!originsRaw || originsRaw === "*") {
    if (isProduction) {
      problems.push("ALLOWED_ORIGINS must be set in production (not '*')");
    }
    allowedOrigins = true;
  } else {
    const list = originsRaw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (list.length === 0 && isProduction) {
      problems.push("ALLOWED_ORIGINS must list at least one origin");
    }
    allowedOrigins = list;
  }

  let donateBaseUrl: string;
  const donateRaw = env.DONATE_BASE_URL?.trim();
  if (!donateRaw) {
    if (isProduction) {
      problems.push("DONATE_BASE_URL must be set in production");
    }
    donateBaseUrl = "https://anonomi.org/paylinks/d#";
  } else {
    donateBaseUrl = donateRaw.endsWith("#") ? donateRaw : `${donateRaw}#`;
  }

  const keyRaw = env.PAYLINKS_FINGERPRINT_KEY;
  let fingerprintKey: string | null = null;
  if (!keyRaw || keyRaw.length < 16) {
    if (isProduction) {
      problems.push(
        "PAYLINKS_FINGERPRINT_KEY must be set (>=16 chars) in production",
      );
    }
  } else {
    fingerprintKey = keyRaw;
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    isProduction,

    port: positiveInt(env, "PORT", 8787),
    host: env.HOST ?? "0.0.0.0",

    allowedOrigins,
    allowNullOrigin: env.ALLOW_NULL_ORIGIN === "true",
    donateBaseUrl,
    fingerprintKey,

    trustProxy: parseTrustProxy(env.TRUST_PROXY),

    rateLimit: {
      window: env.RATE_LIMIT_WINDOW?.trim() || "1 minute",

      // Reads are cheap, so the ceiling is generous.
      max: positiveInt(env, "RATE_LIMIT_MAX", 120),

      // Creating a paylink derives its whole address pool: up to ~400ms of CPU
      // and ~93KB at the cap, unauthenticated. On a hidden service, where an
      // abuser cannot be identified or blocked, this is the only thing in front
      // of that cost.
      createMax: positiveInt(env, "RATE_LIMIT_CREATE_MAX", 20),

      // Keyed per paylink, so one link cannot have its pool harvested. A
      // donation page spends exactly one per visit.
      requestMax: positiveInt(env, "RATE_LIMIT_REQUEST_MAX", 60),

      // Destructive, and one request already does everything an owner needs.
      deleteMax: positiveInt(env, "RATE_LIMIT_DELETE_MAX", 20),
    },

    // Generous on purpose. Tor circuits are slow and a limit sized for a
    // clearnet round trip would cut hidden-service clients off mid-request.
    // These are here to stop a connection being held open forever, not to
    // police latency.
    timeouts: {
      request: positiveInt(env, "REQUEST_TIMEOUT_MS", 30_000),
      connection: positiveInt(env, "CONNECTION_TIMEOUT_MS", 30_000),

      // Fastify defaults to 72s. The donate page makes two calls seconds apart.
      keepAlive: positiveInt(env, "KEEP_ALIVE_TIMEOUT_MS", 15_000),
    },

    hsts: {
      enabled: env.ENABLE_HSTS === "true",
      maxAge: positiveInt(env, "HSTS_MAX_AGE", 31_536_000),
      includeSubDomains: env.HSTS_INCLUDE_SUBDOMAINS === "true",
    },
  };
}
