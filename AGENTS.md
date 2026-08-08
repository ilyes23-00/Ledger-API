Transaction Ledger API Engineering Instructions

Purpose

These instructions apply to every task in this repository.

Act as a senior backend engineer building a correctness-critical transaction ledger API. Prioritize correctness, clarity, security, performance, testability, and scope discipline. Do not trade correctness for speed. Do not add features merely because they are common in production systems.

The assignment specification is the source of truth. If these instructions conflict with the assignment, follow the assignment and report the conflict before making changes.

Required behavior for every task

Before changing code:

Read the assignment, this file, the current implementation checklist, and the relevant existing code.

Restate the task internally as concrete acceptance criteria.

Identify which ledger invariants, API contracts, database constraints, concurrency behavior, tests, and documentation the task may affect.

Inspect existing patterns before introducing a new abstraction, dependency, folder, schema, response shape, or convention.

Check the latest stable official documentation for any dependency behavior that is version-sensitive. Do not rely on memory for current versions or APIs.

Prefer the smallest change that fully satisfies the requirement.

Do not start unrelated cleanup or expand the product scope.

While implementing:

Preserve every invariant in this file.

Keep business rules independent from HTTP and framework details where practical.

Keep correctness-critical database behavior explicit and reviewable.

Use strict TypeScript. Do not use any, unsafe casts, non-null assertions, or suppressed compiler errors without a documented and unavoidable reason.

Validate all untrusted input at the HTTP boundary.

Use parameterized database queries.

Add or update tests in the same change.

Keep transactions short and free from network calls.

Do not hide important behavior inside generic helpers or excessive abstractions.

Do not introduce compatibility code for unsupported runtimes or hypothetical future features.

Before declaring the task complete:

Review the full diff, including generated migrations and lockfile changes.

Verify the acceptance criteria one by one.

Run the relevant tests against real PostgreSQL when database behavior is involved.

Run formatting, linting, type checking, tests, and the production build.

Confirm no ledger invariant, API contract, security boundary, or concurrency guarantee was weakened.

Confirm no secret, debug output, stack trace, generated artifact, or unrelated file was added.

Report exactly what changed, what was verified, and any remaining limitation.

Never claim success when a required check was skipped or failed.

Non-negotiable ledger invariants

Every implementation and refactor must preserve all of the following:

A completed transfer debits one account and credits another by the exact same amount.

A transfer cannot create or destroy money.

No account balance can become negative.

A transfer amount must be a positive integer in minor currency units.

Floating-point values must never represent or calculate money.

Source and destination accounts must be different.

Source account, destination account, and request currency must match.

Both balance changes and the completed transfer record must commit atomically in one PostgreSQL transaction.

Any failure must roll back the complete transfer.

A transfer retry with the same idempotency key and identical request data must never move money twice.

Reusing an idempotency key with different transfer data must fail without changing financial state.

These guarantees must hold under concurrent requests handled by different stateless API instances.

No correctness guarantee may depend on process memory, request affinity, or one API instance.

Completed transfer records must not be edited or deleted through the API.

If a requested change could violate an invariant, stop and redesign it before implementation.

Money representation

Represent amounts as integer minor units across requests, domain logic, database records, and responses.

Use an exact PostgreSQL integer type with explicit range validation.

Do not coerce PostgreSQL BIGINT values into unsafe JavaScript numbers.

Define one supported serialization strategy and use it consistently.

Reject zero, negative, fractional, malformed, overflowed, or unsafe amounts before financial state is changed.

Do not perform currency conversion.

Do not silently round monetary input.

Transfer transaction rules

The critical transfer path must remain explicit.

Validate and normalize the request before opening the database transaction.

Require and validate the Idempotency-Key header.

Create a deterministic request fingerprint from the normalized source account, destination account, amount, and currency.

Enforce idempotency using a PostgreSQL unique constraint.

Never use an in-memory map, local mutex, cache, or application-only pre-check as the idempotency guarantee.

Execute idempotency handling, account validation, balance changes, and transfer persistence within a correctly designed database transaction.

Lock both account rows before reading the balance used for the funds decision.

Acquire account locks in deterministic account-ID order, regardless of transfer direction.

Recheck all state-dependent conditions while the rows are locked.

Debit and credit equal amounts inside the same transaction.

Persist the completed transfer result before committing.

Return the original persisted result for an exact retry.

Reject a conflicting idempotency-key reuse with 409 Conflict and no balance change.

Use only bounded retries for genuinely transient database failures.

Never automatically retry validation errors, insufficient funds, missing accounts, or idempotency conflicts.

Never perform external HTTP calls, logging transports, queue publishing, or other network work while account locks are held.

Any change to this path requires integration tests proving idempotency, conservation, rollback behavior, and concurrency safety.

Concurrency and multiple instances

Assume every request can reach a different stateless API instance.

Coordinate financial state through the shared PostgreSQL database.

Use PostgreSQL transactions, row-level locks, unique constraints, and check constraints as the correctness foundation.

Do not use process-local locks for cross-request correctness.

Do not assume ordered request arrival.

Do not assume a retry reaches the instance that processed the original request.

Do not cache mutable balances or idempotency state in application memory.

Keep lock acquisition order deterministic.

Use bounded database lock and statement timeouts.

Handle known transient database errors deliberately and observably.

Add real concurrent integration tests whenever shared account or idempotency behavior changes.

Database requirements

PostgreSQL is the source of truth.

Schema changes must use committed, deterministic migrations.

Review generated migrations before applying or committing them.

Enforce critical invariants with database constraints in addition to application validation.

Require a unique constraint for idempotency keys.

Require non-negative balance and positive transfer-amount constraints.

Require source and destination accounts to differ.

Use foreign keys for transfer account references.

Add indexes only for demonstrated access patterns, uniqueness, and necessary relational integrity.

Ensure transaction-history queries can use indexes for both incoming and outgoing transfers.

Select only required columns in critical queries.

Avoid unbounded or accidental full-table operations.

Do not use automatic schema synchronization as a replacement for migrations.

Never edit an already-applied migration. Add a new migration.

Do not add triggers, stored procedures, or database extensions unless they materially improve a required guarantee and are fully documented and tested.

HTTP API rules

The required API surface is:

Create an account.

Transfer funds between accounts.

Retrieve an account balance.

List an account's transactions.

For every endpoint:

Define request, response, and error schemas before implementing the handler.

Validate bodies, headers, path parameters, and query parameters.

Reject unexpected fields when the configured validation strategy supports it safely.

Use consistent HTTP status codes and stable machine-readable error codes.

Do not expose stack traces, SQL, credentials, internal paths, or database details.

Include a request identifier in logs and error responses.

Set a conservative request-body size limit.

Return only documented fields.

Keep handlers thin. Put domain and database behavior in focused services or repositories.

Ensure OpenAPI documentation is generated from or checked against the runtime schemas.

Add success, validation, not-found, conflict, and domain-error tests where applicable.

Do not add endpoints that are not required or explicitly approved.

Error handling

Use typed domain errors rather than parsing arbitrary error strings.

Map validation, not-found, conflict, insufficient-funds, and unexpected failures consistently.

Preserve the original internal error for structured server logs without exposing it to the client.

Do not catch errors only to ignore them.

Do not convert all failures into 200 OK responses.

Ensure failed financial operations leave no partial state.

Keep error responses deterministic so retries and tests can reason about them.

Security requirements

Implement security appropriate to the assignment without turning it into an unrelated production platform.

Validate all untrusted input.

Use parameterized queries and safe query-builder APIs.

Keep secrets in environment variables and provide only safe placeholders in .env.example.

Never commit .env, credentials, tokens, connection strings with real secrets, or private assignment material.

Redact secrets and sensitive fields from logs.

Use secure HTTP headers.

Disable or restrict CORS because no browser frontend is required.

Apply conservative body, header, connection, request, database, statement, and lock limits.

Run the production container as a non-root user.

Use supported dependency versions and commit the lockfile.

Review dependency updates and run the dependency audit before submission.

Do not weaken validation or constraints to make a failing test pass.

Do not implement custom cryptography.

Do not expose interactive API documentation in production without an explicit decision.

Authentication and authorization are deliberately out of scope unless the assignment changes. Document this limitation clearly instead of adding a rushed security model.

Rate limiting policy

Rate limiting is not one of the assignment's hard requirements and is explicitly identified as reasonable to leave out.

Do not add rate limiting automatically to every endpoint during the core implementation.

Prioritize idempotency, money conservation, concurrency correctness, tests, and documentation first.

Document rate limiting as a production follow-up when it is excluded.

If rate limiting is explicitly approved, define its purpose, key, limits, response headers, 429 contract, proxy behavior, and tests before implementation.

In a multiple-instance deployment, do not use process-local counters as a global rate limit.

Rate limiting must never be treated as a substitute for idempotency, transaction locking, input validation, or database constraints.

A rate-limit failure must not leave partial financial state.

Performance requirements

Optimize for correct, predictable performance without speculative complexity.

Keep database transactions and lock duration as short as possible.

Perform schema validation, normalization, and request fingerprint preparation before acquiring account locks.

Avoid network calls inside transactions.

Use a bounded PostgreSQL connection pool appropriate for multiple service instances.

Configure database, request, statement, and lock timeouts deliberately.

Avoid N+1 queries.

Use indexes that match actual transaction-history queries.

Avoid loading unnecessary columns or unbounded datasets.

Do not cache balances or idempotency state.

Do not add Redis, queues, workers, or background jobs without a demonstrated requirement.

Measure before optimizing. Do not weaken transaction safety for theoretical throughput.

Treat lock contention as expected behavior that must remain bounded, observable, and correct.

Dependency policy

Prefer the standard library and existing dependencies before adding a package.

Add a dependency only when it provides clear value for a required feature.

Verify the latest stable compatible version using official documentation or the package registry at implementation time.

Do not use beta, release-candidate, experimental, deprecated, unmaintained, or end-of-life packages.

Confirm compatibility with Node.js 24 LTS, TypeScript, Fastify, PostgreSQL, and the existing toolchain.

Install runtime dependencies under dependencies and build or test tooling under devDependencies.

Commit package-lock.json and use npm ci for reproducible installation.

Review lockfile changes for unexpected packages, install scripts, or major dependency expansion.

Do not add overlapping validation, logging, database, testing, or formatting libraries.

Do not upgrade unrelated dependencies during a focused feature task.

Run tests, type checking, build, and dependency audit after meaningful dependency changes.

TypeScript and code quality

Use strict TypeScript and ESM consistently.

Prefer small, cohesive modules with explicit responsibilities.

Use clear domain names rather than generic names such as data, item, or handler2.

Avoid premature abstractions, inheritance hierarchies, and generic repository frameworks.

Avoid duplicated financial rules.

Keep pure validation and transformation logic deterministic.

Do not suppress lint or compiler rules without a local explanation.

Remove dead code, commented-out code, debug logging, and unused exports.

Keep public functions and critical transaction code easy to trace.

Add comments only when they explain why a non-obvious correctness decision exists.

Do not comment what the code already states clearly.

Testing requirements

Tests must prioritize behavior that can lose or create money.

Use a real PostgreSQL database for transaction, locking, idempotency, constraint, migration, and concurrency tests.

Do not mock PostgreSQL to claim those guarantees are tested.

Make tests deterministic and independent.

Reset or isolate database state safely between tests.

Test the public HTTP behavior and the critical database behavior.

Prove that a valid transfer debits and credits equal values.

Prove total money is conserved.

Prove insufficient funds change no balances.

Prove exact retries move money once.

Prove concurrent exact retries create one completed transfer.

Prove conflicting idempotency-key reuse changes no financial state.

Prove concurrent transfers cannot overdraw an account.

Prove opposite-direction transfers do not corrupt balances.

Prove failures roll back all financial changes.

Prove history contains correct incoming and outgoing transfers in deterministic order.

Test malformed identifiers, missing headers, invalid amounts, unsafe ranges, equal accounts, missing accounts, and currency mismatches.

Verify internal failures do not leak implementation details.

Run concurrency-sensitive tests repeatedly before submission.

Never change a correct test merely to accommodate an incorrect implementation.

Logging and observability

Use structured logs.

Include request identifiers and safe domain identifiers needed for debugging.

Do not log complete request bodies by default.

Avoid logging full idempotency keys unless safely hashed or truncated and genuinely required.

Never log database credentials, environment secrets, or stack traces to clients.

Log unexpected failures with enough internal context to diagnose them.

Avoid noisy logs inside tight loops or high-contention paths.

Keep advanced metrics, traces, dashboards, and alerting out of scope unless explicitly approved.

Docker and local environment

The repository must run locally from a clean clone using documented commands.

Use Docker Compose for the shared PostgreSQL service and, when completed, the API service.

Use PostgreSQL health checks instead of arbitrary startup sleeps.

Use a named volume for local persistence.

Use a multistage API image and run it as a non-root user.

Keep build context small with .dockerignore.

Do not copy .env, tests, local artifacts, or assignment documents into the production image.

Pin intentional major runtime versions and use the lockfile for JavaScript dependency reproducibility.

Keep local-development credentials clearly separate from production guidance.

Documentation rules

Keep the README until the implementation is complete, then write it from verified behavior.

Do not document planned behavior as implemented behavior.

Every documented command must be executed successfully from a clean checkout.

Every API example must match the actual request and response schemas.

Explain idempotency, conservation, concurrency, deterministic locking, and multiple-instance behavior clearly.

State the actual transaction isolation level and why it is sufficient.

Explain deliberate exclusions and what would be added next.

Describe important tradeoffs honestly.

Keep OpenAPI output aligned with runtime validation.

Remove placeholders and implementation-status notes before submission.

Scope discipline

Required work takes priority over production extras.

Do not add the following unless explicitly approved after the core requirements and tests pass:

Frontend or dashboard

Authentication or user management

Deposits or withdrawals

Currency conversion

Transfer cancellation or mutation

Pagination

Rate limiting

Redis

Queues or event streaming

Microservices

Kubernetes or cloud infrastructure

Advanced audit or observability platforms

Unrelated CRUD endpoints

Generic frameworks created only for hypothetical reuse

If a useful improvement is outside scope, record it in the README's future-work section instead of implementing it.

Prohibited shortcuts

Never:

Store balances, transfer truth, locks, or idempotency state only in memory.

Check a balance outside the lock-protected transaction and trust that result.

Update the debit and credit in separate transactions.

Use floating-point money.

Depend only on application validation for database invariants.

Catch and ignore database errors.

Disable tests, constraints, lint rules, or strict typing to make progress appear faster.

Mock concurrency and claim it proves real database behavior.

add a dependency without checking its purpose, maintenance, stability, and compatibility.

Change API behavior without updating schemas and tests.

Claim a requirement is complete without verification.

Add unrelated features that reduce review clarity.

Completion standard for each task

A task is complete only when:

Its acceptance criteria are satisfied.

Relevant invariants remain protected.

Input validation and error behavior are defined.

Security and performance impact were considered.

Tests cover the important success, failure, retry, and concurrency behavior.

Relevant tests pass against real PostgreSQL.

Formatting, linting, type checking, and build checks pass.

Migrations and dependency changes were reviewed.

Documentation is updated when the implemented contract changes.

The final implementation can be explained and defended in the technical interview.

Final submission gate

Do not recommend submission until all of the following are true:

A clean clone installs with npm ci.

The documented local environment starts successfully.

Migrations apply successfully to an empty PostgreSQL database.

All required endpoints work and match their schemas.

Real PostgreSQL tests prove idempotency, conservation, rollback, and concurrency behavior.

Repeated concurrency test runs remain stable.

Formatting, linting, type checking, dependency review, tests, and production build pass.

The service restarts without losing persisted data.

No secrets, assignment documents, local artifacts, or debug output are committed.

The final README contains only verified commands and behavior.

The repository remains focused on the requested backend API.

Every significant design decision can be defended clearly.