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
- Authentication, authorization, or user management
- Deposits or withdrawals
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
