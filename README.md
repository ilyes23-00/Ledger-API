# Transaction Ledger API

A backend-only HTTP API for creating accounts, transferring USD funds, reading balances, and listing transaction history.

The implementation focuses on the three guarantees required by the assignment:

1. Retrying the same transfer cannot move money twice.
2. A transfer cannot create money or make a balance negative.
3. These guarantees remain correct under concurrent requests and across multiple stateless API instances.

## Quick start

### Requirements

- Docker with Docker Compose
- Port `3000` available

### Run the API

```bash
git clone <repository-url>
cd <repository-directory>
docker compose -p ledger-assignment up -d --build
```

The command starts PostgreSQL 18, applies the database migrations, and then starts the API.

Check that everything is ready:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "database": {
    "reachable": true
  }
}
```

View service status or logs:

```bash
docker compose -p ledger-assignment ps
docker compose -p ledger-assignment logs -f api
```

Stop the application:

```bash
docker compose -p ledger-assignment down
```

The database uses a named Docker volume, so data remains available after restarting the containers. Running `docker compose -p ledger-assignment down -v` also deletes the local database data.

## Manual API test

The following sequence tests all four required operations.

### 1. Create a source account

Amounts are USD minor units represented as strings. For example, `"5000"` means USD 50.00.

```bash
curl -i -X POST http://localhost:3000/accounts \
  -H 'Content-Type: application/json' \
  -d '{"currency":"USD","initialBalance":"5000"}'
```

The response is `201 Created`:

```json
{
  "accountId": "<source-account-id>",
  "balance": "5000",
  "currency": "USD",
  "createdAt": "<timestamp>"
}
```

Copy the returned `accountId`; it is used as `<source-account-id>` below.

### 2. Create a destination account

```bash
curl -i -X POST http://localhost:3000/accounts \
  -H 'Content-Type: application/json' \
  -d '{"currency":"USD","initialBalance":"0"}'
```

Copy this response's `accountId` as `<destination-account-id>`.

### 3. Transfer funds

Replace both account ID placeholders before running the command:

```bash
curl -i -X POST http://localhost:3000/transfers \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: manual-transfer-001' \
  -d '{
    "sourceAccountId":"<source-account-id>",
    "destinationAccountId":"<destination-account-id>",
    "amount":"1500",
    "currency":"USD"
  }'
```

The response is `201 Created`. The source balance is now `3500`, and the destination balance is `1500`.

### 4. Test an idempotent retry

Run the exact transfer command from step 3 again with the same body and `Idempotency-Key`.

The API returns the same `transferId` and original transfer response. The balances do not change a second time.

Reusing the same key with different transfer data returns `409 Conflict` and does not move money.

### 5. Get the balances

```bash
curl -i http://localhost:3000/accounts/<source-account-id>/balance
curl -i http://localhost:3000/accounts/<destination-account-id>/balance
```

Expected balances:

- Source: `"3500"`
- Destination: `"1500"`

### 6. List transaction history

```bash
curl -i http://localhost:3000/accounts/<source-account-id>/transactions
curl -i http://localhost:3000/accounts/<destination-account-id>/transactions
```

The source history shows the transfer as `outgoing`; the destination history shows it as `incoming`.

More request and error examples are available in [`docs/API_EXAMPLES.md`](docs/API_EXAMPLES.md).

## API

| Method | Endpoint | Description | Success |
| --- | --- | --- | --- |
| `POST` | `/accounts` | Create a USD account with an opening balance | `201` |
| `POST` | `/transfers` | Transfer funds between two accounts | `201` |
| `GET` | `/accounts/:accountId/balance` | Read the current balance | `200` |
| `GET` | `/accounts/:accountId/transactions` | List incoming and outgoing transfers | `200` |
| `GET` | `/health` | Check API and database availability | `200` or `503` |

`POST /transfers` requires an `Idempotency-Key` header. Error responses use a consistent format:

```json
{
  "code": "ERROR_CODE",
  "message": "Human-readable message",
  "requestId": "req-example"
}
```

## Run the automated tests

### Requirements

- Node.js 24
- npm
- Docker

Install dependencies:

```bash
nvm use
npm ci
```

### Fast tests without PostgreSQL

```bash
npm run test -- tests/contracts.test.ts tests/app.test.ts tests/transfers.app.test.ts
```

### Complete test suite

The transaction, locking, migration, idempotency, and concurrency tests use a real PostgreSQL database. Start a disposable PostgreSQL 18 test database:

```bash
docker run --name ledger-test-db --rm -d \
  -e POSTGRES_USER=ledger_test \
  -e POSTGRES_PASSWORD=ledger_test \
  -e POSTGRES_DB=ledger_test \
  -p 5433:5432 \
  postgres:18
```

Wait until it is ready:

```bash
until docker exec ledger-test-db pg_isready -U ledger_test -d ledger_test; do sleep 1; done
```

Run every verification check:

```bash
SCHEMA_TEST_DATABASE_URL='postgresql://ledger_test:ledger_test@127.0.0.1:5433/ledger_test' npm run verify
```

This runs formatting, linting, type checking, all tests, and the production build. Stop the disposable test database afterward:

```bash
docker stop ledger-test-db
```

The test database name must end in `_test`. The test helper refuses unsafe database names before resetting schema data.

## Design decisions

### PostgreSQL is the source of truth

Balances, transfers, idempotency records, and locks live in PostgreSQL. The API instances are stateless and keep no correctness-critical balance or idempotency data in memory.

### Exact money representation

Money is stored as integer USD minor units in PostgreSQL `BIGINT` columns and serialized as decimal strings in JSON. JavaScript floating-point numbers are never used for monetary calculations.

An account's `initialBalance` is the trusted point where money enters the system. After creation, balances can change only through transfers.

### Idempotency

Each transfer requires an idempotency key. The API creates a deterministic fingerprint from the normalized source, destination, amount, and currency. PostgreSQL enforces a unique constraint on the key.

- The same key and same request return the original transfer without updating balances again.
- The same key with different data returns `409 Conflict` without changing balances.
- Concurrent retries handled by different API instances converge on one persisted transfer.

### Conservation and concurrency

Each transfer runs in one PostgreSQL transaction:

1. Claim the idempotency key.
2. Lock both account rows with `SELECT ... FOR UPDATE` in deterministic account-ID order.
3. Check account existence, currency, available funds, and overflow while the rows are locked.
4. Debit the source and credit the destination by the same amount.
5. Persist the transfer and commit.

Any failure rolls back the entire operation. PostgreSQL constraints also prevent negative balances, non-positive transfer amounts, duplicate idempotency keys, and equal source and destination accounts.

The API uses PostgreSQL `READ COMMITTED` isolation. Explicit row locks, deterministic lock ordering, the unique idempotency constraint, and database checks provide the required guarantees even when requests reach different stateless instances.

## Project structure

```text
src/
  contracts/       Request, response, error, and OpenAPI schemas
  db/              PostgreSQL repositories, transactions, and migrations
  routes/          Fastify HTTP routes
  services/        Account and transfer use cases
  app.ts           Fastify application setup
  server.ts        Process startup and graceful shutdown
tests/              Unit, HTTP, database, and concurrency tests
docs/               Complete API examples
Dockerfile          Production API image
compose.yaml        Local API, migration, and PostgreSQL services
```

## Deliberate exclusions

The assignment prioritizes a small, correct core. The following are intentionally not included:

- Authentication and authorization
- Pagination
- Rate limiting
- Deposits and withdrawals
- Currency conversion or multi-currency accounts
- Redis, queues, and background workers
- Advanced audit logging, metrics, and tracing
- Frontend or deployment infrastructure

Before production use, the first additions would be authentication and account-level authorization, followed by cursor pagination, shared rate limiting, managed secrets, operational monitoring, backups, and deployment automation.

## Tradeoff

This implementation stores a current balance per account plus immutable completed transfers. It keeps reads and the critical transfer flow simple and reviewable for the assignment.

A full financial product would normally use a double-entry journal with immutable debit and credit postings, reconciliation, and stronger audit capabilities. That added complexity was deliberately left outside this exercise.
