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

To update the deployment:
```bash
git pull && docker compose up -d --build
```

This is safe - database data persists in the Docker volume.

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
- Every `/api/paylinks` response is held to the same minimum time plus jitter —
  success, not found, and error alike — so an existing paylink cannot be told
  from a missing one by timing the reply.
- Request logging is off. The paylink id and the caller's address are never
  written to a log, which is what keeps the donate page's URL-fragment design
  meaningful.
- A global rate limit of 120 requests per minute is applied per client IP.

## License

GPL-3.0 - See [LICENSE](LICENSE) for details.
