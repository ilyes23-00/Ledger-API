import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, Pool } from 'pg';

import { createApp } from '../src/app.js';
import type { AppEnvironment } from '../src/config/env.js';
import {
  findAccountById,
  listAccountTransactions,
  insertAccount,
  insertTransferIfAbsent,
  findTransferByIdempotencyKey,
  lockAccountsById,
  updateAccountBalance,
} from '../src/db/index.js';
import { createDatabaseConnection } from '../src/db/pool.js';
import { runMigrations } from '../src/scripts/migrate.js';
import { createAccountWithDatabase } from '../src/services/create-account.js';
import { createTransfer } from '../src/services/create-transfer.js';
import { getAccountBalanceWithDatabase } from '../src/services/get-account-balance.js';
import { getAccountTransactionsWithDatabase } from '../src/services/get-account-transactions.js';
import { createClient, getSchemaTestDatabaseUrl } from './helpers/postgres.js';

const migrationDirectory = path.resolve('src/db/migrations');
const testDatabaseUrl = process.env['SCHEMA_TEST_DATABASE_URL'];

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';

describe.skipIf(testDatabaseUrl === undefined || testDatabaseUrl.trim() === '')(
  'section 11 timeout safeguards with real PostgreSQL',
  () => {
    let database: ReturnType<typeof createDatabaseConnection>;
    let pool: Pool;

    beforeAll(async () => {
      await runMigrations({
        connectionString: getSchemaTestDatabaseUrl(),
        migrationsDirectory: migrationDirectory,
      });

      database = createDatabaseConnection(createSection11DatabaseConfig());
      pool = database.pool;
    });

    afterAll(async () => {
      await database.close();
    });

    it('rolls back the full transfer, clears the idempotency claim, returns a safe response, and allows a later retry after a lock timeout', async () => {
      const app = await createTimeoutTestApp(pool, {
        statementTimeoutMs: 1200,
        lockTimeoutMs: 150,
      });
      const blocker = createClient(getSchemaTestDatabaseUrl());
      const observer = createClient(getSchemaTestDatabaseUrl());
      await blocker.connect();
      await observer.connect();

      try {
        await resetLedger(observer);
        await seedAccounts(observer, [
          [accountA, '5000'],
          [accountB, '1000'],
        ]);

        await blocker.query('BEGIN');
        await blocker.query(
          `SELECT id
           FROM accounts
           WHERE id = $1
           FOR UPDATE`,
          [accountA],
        );

        const timedOutResponse = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:lock-timeout',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });

        expect(timedOutResponse.statusCode).toBe(500);
        expect(timedOutResponse.json()).toMatchObject({
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred.',
        });
        expect(timedOutResponse.body).not.toContain('lock_timeout');
        expect(timedOutResponse.body).not.toContain('55P03');
        expect(timedOutResponse.body).not.toContain('SQLSTATE');
        expect(timedOutResponse.body).not.toContain('stack');
        expect(timedOutResponse.body).not.toContain('/Users/macbook');

        expect(await fetchBalancesById(observer)).toEqual(
          new Map([
            [accountA, '5000'],
            [accountB, '1000'],
          ]),
        );
        expect(await fetchTransfers(observer)).toHaveLength(0);
        expect(
          await fetchTransferByIdempotencyKey(
            observer,
            'transfer.20260808:lock-timeout',
          ),
        ).toBeNull();

        await blocker.query('ROLLBACK');

        const retryResponse = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:lock-timeout',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });

        expect(retryResponse.statusCode).toBe(201);
        expect(await fetchBalancesById(observer)).toEqual(
          new Map([
            [accountA, '4000'],
            [accountB, '2000'],
          ]),
        );
        expect(await fetchTransfers(observer)).toHaveLength(1);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await resetLedger(observer);
        await blocker.end();
        await observer.end();
        await app.close();
      }
    });

    it('rolls back the full transfer and idempotency claim on statement timeout without leaking transaction-local timeouts to the next pooled transaction', async () => {
      let timedOutTransactionPid: number | null = null;
      const app = await createTimeoutTestApp(pool, {
        statementTimeoutMs: 100,
        lockTimeoutMs: 50,
        sleepBeforeLockMs: 200,
        recordBackendPid: (pid) => {
          timedOutTransactionPid = pid;
        },
      });
      const observer = createClient(getSchemaTestDatabaseUrl());
      await observer.connect();

      try {
        await resetLedger(observer);
        await seedAccounts(observer, [
          [accountA, '5000'],
          [accountB, '1000'],
        ]);

        const timedOutResponse = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:statement-timeout',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });

        expect(timedOutResponse.statusCode).toBe(500);
        expect(timedOutResponse.json()).toMatchObject({
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred.',
        });
        expect(timedOutResponse.body).not.toContain('statement_timeout');
        expect(timedOutResponse.body).not.toContain('57014');
        expect(timedOutResponse.body).not.toContain('pg_sleep');
        expect(timedOutResponse.body).not.toContain('stack');
        expect(timedOutResponse.body).not.toContain('/Users/macbook');

        expect(await fetchBalancesById(observer)).toEqual(
          new Map([
            [accountA, '5000'],
            [accountB, '1000'],
          ]),
        );
        expect(await fetchTransfers(observer)).toHaveLength(0);
        expect(
          await fetchTransferByIdempotencyKey(
            observer,
            'transfer.20260808:statement-timeout',
          ),
        ).toBeNull();

        const sameConnectionDefaults =
          await readTimeoutSettingsInTransaction(pool);
        expect(sameConnectionDefaults.pid).toBe(timedOutTransactionPid);
        expect(sameConnectionDefaults).toEqual({
          pid: timedOutTransactionPid,
          statementTimeout: '15s',
          lockTimeout: '5s',
          idleInTransactionSessionTimeout: '10s',
        });
      } finally {
        await resetLedger(observer);
        await observer.end();
        await app.close();
      }
    });
  },
);

type TimeoutAppOptions = {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  sleepBeforeLockMs?: number;
  recordBackendPid?: (pid: number) => void;
};

const createTimeoutTestApp = async (pool: Pool, options: TimeoutAppOptions) =>
  createApp({
    logger: false,
    dependencies: {
      checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
      createAccount: createAccountWithDatabase(insertAccount, pool),
      getAccountBalance: getAccountBalanceWithDatabase(findAccountById, pool),
      getAccountTransactions: getAccountTransactionsWithDatabase(
        findAccountById,
        listAccountTransactions,
        pool,
      ),
      createTransfer: createTransfer({
        transactionPool: pool,
        insertTransferIfAbsent,
        findTransferByIdempotencyKey,
        lockAccountsById: async (client, firstAccountId, secondAccountId) => {
          if (options.recordBackendPid !== undefined) {
            const pidResult = await client.query(
              'SELECT pg_backend_pid() AS pid',
            );
            const firstRow = pidResult.rows[0];
            const pid = firstRow?.['pid'];

            if (typeof pid !== 'number') {
              throw new Error('Expected pg_backend_pid() to return one row.');
            }

            options.recordBackendPid(pid);
          }

          if (options.sleepBeforeLockMs !== undefined) {
            await client.query('SELECT pg_sleep($1)', [
              options.sleepBeforeLockMs / 1000,
            ]);
          }

          return lockAccountsById(client, firstAccountId, secondAccountId);
        },
        updateAccountBalance,
        transactionTimeouts: {
          statementTimeoutMs: options.statementTimeoutMs,
          lockTimeoutMs: options.lockTimeoutMs,
          idleInTransactionSessionTimeoutMs: 500,
        },
      }),
    },
  });

const sendTransfer = (
  app: Awaited<ReturnType<typeof createTimeoutTestApp>>,
  options: {
    idempotencyKey: string;
    sourceAccountId: string;
    destinationAccountId: string;
    amount: string;
  },
) =>
  app.inject({
    method: 'POST',
    url: '/transfers',
    headers: {
      'idempotency-key': options.idempotencyKey,
    },
    payload: {
      sourceAccountId: options.sourceAccountId,
      destinationAccountId: options.destinationAccountId,
      amount: options.amount,
      currency: 'USD',
    },
  });

const seedAccounts = async (
  client: Client,
  rows: ReadonlyArray<readonly [string, string]>,
): Promise<void> => {
  for (const [accountId, balance] of rows) {
    await client.query(
      `INSERT INTO accounts (id, balance_minor, currency)
       VALUES ($1, $2, 'USD')`,
      [accountId, balance],
    );
  }
};

const fetchBalancesById = async (
  client: Client,
): Promise<Map<string, string>> => {
  const result = await client.query<{
    id: string;
    balance_minor: string;
  }>(
    `SELECT id, balance_minor
     FROM accounts
     ORDER BY id ASC`,
  );

  return new Map(result.rows.map((row) => [row.id, row.balance_minor]));
};

const fetchTransfers = async (
  client: Client,
): Promise<Array<{ id: string }>> => {
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM transfers
     ORDER BY created_at ASC, id ASC`,
  );

  return result.rows;
};

const fetchTransferByIdempotencyKey = async (
  client: Client,
  idempotencyKey: string,
): Promise<{ id: string } | null> => {
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM transfers
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );

  return result.rows[0] ?? null;
};

const readTimeoutSettingsInTransaction = async (
  pool: Pool,
): Promise<{
  pid: number;
  statementTimeout: string;
  lockTimeout: string;
  idleInTransactionSessionTimeout: string;
}> => {
  const client = await pool.connect();

  try {
    const pidResult = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );

    await client.query('BEGIN');
    const settingsResult = await client.query<{
      statement_timeout: string;
      lock_timeout: string;
      idle_in_transaction_session_timeout: string;
      pid: number;
    }>(
      `SELECT
         current_setting('statement_timeout') AS statement_timeout,
         current_setting('lock_timeout') AS lock_timeout,
         current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
         pg_backend_pid() AS pid`,
    );
    await client.query('COMMIT');

    expect(settingsResult.rows[0]?.pid).toBe(pidResult.rows[0]?.pid);

    const row = settingsResult.rows[0];

    if (row === undefined) {
      throw new Error('Expected timeout settings query to return one row.');
    }

    return {
      pid: row.pid,
      statementTimeout: row.statement_timeout,
      lockTimeout: row.lock_timeout,
      idleInTransactionSessionTimeout: row.idle_in_transaction_session_timeout,
    };
  } finally {
    client.release();
  }
};

const resetLedger = async (client: Client): Promise<void> => {
  await client.query('TRUNCATE TABLE transfers, accounts RESTART IDENTITY');
};

const createSection11DatabaseConfig = (): AppEnvironment['database'] => ({
  host: '127.0.0.1',
  port: 54329,
  name: 'ledger_history_test',
  user: 'ledger',
  password: 'ledger',
  poolMax: 1,
  poolMin: 0,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  statementTimeoutMs: 15000,
  lockTimeoutMs: 5000,
  idleInTransactionSessionTimeoutMs: 10000,
});
