# Anonomi Paylinks API

A privacy-focused API for creating Monero donation links with subaddress generation. Each donation request generates a unique subaddress, improving privacy for both donors and recipients.

## Features

- **Subaddress Generation**: Automatically generates unique Monero subaddresses for each donation
- **No Stored View Keys**: Subaddresses are derived when a paylink is created and the private view key is discarded — it is never written to the database
- **Rate Limiting**: Built-in protection against abuse
- **Tor Support**: Full support for Tor hidden service deployments
- **No Tracking**: No analytics, no cookies, no logs of sensitive data

## Requirements

- Node.js 22+
- PostgreSQL 16+
- Docker & Docker Compose (for production)

## Quick Start (Development)

1. Clone the repository:
   ```bash
   git clone https://github.com/anonomi-org/paylinks-api.git
   cd paylinks-api
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development database:
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

4. Copy and configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

5. Run migrations:
   ```bash
   npm run migrate up
   ```

6. Start the development server:
   ```bash
   npm run dev
   ```

## Tests

```bash
npm test        # unit + database tests
npm run typecheck
```

Nothing needs to be running first. The database tests spin up PGlite — real
PostgreSQL compiled to WebAssembly — in-process, apply the migrations from
`migrations/`, and exercise the same query functions the handlers call. No
Docker, no service container, no `DATABASE_URL`.

The Monero test vectors in `test/vectors.ts` were generated from a throwaway
seed that is committed alongside them, so every expected address can be
regenerated and audited.

## Production Deployment

### Using Docker Compose

1. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with production values
   ```

2. Generate required secrets:
   ```bash
   # Fingerprint HMAC key
   openssl rand -hex 32

   # Database password
   openssl rand -hex 16
   ```

3. Start the services:
   ```bash
   docker compose up -d
   ```

4. Run migrations:
   ```bash
   docker compose --profile migrate up migrate
   ```

### Updating

Run migrations *before* bringing the new code up:

```bash
git pull
docker compose --profile migrate up migrate
docker compose up -d --build
```

The order matters: a release can depend on a column its migration has already
adjusted, so starting the new code first leaves writes failing until the
migration catches up. Migrations here are written so the previous release still
works against the new schema, which is what keeps a rollback possible.

Database data persists in the Docker volume.

Config is checked at startup, so a missing or malformed value stops the
container immediately and lists every problem at once. If the API doesn't come
up after an update, read the first lines of `docker compose logs api`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | API port (default: 8787) |
| `HOST` | No | Bind address (default: 0.0.0.0) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PAYLINKS_FINGERPRINT_KEY` | Yes | HMAC key for paylink fingerprints (min 16 chars) |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins |
| `ALLOW_NULL_ORIGIN` | No | Set to `true` for Tor deployments (see below) |
| `DONATE_BASE_URL` | Yes | Base URL for donation page (e.g., `https://example.org/donate#`) |
| `NODE_ENV` | No | Set to `production` for strict validation |
| `TRUST_PROXY` | No | Trust `X-Forwarded-For`. Off by default — see below |
| `RATE_LIMIT_MAX` | No | Read requests per window (default: 120) |
| `RATE_LIMIT_WINDOW` | No | Rate limit window (default: `1 minute`) |
| `RATE_LIMIT_CREATE_MAX` | No | Paylink creations per window (default: 20) |
| `RATE_LIMIT_REQUEST_MAX` | No | Donation requests per paylink per window (default: 60) |
| `RATE_LIMIT_DELETE_MAX` | No | Deletions per window, single and bulk (default: 20) |
| `REQUEST_TIMEOUT_MS` | No | Time to receive a whole request (default: 30000) |
| `CONNECTION_TIMEOUT_MS` | No | Socket inactivity before close (default: 30000) |
| `KEEP_ALIVE_TIMEOUT_MS` | No | Idle keep-alive socket lifetime (default: 15000) |
| `ENABLE_HSTS` | No | Send Strict-Transport-Security. Off by default |
| `HSTS_MAX_AGE` | No | HSTS duration in seconds (default: 31536000) |
| `HSTS_INCLUDE_SUBDOMAINS` | No | Extend HSTS to every subdomain. Off by default |

## Deployment shape

This service runs two very different ways and cannot tell which one it is in,
so a few settings have to be declared rather than guessed.

**Behind a reverse proxy (typical clearnet self-hosting).** Set
`TRUST_PROXY=true` — or a hop count, or a list of trusted addresses. Without it
every client appears to come from the proxy and they all share a single rate
limit bucket. Turning it on when there is *no* proxy in front is worse than
leaving it off: any caller can then claim any address and bypass rate limiting
entirely. Set `ENABLE_HSTS=true` if you terminate TLS here rather than at the
proxy.

**As a Tor hidden service.** Leave `TRUST_PROXY` unset and `ENABLE_HSTS` off,
and set `ALLOW_NULL_ORIGIN=true`. Every request arrives from the local Tor
daemon, so there is no client address to recover and per-client rate limiting
is not possible — that is Tor working as intended, not a misconfiguration. The
global limit becomes a service-wide ceiling, and `RATE_LIMIT_CREATE_MAX` is
what actually protects you, since an abuser can be neither identified nor
blocked. Size it deliberately.

**Directly exposed on the clearnet.** Leave `TRUST_PROXY` unset; `req.ip` is
already the real client address.

## Tor Deployment

For Tor hidden service deployments, set:
```bash
ALLOW_NULL_ORIGIN=true
```

This is required because Tor Browser sends `Origin: null` for privacy. This setting returns `Access-Control-Allow-Origin: *` for null origins, allowing requests from Tor Browser.

**Do not enable this on clearnet deployments.**

## API Endpoints

### Health Check
```
GET /health
```

### Create Paylink
```
POST /api/paylinks
Content-Type: application/json

{
  "publicAddress": "4...",
  "privateViewKey": "...",
  "options": {
    "label": "My Donation Link",
    "minIndex": 1,
    "maxIndex": 100
  }
}
```

### Get Paylink Metadata
```
GET /api/paylinks/:id/meta
```

### Request Donation Address
```
POST /api/paylinks/:id/request
Content-Type: application/json

{
  "amount": "0.1",
  "description": "Coffee donation"
}
```

### Delete Paylink
```
POST /api/paylinks/:id/delete
Content-Type: application/json

{
  "ownerKey": "..."
}
```

### Delete All Paylinks by Owner Key
```
POST /api/paylinks/delete
Content-Type: application/json

{
  "ownerKey": "..."
}
```

## Security

- Private view keys are never stored. A paylink's subaddresses are derived once,
  while the key is still in the request, and the key is discarded before the
  response is sent. Compromising this service does not yield anything that can
  reconstruct a recipient's or a donor's payment history.
- Addresses are validated with `monero-ts`: checksum, network, address type, and
  that the submitted view key genuinely belongs to the submitted address. A
  mistyped view key is rejected rather than silently producing a paylink whose
  donations nobody can spend.
- Owner keys are computed in the browser; only the resulting hash reaches this
  service, so deleting a paylink never puts a view key back on the wire.
- The recipient's own address is not kept either. It is used to derive the
  address pool and compute the owner key, both before the row is written, and
  nothing reads it afterwards — so a database dump cannot say who a paylink
  belongs to.
- Every `/api/paylinks` response is held to the same minimum time plus jitter —
  success, not found, and error alike — so an existing paylink cannot be told
  from a missing one by timing the reply.
- Request logging is off. The paylink id and the caller's address are never
  written to a log, which is what keeps the donate page's URL-fragment design
  meaningful.
- A global rate limit of 120 requests per minute is applied per client IP.

## License

GPL-3.0 - See [LICENSE](LICENSE) for details.
