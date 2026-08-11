import test from "node:test";
import assert from "node:assert/strict";

import { ConfigError, loadConfig } from "../src/config";

// A complete production env. Tests remove one value at a time so each assertion
// is about that omission, not about an empty environment.
function prodEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://anonomi.org",
    DONATE_BASE_URL: "https://anonomi.org/paylinks/d#",
    PAYLINKS_FINGERPRINT_KEY: "k".repeat(32),
    PAYLINKS_OWNER_KEY_PEPPER: "p".repeat(32),
    ...overrides,
  };
}

// --- must fail at boot -----------------------------------------------------
//
// These all used to surface as a 500 from a handler instead. DONATE_BASE_URL was
// the worst: read after the paylink was committed, so the row existed but the
// caller got an error instead of a URL.

test("a production deployment with no donate base URL refuses to start", () => {
  const env = prodEnv();
  delete env.DONATE_BASE_URL;
  assert.throws(() => loadConfig(env), ConfigError);
});

test("a production deployment with no fingerprint key refuses to start", () => {
  const env = prodEnv();
  delete env.PAYLINKS_FINGERPRINT_KEY;
  assert.throws(() => loadConfig(env), ConfigError);
});

test("a fingerprint key shorter than 16 chars is refused in production", () => {
  assert.throws(
    () => loadConfig(prodEnv({ PAYLINKS_FINGERPRINT_KEY: "tooshort" })),
    ConfigError,
  );
});

test("a production deployment with no owner key pepper refuses to start", () => {
  const env = prodEnv();
  delete env.PAYLINKS_OWNER_KEY_PEPPER;
  assert.throws(() => loadConfig(env), ConfigError);
});

test("an owner key pepper shorter than 16 chars is refused in production", () => {
  assert.throws(
    () => loadConfig(prodEnv({ PAYLINKS_OWNER_KEY_PEPPER: "tooshort" })),
    ConfigError,
  );
});

test("a wildcard origin list is refused in production", () => {
  assert.throws(
    () => loadConfig(prodEnv({ ALLOWED_ORIGINS: "*" })),
    ConfigError,
  );
});

test("a production deployment with no origin list refuses to start", () => {
  const env = prodEnv();
  delete env.ALLOWED_ORIGINS;
  assert.throws(() => loadConfig(env), ConfigError);
});

test("every missing value is reported at once, not one per restart", () => {
  try {
    loadConfig({ NODE_ENV: "production" });
    assert.fail("expected ConfigError");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.problems.length, 4);
    assert.match(err.message, /ALLOWED_ORIGINS/);
    assert.match(err.message, /DONATE_BASE_URL/);
    assert.match(err.message, /PAYLINKS_FINGERPRINT_KEY/);
    assert.match(err.message, /PAYLINKS_OWNER_KEY_PEPPER/);
  }
});

// --- must still start ------------------------------------------------------
//
// The opposite failure: validation so eager it stops a deployment that was fine.

test("development needs no configuration at all", () => {
  const config = loadConfig({});
  assert.equal(config.isProduction, false);
  assert.equal(config.allowedOrigins, true);
  assert.equal(config.fingerprintKey, null);
  assert.equal(config.donateBaseUrl, "https://anonomi.org/paylinks/d#");
});

test("a fully configured production environment loads", () => {
  const config = loadConfig(prodEnv());
  assert.equal(config.isProduction, true);
  assert.deepEqual(config.allowedOrigins, ["https://anonomi.org"]);
  assert.equal(config.fingerprintKey, "k".repeat(32));
});

test("a short fingerprint key is tolerated outside production", () => {
  // Discarded rather than accepted, so it falls back to the plain hash instead
  // of keying an HMAC with something that weak.
  const config = loadConfig({ PAYLINKS_FINGERPRINT_KEY: "short" });
  assert.equal(config.fingerprintKey, null);
});

// --- parsing ---------------------------------------------------------------

test("the donate base URL always ends with a fragment marker", () => {
  assert.equal(
    loadConfig(prodEnv({ DONATE_BASE_URL: "https://x.org/d" })).donateBaseUrl,
    "https://x.org/d#",
  );
  assert.equal(
    loadConfig(prodEnv({ DONATE_BASE_URL: "https://x.org/d#" })).donateBaseUrl,
    "https://x.org/d#",
  );
});

test("origins are split and trimmed", () => {
  const config = loadConfig(
    prodEnv({ ALLOWED_ORIGINS: " https://a.org , https://b.org " }),
  );
  assert.deepEqual(config.allowedOrigins, ["https://a.org", "https://b.org"]);
});

test("X-Forwarded-For is not trusted unless it is asked for", () => {
  assert.equal(loadConfig({}).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: "false" }).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: "  " }).trustProxy, false);
});

test("trust proxy accepts a flag, a hop count or a trusted list", () => {
  assert.equal(loadConfig({ TRUST_PROXY: "true" }).trustProxy, true);
  assert.equal(loadConfig({ TRUST_PROXY: "2" }).trustProxy, 2);
  assert.equal(
    loadConfig({ TRUST_PROXY: "10.0.0.0/8,192.168.0.1" }).trustProxy,
    "10.0.0.0/8,192.168.0.1",
  );
});

test("a nonsensical numeric setting falls back instead of taking effect", () => {
  // Accepting 0 or -1 would disable the limit it belongs to.
  for (const bad of ["0", "-1", "abc", "1.5", ""]) {
    assert.equal(loadConfig({ RATE_LIMIT_MAX: bad }).rateLimit.max, 120);
  }
  assert.equal(loadConfig({ RATE_LIMIT_MAX: "300" }).rateLimit.max, 300);
});

test("socket timeouts are set, and generously enough for Tor", () => {
  // Fastify leaves the first two at 0 by default. The point is that they aren't.
  const { timeouts } = loadConfig({});
  assert.ok(timeouts.request >= 30_000);
  assert.ok(timeouts.connection >= 30_000);
  assert.ok(timeouts.keepAlive > 0 && timeouts.keepAlive < 72_000);
});

test("deletion has its own ceiling, below the read one", () => {
  const { rateLimit } = loadConfig({});
  assert.ok(rateLimit.deleteMax < rateLimit.max);
});

test("HSTS stays off, and its subdomain reach is a separate decision", () => {
  assert.equal(loadConfig({}).hsts.enabled, false);
  assert.equal(loadConfig({ ENABLE_HSTS: "true" }).hsts.enabled, true);

  // Turning HSTS on must not drag every sibling host with it.
  assert.equal(
    loadConfig({ ENABLE_HSTS: "true" }).hsts.includeSubDomains,
    false,
  );
});
