# Field Reporting API

NestJS API with PostgreSQL/Prisma persistence. The repository originally had no API application or database setup; these files provide the initial backend implementation.

## Local development

Requirements: Node.js 22, pnpm 9, and Docker Compose (or a PostgreSQL 16 instance).

```powershell
Copy-Item apps\api\.env.example apps\api\.env
docker compose up -d db
pnpm install
pnpm api:dev
```

The Compose database is published on host port `55432` to avoid collisions with a locally installed PostgreSQL service on `5432`. If you change the Compose host port, update the port in `DATABASE_URL` in `apps/api/.env` to match.

`pnpm api:build` compiles the API. Integration tests delete rows in their configured database, so create a dedicated database whose name ends in `_test` before running them:

```powershell
docker compose exec -T db createdb -U field_reporting field_reporting_test
$env:DATABASE_URL = "postgresql://field_reporting:field_reporting@127.0.0.1:55432/field_reporting_test?schema=public"
pnpm api:test
Remove-Item Env:DATABASE_URL
```

The test suite refuses to run unless the selected database name ends in `_test`. The normal API continues to use `apps/api/.env`.

The API reads `apps/api/.env` when present, then falls back to `.env` in the current working directory. `DATABASE_URL` is required; if it is missing, startup exits with an explicit configuration error. Swagger UI is served at `http://localhost:3000/api/v1/docs`, with the OpenAPI JSON at `http://localhost:3000/api/v1/docs-json`.

For the API and database in containers, run `docker compose up --build`. Compose persists PostgreSQL data in the `postgres_data` named volume and finalized uploads in `report_uploads`, mounted at `/var/lib/field-reporting/uploads`. Staged uploads are held in that same volume's `tmp` directory and finalized files in `finalized`. Container recreation preserves both volumes. Set `UPLOAD_ROOT` to a persistent path when running outside Compose.

## Endpoints

- `POST /api/v1/reports`: multipart `description` plus one to five `images` files; requires a UUID v4 `Idempotency-Key` header.
- `GET /api/v1/reports?limit=20&offset=0`: newest reports, with a maximum page size of 100. The response includes `nextOffset` when another page is available.
- `GET /api/v1/reports/:id`: one persisted report.
- `GET /api/v1/reports/:reportId/images/:imageId`: retrieve a persisted image.

Only JPEG, PNG, and WebP image contents are accepted. Each file must be nonempty and at most 5 MiB. Client filenames are ignored.

The server stores a normalized-description and ordered image SHA-256 fingerprint with each report. A PostgreSQL unique constraint arbitrates concurrent requests for the same key; matching retries return the stored report and changed payloads receive HTTP 409. Image files are finalized before the atomic database insert, and failed inserts remove their finalized files. A process crash after finalization but before the insert leaves an orphan file, which startup reconciliation removes only after it has been unreferenced for 24 hours. Staged directories older than 24 hours are also cleaned at startup. The 24-hour grace period safely exceeds the five-minute HTTP request timeout, including during simultaneous API starts using the same volume. This cleanup is conservative; storage repair for a missing file referenced by a committed row is not automatic. Keep the database and upload volume together and backed up.

Uploads are streamed to disk with a five-file limit, a 5 MiB per-file limit, bounded multipart field and part counts, and a five-minute HTTP request timeout. MIME type is determined from image signatures/container structure rather than the client filename or declared MIME type. This checks basic container integrity, not a full decode/re-encode; untrusted image decoding is left to clients. Use a single shared database and upload volume if running multiple API instances.

## Development failure injection

Failure injection is disabled by default. In a non-production environment, set `FAILURE_INJECTION_ENABLED=true` and restart the API, then add one of these headers to `POST /api/v1/reports`:

- `X-Dev-Failure: latency`: delay the request; `FAILURE_INJECTION_LATENCY_MS` sets a duration from 0 to 30,000 ms (default 3,000).
- `X-Dev-Failure: drop`: close the connection before parsing or committing the upload.
- `X-Dev-Failure: refuse`: reject with HTTP 503 before parsing the upload.
- `X-Dev-Failure: hang`: leave the connection open until the client disconnects.
- `X-Dev-Failure: after-commit-drop`: commit normally, then close the connection before sending the response. Retrying the identical payload with the same key returns the committed report.

Set `FAILURE_INJECTION_ENABLED=false` (or omit it) and restart to disable all scenarios. The feature is also forcibly inactive when `NODE_ENV=production`.
