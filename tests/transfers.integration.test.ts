import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Client } from 'pg';

import { createApp } from '../src/app.js';
import {
  findAccountById,
  listAccountTransactions,
  findTransferByIdempotencyKey,
  insertAccount,
  insertTransferIfAbsent,
  lockAccountsById,
  updateAccountBalance,
} from '../src/db/index.js';
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
const accountC = '33333333-3333-4333-8333-333333333333';
const accountD = '44444444-4444-4444-8444-444444444444';

describe.skipIf(testDatabaseUrl === undefined || testDatabaseUrl.trim() === '')(
  'section 8 transfer transaction with real PostgreSQL',
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

    it('moves money once, conserves totals, and replays an exact retry from the persisted transfer', async () => {
      const app = await createTransferTestApp(pool);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '5000'],
          [accountB, '1000'],
        ]);

        const firstResponse = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:exact-retry',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '2500',
        });
        const retryResponse = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:exact-retry',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '2500',
        });

        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        expect(firstResponse.statusCode).toBe(201);
        expect(retryResponse.statusCode).toBe(201);
        expect(retryResponse.json()).toEqual(firstResponse.json());
        expect(retryResponse.json<{ transferId: string }>().transferId).toBe(
          firstResponse.json<{ transferId: string }>().transferId,
        );
        expect(retryResponse.json<{ createdAt: string }>().createdAt).toBe(
          firstResponse.json<{ createdAt: string }>().createdAt,
        );
        expect(balances).toEqual(
          new Map([
            [accountA, '2500'],
            [accountB, '3500'],
          ]),
        );
        expect(totalBalance(balances)).toBe('6000');
        expect(transfers).toHaveLength(1);
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('converges 10 simultaneous identical requests across separate app instances to one persisted transfer', async () => {
      const apps = await Promise.all([
        createTransferTestApp(pool),
        createTransferTestApp(pool),
      ]);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '5000'],
          [accountB, '1000'],
        ]);

        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            sendTransfer(apps[index % apps.length]!, {
              idempotencyKey: 'transfer.20260808:concurrent-exact',
              sourceAccountId: accountA,
              destinationAccountId: accountB,
              amount: '2500',
            }),
          ),
        );

        const successfulBodies = responses.map((response) => {
          expect(response.statusCode).toBe(201);
          return response.json<{ transferId: string; createdAt: string }>();
        });
        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        expect(
          new Set(successfulBodies.map((body) => body.transferId)).size,
        ).toBe(1);
        expect(
          new Set(successfulBodies.map((body) => body.createdAt)).size,
        ).toBe(1);
        expect(balances).toEqual(
          new Map([
            [accountA, '2500'],
            [accountB, '3500'],
          ]),
        );
        expect(totalBalance(balances)).toBe('6000');
        expect(transfers).toHaveLength(1);
      } finally {
        await resetLedger(client);
        await client.end();
        await Promise.all(apps.map(async (app) => app.close()));
      }
    });

    it('returns 409 for conflicting idempotency-key reuse by amount, source, and destination without moving money again', async () => {
      const app = await createTransferTestApp(pool);
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

        const firstResponse = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:conflict-shape',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });
        expect(firstResponse.statusCode).toBe(201);
        const balancesAfterFirst = await fetchBalancesById(client);

        const amountConflict = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:conflict-shape',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1500',
        });
        const sourceConflict = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:conflict-shape',
          sourceAccountId: accountC,
          destinationAccountId: accountB,
          amount: '1000',
        });
        const destinationConflict = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:conflict-shape',
          sourceAccountId: accountA,
          destinationAccountId: accountD,
          amount: '1000',
        });

        const balancesAfterConflicts = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        for (const response of [
          amountConflict,
          sourceConflict,
          destinationConflict,
        ]) {
          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject({
            code: 'IDEMPOTENCY_CONFLICT',
          });
        }

        expect(balancesAfterConflicts).toEqual(balancesAfterFirst);
        expect(transfers).toHaveLength(1);
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('rejects concurrent overspending so exactly one 8000 transfer succeeds and one fails with insufficient funds', async () => {
      const apps = await Promise.all([
        createTransferTestApp(pool),
        createTransferTestApp(pool),
      ]);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '10000'],
          [accountB, '0'],
          [accountC, '0'],
        ]);

        const [firstResponse, secondResponse] = await Promise.all([
          sendTransfer(apps[0], {
            idempotencyKey: 'transfer.20260808:overspend-1',
            sourceAccountId: accountA,
            destinationAccountId: accountB,
            amount: '8000',
          }),
          sendTransfer(apps[1], {
            idempotencyKey: 'transfer.20260808:overspend-2',
            sourceAccountId: accountA,
            destinationAccountId: accountC,
            amount: '8000',
          }),
        ]);

        const statusCodes = [
          firstResponse.statusCode,
          secondResponse.statusCode,
        ].sort((left, right) => left - right);
        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        expect(statusCodes).toEqual([201, 422]);
        expect(
          [firstResponse, secondResponse]
            .find((response) => response.statusCode === 422)
            ?.json(),
        ).toMatchObject({
          code: 'INSUFFICIENT_FUNDS',
        });
        expect(balances.get(accountA)).toBe('2000');
        expect(
          [balances.get(accountB), balances.get(accountC)].filter(
            (value) => value === '8000',
          ),
        ).toHaveLength(1);
        expect(
          [balances.get(accountB), balances.get(accountC)].filter(
            (value) => value === '0',
          ),
        ).toHaveLength(1);
        expect(totalBalance(balances)).toBe('10000');
        expect(transfers).toHaveLength(1);
      } finally {
        await resetLedger(client);
        await client.end();
        await Promise.all(apps.map(async (app) => app.close()));
      }
    });

    it('applies several collectively affordable concurrent transfers exactly once each', async () => {
      const apps = await Promise.all([
        createTransferTestApp(pool),
        createTransferTestApp(pool),
        createTransferTestApp(pool),
      ]);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '12000'],
          [accountB, '1000'],
          [accountC, '2000'],
          [accountD, '3000'],
        ]);

        const responses = await Promise.all([
          sendTransfer(apps[0], {
            idempotencyKey: 'transfer.20260808:affordable-1',
            sourceAccountId: accountA,
            destinationAccountId: accountB,
            amount: '1000',
          }),
          sendTransfer(apps[1], {
            idempotencyKey: 'transfer.20260808:affordable-2',
            sourceAccountId: accountA,
            destinationAccountId: accountC,
            amount: '2000',
          }),
          sendTransfer(apps[2], {
            idempotencyKey: 'transfer.20260808:affordable-3',
            sourceAccountId: accountA,
            destinationAccountId: accountD,
            amount: '3000',
          }),
        ]);

        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        for (const response of responses) {
          expect(response.statusCode).toBe(201);
        }

        expect(balances).toEqual(
          new Map([
            [accountA, '6000'],
            [accountB, '2000'],
            [accountC, '4000'],
            [accountD, '6000'],
          ]),
        );
        expect(totalBalance(balances)).toBe('18000');
        expect(transfers).toHaveLength(3);
      } finally {
        await resetLedger(client);
        await client.end();
        await Promise.all(apps.map(async (app) => app.close()));
      }
    });

    it('keeps balances correct under repeated opposite-direction concurrent transfers', async () => {
      const apps = await Promise.all([
        createTransferTestApp(pool),
        createTransferTestApp(pool),
      ]);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '10000'],
          [accountB, '10000'],
        ]);

        for (let iteration = 0; iteration < 8; iteration += 1) {
          const [forward, reverse] = await Promise.all([
            sendTransfer(apps[0], {
              idempotencyKey: `transfer.20260808:opposite-forward-${iteration}`,
              sourceAccountId: accountA,
              destinationAccountId: accountB,
              amount: '1000',
            }),
            sendTransfer(apps[1], {
              idempotencyKey: `transfer.20260808:opposite-reverse-${iteration}`,
              sourceAccountId: accountB,
              destinationAccountId: accountA,
              amount: '1000',
            }),
          ]);

          expect(forward.statusCode).toBe(201);
          expect(reverse.statusCode).toBe(201);
        }

        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        expect(balances).toEqual(
          new Map([
            [accountA, '10000'],
            [accountB, '10000'],
          ]),
        );
        expect(totalBalance(balances)).toBe('20000');
        expect(transfers).toHaveLength(16);
      } finally {
        await resetLedger(client);
        await client.end();
        await Promise.all(apps.map(async (app) => app.close()));
      }
    });

    it('returns 422 BALANCE_LIMIT_EXCEEDED and rolls back the full transaction when the destination is already at BIGINT max', async () => {
      const app = await createTransferTestApp(pool);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '1000'],
          [accountB, '9223372036854775807'],
        ]);

        const response = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:overflow',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1',
        });

        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);

        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: 'BALANCE_LIMIT_EXCEEDED',
        });
        expect(balances).toEqual(
          new Map([
            [accountA, '1000'],
            [accountB, '9223372036854775807'],
          ]),
        );
        expect(transfers).toHaveLength(0);
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('rolls back the source debit, transfer row, and idempotency claim when a controlled post-debit failure occurs', async () => {
      const app = await createTransferTestApp(pool, {
        failAfterSourceDebit: true,
      });
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '5000'],
          [accountB, '1000'],
        ]);

        const response = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:post-debit-failure',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });

        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);
        const persistedClaim = await fetchTransferByIdempotencyKey(
          client,
          'transfer.20260808:post-debit-failure',
        );

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({
          code: 'INTERNAL_ERROR',
        });
        expect(response.body).not.toContain('Controlled post-debit failure');
        expect(response.body).not.toContain('/Users/macbook');
        expect(balances).toEqual(
          new Map([
            [accountA, '5000'],
            [accountB, '1000'],
          ]),
        );
        expect(transfers).toHaveLength(0);
        expect(persistedClaim).toBeNull();

        const retryApp = await createTransferTestApp(pool);

        try {
          const retryResponse = await sendTransfer(retryApp, {
            idempotencyKey: 'transfer.20260808:post-debit-failure',
            sourceAccountId: accountA,
            destinationAccountId: accountB,
            amount: '1000',
          });

          expect(retryResponse.statusCode).toBe(201);
          expect(await fetchBalancesById(client)).toEqual(
            new Map([
              [accountA, '4000'],
              [accountB, '2000'],
            ]),
          );
          expect(await fetchTransfers(client)).toHaveLength(1);
        } finally {
          await retryApp.close();
        }
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('returns 404 for missing source and destination accounts independently without persisting a transfer', async () => {
      const app = await createTransferTestApp(pool);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      try {
        await resetLedger(client);
        await seedAccounts(client, [[accountA, '5000']]);

        const missingDestination = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:missing-destination',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });

        await resetLedger(client);
        await seedAccounts(client, [[accountB, '5000']]);

        const missingSource = await sendTransfer(app, {
          idempotencyKey: 'transfer.20260808:missing-source',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '1000',
        });

        const transfers = await fetchTransfers(client);

        expect(missingDestination.statusCode).toBe(404);
        expect(missingDestination.json()).toMatchObject({
          code: 'UNKNOWN_ACCOUNT',
        });
        expect(missingSource.statusCode).toBe(404);
        expect(missingSource.json()).toMatchObject({
          code: 'UNKNOWN_ACCOUNT',
        });
        expect(transfers).toHaveLength(0);
      } finally {
        await resetLedger(client);
        await client.end();
        await app.close();
      }
    });

    it('keeps shared-account balances non-negative and total money conserved under a mixed concurrent stress workload', async () => {
      const apps = await Promise.all([
        createTransferTestApp(pool),
        createTransferTestApp(pool),
        createTransferTestApp(pool),
        createTransferTestApp(pool),
      ]);
      const client = createClient(getSchemaTestDatabaseUrl());
      await client.connect();

      const workload = [
        {
          idempotencyKey: 'transfer.20260808:stress-a-to-b-1',
          sourceAccountId: accountA,
          destinationAccountId: accountB,
          amount: '4000',
        },
        {
          idempotencyKey: 'transfer.20260808:stress-a-to-c-too-large',
          sourceAccountId: accountA,
          destinationAccountId: accountC,
          amount: '7000',
        },
        {
          idempotencyKey: 'transfer.20260808:stress-b-to-d',
          sourceAccountId: accountB,
          destinationAccountId: accountD,
          amount: '2500',
        },
        {
          idempotencyKey: 'transfer.20260808:stress-d-to-a',
          sourceAccountId: accountD,
          destinationAccountId: accountA,
          amount: '500',
        },
        {
          idempotencyKey: 'transfer.20260808:stress-c-to-b-too-large',
          sourceAccountId: accountC,
          destinationAccountId: accountB,
          amount: '6500',
        },
        {
          idempotencyKey: 'transfer.20260808:stress-b-to-c',
          sourceAccountId: accountB,
          destinationAccountId: accountC,
          amount: '1000',
        },
      ] as const;

      try {
        await resetLedger(client);
        await seedAccounts(client, [
          [accountA, '6000'],
          [accountB, '3000'],
          [accountC, '2000'],
          [accountD, '1000'],
        ]);

        const responses = await Promise.all(
          workload.map((transfer, index) =>
            sendTransfer(apps[index % apps.length]!, transfer),
          ),
        );

        const successKeyCandidates: Array<string | null> = responses.map(
          (response, index) =>
            response.statusCode === 201
              ? (workload[index]?.idempotencyKey ?? null)
              : null,
        );
        const successKeys = new Set(
          successKeyCandidates.filter(
            (value): value is string => value !== null,
          ),
        );
        const failedKeys = workload
          .map((transfer) => transfer.idempotencyKey)
          .filter((idempotencyKey) => !successKeys.has(idempotencyKey));
        const balances = await fetchBalancesById(client);
        const transfers = await fetchTransfers(client);
        const transfersByKey = new Map(
          transfers.map((transfer) => [transfer.idempotency_key, transfer]),
        );

        for (const response of responses) {
          expect([201, 422]).toContain(response.statusCode);
        }

        for (const failedResponse of responses.filter(
          (response) => response.statusCode === 422,
        )) {
          expect(failedResponse.json()).toMatchObject({
            code: 'INSUFFICIENT_FUNDS',
          });
        }

        expect(failedKeys).toEqual(
          expect.arrayContaining([
            'transfer.20260808:stress-a-to-c-too-large',
            'transfer.20260808:stress-c-to-b-too-large',
          ]),
        );

        expect(
          [...balances.values()].every((balance) => BigInt(balance) >= 0n),
        ).toBe(true);
        expect(totalBalance(balances)).toBe('12000');
        expect(transfers).toHaveLength(successKeys.size);

        for (const transfer of workload.filter((entry) =>
          successKeys.has(entry.idempotencyKey),
        )) {
          expect(transfersByKey.get(transfer.idempotencyKey)).toMatchObject({
            idempotency_key: transfer.idempotencyKey,
            source_account_id: transfer.sourceAccountId,
            destination_account_id: transfer.destinationAccountId,
            amount_minor: transfer.amount,
          });
        }

        for (const idempotencyKey of failedKeys) {
          expect(transfersByKey.has(idempotencyKey)).toBe(false);
        }
      } finally {
        await resetLedger(client);
        await client.end();
        await Promise.all(apps.map(async (app) => app.close()));
      }
    });
  },
);

type TransferTestAppOptions = {
  failAfterSourceDebit?: boolean;
};

const createTransferTestApp = async (
  pool: Pool,
  options: TransferTestAppOptions = {},
) =>
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
        lockAccountsById,
        updateAccountBalance: async (client, accountId, nextBalance) => {
          await updateAccountBalance(client, accountId, nextBalance);

          if (options.failAfterSourceDebit === true && accountId === accountA) {
            throw new Error('Controlled post-debit failure.');
          }
        },
      }),
    },
  });

const sendTransfer = (
  app: Awaited<ReturnType<typeof createTransferTestApp>>,
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

const totalBalance = (balances: Map<string, string>): string =>
  [...balances.values()]
    .reduce((sum, balance) => sum + BigInt(balance), 0n)
    .toString();

const fetchTransfers = async (
  client: Client,
): Promise<
  Array<{
    id: string;
    idempotency_key: string;
    source_account_id: string;
    destination_account_id: string;
    amount_minor: string;
    created_at: Date;
  }>
> => {
  const result = await client.query<{
    id: string;
    idempotency_key: string;
    source_account_id: string;
    destination_account_id: string;
    amount_minor: string;
    created_at: Date;
  }>(
    `SELECT
       id,
       idempotency_key,
       source_account_id,
       destination_account_id,
       amount_minor,
       created_at
     FROM transfers
     ORDER BY created_at ASC, id ASC`,
  );

  return result.rows;
};

const fetchTransferByIdempotencyKey = async (
  client: Client,
  idempotencyKey: string,
): Promise<{
  id: string;
  idempotency_key: string;
} | null> => {
  const result = await client.query<{
    id: string;
    idempotency_key: string;
  }>(
    `SELECT id, idempotency_key
     FROM transfers
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );

  return result.rows[0] ?? null;
};

const resetLedger = async (client: Client): Promise<void> => {
  await client.query('TRUNCATE TABLE transfers, accounts RESTART IDENTITY');
};
