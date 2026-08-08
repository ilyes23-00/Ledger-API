import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Client } from 'pg';

import { createApp } from '../src/app.js';
import {
  findAccountById,
  insertAccount,
  insertTransfer,
  listAccountTransactions,
} from '../src/db/index.js';
import { MAX_MINOR_UNITS } from '../src/contracts/index.js';
import { runMigrations } from '../src/scripts/migrate.js';
import { createAccountWithDatabase } from '../src/services/create-account.js';
import { getAccountBalanceWithDatabase } from '../src/services/get-account-balance.js';
import { getAccountTransactionsWithDatabase } from '../src/services/get-account-transactions.js';
import { createClient, getSchemaTestDatabaseUrl } from './helpers/postgres.js';

const migrationDirectory = path.resolve('src/db/migrations');
const testDatabaseUrl = process.env['SCHEMA_TEST_DATABASE_URL'];

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';
const accountC = '33333333-3333-4333-8333-333333333333';
const accountD = '44444444-4444-4444-8444-444444444444';

describe.skipIf(testDatabaseUrl === undefined || testDatabaseUrl.trim() === '')(
  'section 9 account transaction history with real PostgreSQL',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      await runMigrations({
        connectionString: getSchemaTestDatabaseUrl(),
        migrationsDirectory: migrationDirectory,
      });

      pool = new Pool({
        connectionString: getSchemaTestDatabaseUrl(),
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('returns both incoming and outgoing transfers, excludes unrelated rows, and preserves exact ordering and amount strings', async () => {
      const app = await createHistoryTestApp(pool);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '9000'],
          [accountB, '1000'],
          [accountC, '2000'],
          [accountD, '3000'],
        ]);

        await seedTransfer(client, {
          transferId: 'f0000000-0000-4000-8000-000000000001',
          idempotencyKey: 'history.20260808:outgoing',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '9223372036854775807',
          createdAt: '2026-08-08T12:00:00.000Z',
        });
        await seedTransfer(client, {
          transferId: 'f0000000-0000-4000-8000-000000000003',
          idempotencyKey: 'history.20260808:incoming-newer-id',
          sourceAccountId: accountC,
          destinationAccountId: accountA,
          amount: '10',
          createdAt: '2026-08-08T12:00:00.000Z',
        });
        await seedTransfer(client, {
          transferId: 'f0000000-0000-4000-8000-000000000002',
          idempotencyKey: 'history.20260808:incoming-older-id',
          sourceAccountId: accountD,
          destinationAccountId: accountA,
          amount: '20',
          createdAt: '2026-08-08T12:00:00.000Z',
        });
        await seedTransfer(client, {
          transferId: 'f0000000-0000-4000-8000-000000000004',
          idempotencyKey: 'history.20260808:unrelated',
          sourceAccountId: accountB,
          destinationAccountId: accountC,
          amount: '30',
          createdAt: '2026-08-08T11:59:00.000Z',
        });

        const response = await app.inject({
          method: 'GET',
          url: `/accounts/${accountA}/transactions`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          accountId: accountA,
          transactions: [
            {
              transferId: 'f0000000-0000-4000-8000-000000000003',
              sourceAccountId: accountC,
              destinationAccountId: accountA,
              amount: '10',
              currency: 'USD',
              status: 'completed',
              direction: 'incoming',
              createdAt: '2026-08-08T12:00:00.000Z',
            },
            {
              transferId: 'f0000000-0000-4000-8000-000000000002',
              sourceAccountId: accountD,
              destinationAccountId: accountA,
              amount: '20',
              currency: 'USD',
              status: 'completed',
              direction: 'incoming',
              createdAt: '2026-08-08T12:00:00.000Z',
            },
            {
              transferId: 'f0000000-0000-4000-8000-000000000001',
              sourceAccountId: accountA,
              destinationAccountId: accountB,
              amount: MAX_MINOR_UNITS,
              currency: 'USD',
              status: 'completed',
              direction: 'outgoing',
              createdAt: '2026-08-08T12:00:00.000Z',
            },
          ],
        });
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('returns an empty array for an existing account with no transfers and repeated reads do not mutate rows', async () => {
      const app = await createHistoryTestApp(pool);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '5000'],
          [accountB, '1000'],
        ]);
        await seedTransfer(client, {
          transferId: 'f0000000-0000-4000-8000-000000000010',
          idempotencyKey: 'history.20260808:mutation-check',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '50',
          createdAt: '2026-08-08T12:00:00.000Z',
        });

        const beforeState = await captureLedgerState(client);
        const emptyResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${accountD}/transactions`,
        });
        const firstRead = await app.inject({
          method: 'GET',
          url: `/accounts/${accountA}/transactions`,
        });
        const secondRead = await app.inject({
          method: 'GET',
          url: `/accounts/${accountA}/transactions`,
        });
        const afterState = await captureLedgerState(client);

        expect(emptyResponse.statusCode).toBe(404);
        expect(firstRead.statusCode).toBe(200);
        expect(secondRead.statusCode).toBe(200);
        expect(firstRead.json()).toEqual(secondRead.json());
        expect(beforeState).toEqual(afterState);

        await client.query(
          `INSERT INTO accounts (id, balance_minor, currency)
           VALUES ($1, $2, $3)`,
          [accountD, '0', 'USD'],
        );

        const existingEmptyResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${accountD}/transactions`,
        });

        expect(existingEmptyResponse.statusCode).toBe(200);
        expect(existingEmptyResponse.json()).toEqual({
          accountId: accountD,
          transactions: [],
        });
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('returns 404 for unknown accounts and safe 500 responses for unexpected database failures', async () => {
      const app = await createHistoryTestApp(pool);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [[accountA, '5000']]);

        const notFoundResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${accountB}/transactions`,
        });

        expect(notFoundResponse.statusCode).toBe(404);
        expect(notFoundResponse.json()).toMatchObject({
          code: 'UNKNOWN_ACCOUNT',
          message: 'Referenced account does not exist.',
        });
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }

      const failingApp = await createApp({
        logger: false,
        dependencies: {
          checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
          createAccount: createAccountWithDatabase(insertAccount, pool),
          getAccountBalance: getAccountBalanceWithDatabase(
            findAccountById,
            pool,
          ),
          getAccountTransactions: () =>
            Promise.reject(
              new Error(
                'select * from transfers leaked /Users/macbook/Projects/assigemnet/chekin',
              ),
            ),
        },
      });

      const failureResponse = await failingApp.inject({
        method: 'GET',
        url: `/accounts/${accountA}/transactions`,
      });

      expect(failureResponse.statusCode).toBe(500);
      expect(failureResponse.body).not.toContain('select *');
      expect(failureResponse.body).not.toContain(
        '/Users/macbook/Projects/assigemnet/chekin',
      );

      await failingApp.close();
    });

    it('uses both history indexes in the production query plan', async () => {
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '100'],
          [accountB, '100'],
          [accountC, '100'],
        ]);

        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');

        for (let index = 0; index < 8; index += 1) {
          const outgoingTransferSuffix = String(100 + index).padStart(12, '0');
          const incomingTransferSuffix = String(200 + index).padStart(12, '0');

          await seedTransfer(client, {
            transferId: `f0000000-0000-4000-8000-${outgoingTransferSuffix}`,
            idempotencyKey: `history.20260808:plan-out-${index}`,
            sourceAccountId: accountA,
            destinationAccountId: accountB,
            amount: '1',
            createdAt: `2026-08-08T12:00:0${index}.000Z`,
          });
          await seedTransfer(client, {
            transferId: `f0000000-0000-4000-8000-${incomingTransferSuffix}`,
            idempotencyKey: `history.20260808:plan-in-${index}`,
            sourceAccountId: accountC,
            destinationAccountId: accountA,
            amount: '1',
            createdAt: `2026-08-08T12:01:0${index}.000Z`,
          });
        }

        const explain = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN
           SELECT
             id,
             source_account_id,
             destination_account_id,
             amount_minor,
             currency,
             status,
             direction,
             created_at
           FROM (
             SELECT
               id,
               source_account_id,
               destination_account_id,
               amount_minor,
               currency,
               status,
               'outgoing'::text AS direction,
               created_at
             FROM transfers
             WHERE source_account_id = $1

             UNION ALL

             SELECT
               id,
               source_account_id,
               destination_account_id,
               amount_minor,
               currency,
               status,
               'incoming'::text AS direction,
               created_at
             FROM transfers
             WHERE destination_account_id = $1
           ) AS account_transfers
           ORDER BY created_at DESC, id DESC`,
          [accountA],
        );

        const planText = explain.rows
          .map((row) => row['QUERY PLAN'])
          .join('\n');

        expect(planText).toContain('transfers_source_account_history_idx');
        expect(planText).toContain('transfers_destination_account_history_idx');

        await client.query('ROLLBACK');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await resetLedger(client);
        await client.end();
      }
    });
  },
);

const createHistoryTestApp = async (pool: Pool) =>
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

const seedTransfer = async (
  client: Client,
  transfer: {
    transferId: string;
    idempotencyKey: string;
    sourceAccountId: string;
    destinationAccountId: string;
    amount: string;
    createdAt: string;
  },
): Promise<void> => {
  await insertTransfer(client, {
    id: transfer.transferId,
    idempotencyKey: transfer.idempotencyKey,
    requestFingerprint: 'a'.repeat(64),
    sourceAccountId: transfer.sourceAccountId,
    destinationAccountId: transfer.destinationAccountId,
    amount: transfer.amount,
    currency: 'USD',
    status: 'completed',
  });

  await client.query(
    `UPDATE transfers
     SET created_at = $2
     WHERE id = $1`,
    [transfer.transferId, transfer.createdAt],
  );
};

const captureLedgerState = async (
  client: Client,
): Promise<{
  accounts: Array<{ id: string; balance_minor: string; updated_at: string }>;
  transfers: Array<{ id: string; created_at: string }>;
}> => {
  const accounts = await client.query<{
    id: string;
    balance_minor: string;
    updated_at: Date;
  }>(
    `SELECT id, balance_minor, updated_at
     FROM accounts
     ORDER BY id ASC`,
  );
  const transfers = await client.query<{
    id: string;
    created_at: Date;
  }>(
    `SELECT id, created_at
     FROM transfers
     ORDER BY id ASC`,
  );

  return {
    accounts: accounts.rows.map((row) => ({
      id: row.id,
      balance_minor: row.balance_minor,
      updated_at: row.updated_at.toISOString(),
    })),
    transfers: transfers.rows.map((row) => ({
      id: row.id,
      created_at: row.created_at.toISOString(),
    })),
  };
};

const resetLedger = async (client: Client): Promise<void> => {
  await client.query('TRUNCATE TABLE transfers, accounts RESTART IDENTITY');
};
