# Anonomi Paylinks API

A privacy-focused API for creating Monero donation links with subaddress generation. Each donation request generates a unique subaddress, improving privacy for both donors and recipients.

## Features

- **Subaddress Generation**: Automatically generates unique Monero subaddresses for each donation
- **View Key Encryption**: Private view keys are encrypted at rest using AES-256-GCM
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

## Production Deployment

### Using Docker Compose

1. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with production values
   ```

2. Generate required secrets:
   ```bash
   # Encryption key for view keys
   openssl rand -base64 32

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
| `PAYLINKS_MASTER_KEY_B64` | Yes | Base64-encoded 32-byte AES key for encrypting view keys |
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

- Private view keys are encrypted using AES-256-GCM before storage
- Owner keys are derived from public address + private view key (never stored directly)
- Delete operations use constant-time responses to prevent enumeration
- UUID validation prevents timing attacks on paylink IDs
- Rate limiting protects against brute force attacks

## License

GPL-3.0 - See [LICENSE](LICENSE) for details.
