# Order & Parcel Delivery Audit

A shared operational workspace for **Orders**, **Parcels**, and **Customer Requests**. React, Effect TS, SQLite, and one Docker application. Source data is read-only; employee notes persist independently through imports and tracking updates.

## Run locally

```sh
docker compose up --build -d
```

Open **http://localhost:3100**. The default configuration binds only to the local machine and identifies edits as `local-developer`. Data lives in the `audit-data` named volume. Stopping or rebuilding the container does not remove it. Do not run `docker compose down -v` on a database you want to retain.

Optionally put `PARCELLAB_API_KEY_HASHED` in an untracked `.env` file before starting Compose. With no key, browsing/imports/notes work and parcelLab refresh is disabled. Credentials remain in the backend. The API user/plain key are not needed by the bulk endpoint.

Alternatively use `docker compose --env-file /path/to/existing/.env up -d` to reuse an existing credential file. Use the same option on subsequent recreations; `docker compose restart` keeps the configured credentials. Only the explicitly referenced parcelLab key is passed into the container. Set `AUDIT_SUBNET` if the default private subnet overlaps your Docker networks.

1. Import the UTF-8 BOM, semicolon-delimited Actindo/parcelLab CSV through `POST /api/import/audit` with `Content-Type: text/csv`. Upload limit: 100 MB. Import controls are deliberately absent from the UI; both API endpoints remain available.
2. Import the XLSX through `POST /api/import/responses` with the XLSX MIME type. Its first worksheet must contain `Wie lautet deine Bestellnummer?`, `Ich möchte eine`, and `E-Mail Adresse (optional)`. Header whitespace is ignored; other columns, including Forms `Id`, are ignored. Send the raw file body, `Origin` matching `APP_ORIGIN`, and `X-Audit-Request: 1`. The API returns a job ID; check `/api/jobs` for completion and added/skipped counts. Access authentication still applies in production.
3. Search, add column filters, sort, and follow an order to its parcels or requests. Scroll horizontally to Notes. Dates and times are UTC.
4. Save notes explicitly. If a colleague has saved first, review their latest text and your retained draft before saving against the latest revision.
5. **Refresh tracking** selects orders with any non-delivered/unknown parcel, refreshes all siblings, and displays progress under activity. The bulk source is scanned sequentially with 10,000 records/page and at least one second between requests, including retries. It does not call carrier `live_refresh`.

Default scope: AB creation dates 2026-08-01 through 2026-09-10 inclusive; projectId beginning `6a` or `ks`. Out-of-scope imports are reported and excluded. Existing AB/document counts come from the export, not a direct Actindo connection.

## Data semantics

- Orders use AB IDs; parcel notes use stable order/tracking associations. Changing row order never changes note ownership.
- One customer-request note is shared by its expanded parcel rows. Normalization applies Unicode compatibility normalization, lowercase, removes everything except ASCII letters/digits/hyphens, and restores standard full-order hyphens. Full KS identification uses `/^ks[a-z]{2}-\d{4}-\d{6,9}$/i`, retaining NL/CH and other audit prefixes as well as AT/FR/DE.
- Exact audit matches take precedence. Short `1002-6607733` or numeric-only 6–9 digit inputs resolve only to a unique audit order; a supplied four-digit code must agree. Full-but-unknown KS numbers never fall back to a different country's order. Long tracking numbers and arbitrary prose are not treated as order suffixes. The UI retains the original input and shows a searchable/filterable normalized matcher (canonical audit projectId when matched, cleaned input otherwise) with an explicit match result.
- Imports deduplicate by the uniquely resolved audit order, falling back to cleaned text for unresolved entries. Historical record IDs and notes remain unchanged when match metadata is recomputed.
- Imports are append-only: existing order numbers are skipped without changing email, request type, notes or record IDs. The first row wins for new orders repeated within one file. Blank order numbers are reported and skipped. Reimporting the same workbook adds nothing. Historical duplicate responses and their notes are preserved, not deleted or merged. An import is not a way to edit an existing request.
- Bulk misses retain prior verified status and become `not_found_bulk_refresh`. Source omissions are reported in import activity. Neither means a parcel is missing or delivered.
- `last_updated` is parcelLab's update time; movement and application-refresh times are separate. Customer Requests always joins live stored parcel values.
- Legacy timestamps without a timezone are interpreted as UTC consistently on every host; day filters include the entire UTC calendar day.
- A failed later provider page leaves all previously verified data in place. Restarting marks unfinished jobs interrupted; rerun them. Only one import/refresh runs at once; note editing remains available during network fetches.
- Delivery is a carrier fact, not a refund, customer resolution, or warehouse receipt.

## Access deployment (later)

Use `docker compose -f compose.access.yaml up --build -d` after configuring `APP_ORIGIN`, `ACCESS_ISSUER` and `ACCESS_AUDIENCE`. This separate definition publishes no host port. Connect Cloudflare Tunnel to the application on its private container network and put the full application hostname behind Cloudflare Access.

The API independently verifies the Access JWT signature, issuer, audience and expiry. Note attribution comes only from its validated identity. Browser writes must carry the configured same-origin header and application request header. There is no second app login, shared frontend API secret, or user administration. Every admitted employee has the same prototype permissions. Production mode refuses the local authentication bypass. Tunnel/DNS/policy provisioning is deliberately not performed by this project.

## Development and verification

Node 24.22.1+ (or 26.12.1+) required; `.nvmrc` pins 24.22.1. `npm ci`, then:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
npx playwright install chromium
npm run test:browser
npm run benchmark
```

Builds use Rolldown; type checking uses tsgo; formatting/linting use oxfmt/oxlint. There is no standalone library requiring tsdown. Vitest tests the HTTP API with real temporary SQLite databases and controlled provider fixtures; Playwright covers the actual interface and stale-note conflict. Generated performance fixtures contain 200,000 orders and parcels. No customer files or secrets belong in this public repository.

## Back up and restore

Make a consistent SQLite snapshot with the application running:

```sh
docker compose exec audit node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/app/data/audit.sqlite");db.exec("VACUUM INTO '\''/app/data/backup.sqlite'\''");db.close()'
docker compose cp audit:/app/data/backup.sqlite ./data/backup.sqlite
```

Create the local `data` directory first. Use a fresh backup filename each time. It contains customer data and notes; keep it private and outside Git.

To restore, stop the application, preserve its existing database and WAL/SHM files as a recoverable set, copy the validated backup into a clean data volume as `audit.sqlite`, ensure UID 1000 owns the file/directory, then start the application. Restore into a separate volume first and check `/health`, row counts and a known note before replacing a working instance. Never copy only a live WAL database's main file as a backup.

## Architecture

One Node HTTP server serves static React assets and typed API requests. A worker thread performs imports/refresh network scans with its own SQLite connection. Source changes are staged/validated before an atomic transaction; notes use independent revisioned rows. SQLite WAL supports concurrent reads, and the persisted active-job constraint serializes source writers. A single replica is supported.

The implementation specification is [issue #1](https://github.com/kaptenandson/kapten-order-parcel-tracking-audit/issues/1). Production rollout, custom fields, assignments, scheduled refreshes, direct Actindo writes, and real-time collaborative text editing are outside this prototype.
