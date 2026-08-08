# Technical Scope and Stack Decisions

This repository is locked to a backend-only HTTP API implementation for a correctness-critical transaction ledger.

## In Scope

- HTTP API endpoints for accounts, transfers, balances, and transaction history
- Correctness guarantees around money conservation, non-negative balances, idempotency, and concurrency
- Automated tests
- Local development setup and implementation documentation required by the assignment
- A single supported currency: `USD`
- Account creation as the trusted opening-funding boundary, with opening balances represented as canonical decimal strings of integer minor units

## Out of Scope

- Frontend or admin dashboard
- Authentication, authorization, or user management. The assignment intentionally excludes them, but production use would require authenticated principals plus authorization rules defining which accounts each principal may access.
- Deposits or withdrawals
- Pagination for transaction history in the assignment implementation. The API intentionally returns the complete history; a production follow-up would add cursor pagination using `(createdAt, transferId)`.
- Rate limiting. The assignment intentionally excludes it; a production design would need an explicit identity or key, shared multi-instance storage, proxy-aware behavior, a stable `429` contract, and documented headers. Process-local counters would not provide a correct global limit across multiple API instances, and rate limiting is not a replacement for validation, idempotency, transactions, or database constraints.
- Multiple currencies
- Redis, Kafka, queues, workers, or event streaming
- Microservices
- Currency conversion
- Cloud deployment or Kubernetes

## Chosen Technology

- Node.js 24 LTS runtime
- TypeScript with strict typing
- Fastify for the HTTP server
- PostgreSQL as the system of record and shared concurrency coordinator
- `pg` as the PostgreSQL query layer, with explicit SQL transactions and row-level locks
- Vitest for automated tests
- Docker Compose for the local API and PostgreSQL environment

## Architectural Constraints

- The service remains stateless for correctness-critical behavior.
- No balance, transfer, lock, or idempotency guarantee may depend on process memory.
- PostgreSQL is the only shared coordination point across API instances.
- The implementation stays focused on accounts, transfers, balances, transaction history, correctness, tests, and documentation.
- Transfer money conservation is measured immediately before and after each completed transfer.
- Future transfer implementation must reject and fully roll back any transfer that would cause the destination balance to exceed PostgreSQL signed `BIGINT` maximum `9223372036854775807`.
- The transfer path uses PostgreSQL `READ COMMITTED` together with the unique idempotency constraint, deterministic ascending account-ID `FOR UPDATE` locking, and one explicit transaction to provide the required correctness guarantees for this assignment.
- The implementation intentionally does not add an application-level transient retry loop for deadlocks, serialization failures, or lock timeouts in section 8. Deterministic lock ordering substantially reduces deadlock risk for the assignment path, and unexpected transient failures safely roll back and can be retried by the client with the same idempotency key.
- The implementation intentionally does not add a replay-indicator response field. Exact retries return the original persisted transfer ID, timestamp, and response body to keep the core contract stable.
- CORS remains disabled because this assignment has no browser frontend. The API does not register a CORS plugin or return permissive `Access-Control-Allow-Origin` headers.

## Performance Safeguards

- HTTP connection timeout: `5000ms`. Fastify 5 maps `connectionTimeout` to Node.js `server.timeout`, which limits socket inactivity on incoming connections. It does not limit total handler execution time.
- HTTP request timeout: `10000ms`. Fastify 5 maps `requestTimeout` to Node.js `server.requestTimeout`, which limits how long the server waits to receive the entire request from the client before the request is handed to the route lifecycle.
- HTTP handler timeout: `15000ms`. Fastify 5 `handlerTimeout` is the application-level lifecycle limit from routing through validation, handler execution, and response serialization. If it expires, Fastify aborts `request.signal` and returns a safe timeout error response.
- HTTP keep-alive timeout is not overridden in application code. The runtime therefore uses Fastify 5's default `keepAliveTimeout` of `72000ms`.
- PostgreSQL pool connection timeout: `5000ms`.
- PostgreSQL pool idle timeout: `30000ms`.
- PostgreSQL session `statement_timeout`: `15000ms`.
- PostgreSQL session `lock_timeout`: `5000ms`.
- PostgreSQL session `idle_in_transaction_session_timeout`: `10000ms`.
- Transfer transaction-local `statement_timeout`: `10000ms`.
- Transfer transaction-local `lock_timeout`: `5000ms`.
- Transfer transaction-local `idle_in_transaction_session_timeout`: `10000ms`.
- Database statement and lock timeouts bound the critical financial path so blocked or stalled requests roll back cleanly instead of holding account locks indefinitely.
- The transfer path performs request validation, UUID normalization, equal-account rejection, and fingerprint generation before the database transaction starts. Only idempotency, locking, balance checks, updates, and transfer persistence remain inside the transaction.
- No external network calls occur while the transfer transaction or account locks are open. The transaction callback only executes PostgreSQL queries through the checked-out client.
- No balance or transfer cache is used. Every balance read and transfer-history read goes to PostgreSQL so correctness does not depend on process memory or cache invalidation.
- Redis and distributed application locks remain excluded because PostgreSQL row locks, unique constraints, and transactions already provide the required correctness guarantees across stateless API instances.
- The current indexes remain sufficient: the unique idempotency-key constraint supports transfer replay/conflict handling, and the existing source and destination history indexes support the account transaction-history query. No section 11 index was added.

## Local Development Environment

- The API is packaged in a production-oriented multistage `Dockerfile`. The builder stage runs `npm ci` and `npm run build` on the official `node:24` image. The runtime stage installs only production dependencies with `npm ci --omit=dev`, copies the compiled `dist` output (including the SQL migrations), and runs the existing compiled production command `node dist/server.js` as the non-root `node` user (uid 1000). The image runs compiled JavaScript only; TypeScript is never executed in production.
- Docker Compose (`compose.yaml`) runs three services under the project name `ledger-assignment`: `db` (PostgreSQL 18), `migrate` (one-shot), and `api`. Only the API port `3000` is published to the host; PostgreSQL stays on the internal Compose network and is not published.
- Local credentials are clearly local-only: database `ledger`, user `ledger`, password `ledger`, defined directly in `compose.yaml` and never read from a `.env` file. `DATABASE_HOST` is the Compose service name `db`, never `127.0.0.1`. `APP_HOST=0.0.0.0` inside the API container.
- Health checks use `pg_isready` for PostgreSQL. The API health check uses Node's built-in `fetch` against `GET /health`, which returns `200` only when PostgreSQL is reachable, so the check reports database reachability honestly without exposing credentials.
- Migrations run through the existing compiled migration runner in a dedicated one-shot `migrate` service. The API waits on `depends_on.condition: service_completed_successfully`, so API startup fails if migration execution fails. The existing advisory lock, checksum verification, and `schema_migrations` table remain intact, so repeated startup runs never duplicate migrations.
- PostgreSQL data persists in the named volume `ledger-pg-data`, mounted at `/var/lib/postgresql` as required by the official PostgreSQL 18 image. Stopping or removing the Compose containers and network with `docker compose down` never deletes the named volume.
- The API container runs `node dist/server.js` as PID 1 rather than through the `npm` wrapper, so Docker's `SIGTERM` reaches the process that performs graceful shutdown by closing the Fastify server and database pool.
- Local credentials differ from production secret management. The Compose environment and `.env.example` use obvious non-secret placeholders. `.env` is never copied into the image and the build context excludes it via `.dockerignore`. Production must inject credentials through environment variables or a secret manager; it must never rely on `.env`, on the local `ledger`/`ledger` defaults, or on values baked into the Docker image.
