import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createApp } from '../src/app.js';
import { MAX_MINOR_UNITS } from '../src/contracts/index.js';
import { findAccountById, insertAccount } from '../src/db/index.js';
import { runMigrations } from '../src/scripts/migrate.js';
import { createAccountWithDatabase } from '../src/services/create-account.js';
import { getAccountBalanceWithDatabase } from '../src/services/get-account-balance.js';
import { createClient, getSchemaTestDatabaseUrl } from './helpers/postgres.js';

const migrationDirectory = path.resolve('src/db/migrations');
const testDatabaseUrl = process.env['SCHEMA_TEST_DATABASE_URL'];

describe.skipIf(testDatabaseUrl === undefined || testDatabaseUrl.trim() === '')(
  'section 7 account balance with real PostgreSQL',
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

    it('retrieves the current persisted balance and rereads PostgreSQL on every request', async () => {
      let lookupCount = 0;
      const app = await createApp({
        logger: false,
        dependencies: {
          checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
          createAccount: createAccountWithDatabase(insertAccount, pool),
          getAccountBalance: getAccountBalanceWithDatabase(
            async (queryable, accountId) => {
              lookupCount += 1;
              return findAccountById(queryable, accountId);
            },
            pool,
          ),
        },
      });
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );

        const createdResponse = await app.inject({
          method: 'POST',
          url: '/accounts',
          payload: {
            currency: 'USD',
            initialBalance: '0',
          },
        });

        expect(createdResponse.statusCode).toBe(201);
        const createdBody = createdResponse.json<{ accountId: string }>();

        const initialCounts = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts',
        );
        const initialTimestamps = await client.query<{
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT created_at, updated_at
           FROM accounts
           WHERE id = $1`,
          [createdBody.accountId],
        );

        const firstBalanceResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${createdBody.accountId}/balance`,
        });

        expect(firstBalanceResponse.statusCode).toBe(200);
        expect(firstBalanceResponse.json()).toEqual({
          accountId: createdBody.accountId,
          balance: '0',
          currency: 'USD',
        });

        const rowCountBeforeUpdate = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts WHERE id = $1',
          [createdBody.accountId],
        );
        const countsAfterFirstRead = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts',
        );
        const timestampsAfterFirstRead = await client.query<{
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT created_at, updated_at
           FROM accounts
           WHERE id = $1`,
          [createdBody.accountId],
        );

        await client.query(
          `UPDATE accounts
           SET balance_minor = $2
           WHERE id = $1`,
          [createdBody.accountId, MAX_MINOR_UNITS],
        );

        const secondBalanceResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${createdBody.accountId}/balance`,
        });

        expect(secondBalanceResponse.statusCode).toBe(200);
        expect(secondBalanceResponse.json()).toEqual({
          accountId: createdBody.accountId,
          balance: MAX_MINOR_UNITS,
          currency: 'USD',
        });

        const persistedAccount = await client.query<{
          id: string;
          balance_minor: string;
          currency: string;
        }>(
          `SELECT id, balance_minor, currency
           FROM accounts
           WHERE id = $1`,
          [createdBody.accountId],
        );
        const afterUpdateCount = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts WHERE id = $1',
          [createdBody.accountId],
        );
        const finalCounts = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts',
        );

        expect(initialCounts.rows[0]?.count).toBe('1');
        expect(rowCountBeforeUpdate.rows[0]?.count).toBe('1');
        expect(countsAfterFirstRead.rows[0]?.count).toBe('1');
        expect(afterUpdateCount.rows[0]?.count).toBe('1');
        expect(finalCounts.rows[0]?.count).toBe('1');
        expect(initialTimestamps.rows).toHaveLength(1);
        expect(timestampsAfterFirstRead.rows).toHaveLength(1);
        expect(timestampsAfterFirstRead.rows[0]?.created_at.toISOString()).toBe(
          initialTimestamps.rows[0]?.created_at.toISOString(),
        );
        expect(timestampsAfterFirstRead.rows[0]?.updated_at.toISOString()).toBe(
          initialTimestamps.rows[0]?.updated_at.toISOString(),
        );
        expect(persistedAccount.rows).toEqual([
          {
            id: createdBody.accountId,
            balance_minor: MAX_MINOR_UNITS,
            currency: 'USD',
          },
        ]);
        expect(lookupCount).toBe(2);
      } finally {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );
        await client.end();
        await app.close();
      }
    });

    it('returns exact zero and maximum balances for persisted rows', async () => {
      const app = await createApp({
        logger: false,
        dependencies: {
          checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
          createAccount: createAccountWithDatabase(insertAccount, pool),
          getAccountBalance: getAccountBalanceWithDatabase(
            findAccountById,
            pool,
          ),
        },
      });
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );

        const zeroAccountId = '11111111-1111-4111-8111-111111111111';
        const maxAccountId = '22222222-2222-4222-8222-222222222222';

        await client.query(
          `INSERT INTO accounts (id, balance_minor, currency)
           VALUES ($1, $2, $3), ($4, $5, $6)`,
          [zeroAccountId, '0', 'USD', maxAccountId, MAX_MINOR_UNITS, 'USD'],
        );

        const zeroResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${zeroAccountId}/balance`,
        });
        const maxResponse = await app.inject({
          method: 'GET',
          url: `/accounts/${maxAccountId}/balance`,
        });

        expect(zeroResponse.statusCode).toBe(200);
        expect(zeroResponse.json()).toEqual({
          accountId: zeroAccountId,
          balance: '0',
          currency: 'USD',
        });
        expect(maxResponse.statusCode).toBe(200);
        expect(maxResponse.json()).toEqual({
          accountId: maxAccountId,
          balance: MAX_MINOR_UNITS,
          currency: 'USD',
        });
      } finally {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );
        await client.end();
        await app.close();
      }
    });

    it('returns 404 for an unknown UUID and 400 for a malformed UUID before database access', async () => {
      let lookupCount = 0;
      const app = await createApp({
        logger: false,
        dependencies: {
          checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
          createAccount: createAccountWithDatabase(insertAccount, pool),
          getAccountBalance: getAccountBalanceWithDatabase(
            async (queryable, accountId) => {
              lookupCount += 1;
              return findAccountById(queryable, accountId);
            },
            pool,
          ),
        },
      });
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );

        const unknownResponse = await app.inject({
          method: 'GET',
          url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
        });
        const malformedResponse = await app.inject({
          method: 'GET',
          url: '/accounts/not-a-uuid/balance',
        });

        expect(unknownResponse.statusCode).toBe(404);
        const unknownBody = unknownResponse.json<{
          code: string;
          message: string;
          requestId: string;
        }>();
        expect(unknownBody.code).toBe('UNKNOWN_ACCOUNT');
        expect(unknownBody.message).toBe('Referenced account does not exist.');
        expect(typeof unknownBody.requestId).toBe('string');
        expect(unknownBody.requestId.length).toBeGreaterThan(0);
        expect(malformedResponse.statusCode).toBe(400);
        const malformedBody = malformedResponse.json<{
          code: string;
          message: string;
          requestId: string;
        }>();
        expect(malformedBody.code).toBe('MALFORMED_UUID');
        expect(malformedBody.message).toBe(
          'Account identifier must be a valid UUID.',
        );
        expect(typeof malformedBody.requestId).toBe('string');
        expect(malformedBody.requestId.length).toBeGreaterThan(0);
        expect(lookupCount).toBe(1);
      } finally {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );
        await client.end();
        await app.close();
      }
    });
  },
);
