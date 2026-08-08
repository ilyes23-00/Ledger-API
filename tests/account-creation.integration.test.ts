import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createApp } from '../src/app.js';
import {
  findAccountById,
  insertAccount,
  listAccountTransactions,
} from '../src/db/index.js';
import { runMigrations } from '../src/scripts/migrate.js';
import { createAccountWithDatabase } from '../src/services/create-account.js';
import { getAccountBalanceWithDatabase } from '../src/services/get-account-balance.js';
import { getAccountTransactionsWithDatabase } from '../src/services/get-account-transactions.js';
import { createClient, getSchemaTestDatabaseUrl } from './helpers/postgres.js';
import type { CreateAccountResult } from '../src/services/create-account.js';

const migrationDirectory = path.resolve('src/db/migrations');
const testDatabaseUrl = process.env['SCHEMA_TEST_DATABASE_URL'];

describe.skipIf(testDatabaseUrl === undefined || testDatabaseUrl.trim() === '')(
  'section 6 account creation with real PostgreSQL',
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

    it('persists exactly one account from a valid HTTP request', async () => {
      const app = await createApp({
        logger: false,
        dependencies: {
          checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
          createAccount: createAccountWithDatabase(insertAccount, pool),
          getAccountBalance: getAccountBalanceWithDatabase(
            findAccountById,
            pool,
          ),
          getAccountTransactions: getAccountTransactionsWithDatabase(
            findAccountById,
            listAccountTransactions,
            pool,
          ),
        },
      });
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        const beforeRows = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts',
        );

        const response = await app.inject({
          method: 'POST',
          url: '/accounts',
          payload: {
            currency: 'USD',
            initialBalance: '2500',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json<CreateAccountResult>();

        const persistedAccount = await client.query<{
          id: string;
          balance_minor: string;
          currency: string;
          created_at: Date;
        }>(
          `SELECT id, balance_minor, currency, created_at
         FROM accounts
         WHERE id = $1`,
          [body.accountId],
        );

        const afterRows = await client.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM accounts',
        );

        expect(
          Number(afterRows.rows[0]?.count) - Number(beforeRows.rows[0]?.count),
        ).toBe(1);
        expect(persistedAccount.rows).toHaveLength(1);
        expect(body.accountId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(persistedAccount.rows[0]?.id).toBe(body.accountId);
        expect(persistedAccount.rows[0]?.balance_minor).toBe('2500');
        expect(body.balance).toBe('2500');
        expect(persistedAccount.rows[0]?.currency).toBe('USD');
        expect(body.currency).toBe('USD');
        expect(persistedAccount.rows[0]?.created_at.toISOString()).toBe(
          body.createdAt,
        );
      } finally {
        await client.query(
          'TRUNCATE TABLE transfers, accounts RESTART IDENTITY',
        );
        await client.end();
        await app.close();
      }
    });

    it('persists zero and maximum balances exactly, and invalid requests create no row', async () => {
      const app = await createApp({
        logger: false,
        dependencies: {
          checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
          createAccount: createAccountWithDatabase(insertAccount, pool),
          getAccountBalance: getAccountBalanceWithDatabase(
            findAccountById,
            pool,
          ),
          getAccountTransactions: getAccountTransactionsWithDatabase(
            findAccountById,
            listAccountTransactions,
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

        const zeroResponse = await app.inject({
          method: 'POST',
          url: '/accounts',
          payload: {
            currency: 'USD',
            initialBalance: '0',
          },
        });
        const maxResponse = await app.inject({
          method: 'POST',
          url: '/accounts',
          payload: {
            currency: 'USD',
            initialBalance: '9223372036854775807',
          },
        });
        const invalidResponse = await app.inject({
          method: 'POST',
          url: '/accounts',
          payload: {
            currency: 'USD',
            initialBalance: '9223372036854775808',
          },
        });
        const accounts = await client.query<{
          balance_minor: string;
          currency: string;
        }>(
          `SELECT balance_minor, currency
         FROM accounts
         ORDER BY created_at ASC, id ASC`,
        );

        expect(zeroResponse.statusCode).toBe(201);
        expect(maxResponse.statusCode).toBe(201);
        expect(invalidResponse.statusCode).toBe(400);
        expect(accounts.rows).toEqual([
          {
            balance_minor: '0',
            currency: 'USD',
          },
          {
            balance_minor: '9223372036854775807',
            currency: 'USD',
          },
        ]);
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
