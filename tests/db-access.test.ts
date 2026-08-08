import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseError, Pool } from 'pg';
import type { QueryResult } from 'pg';

import {
  classifyDatabaseError,
  executeInTransaction,
  findAccountById,
  findTransferByIdempotencyKey,
  insertAccount,
  insertTransfer,
  type TransactionPool,
} from '../src/db/index.js';
import {
  createClient,
  getSchemaTestDatabaseUrl,
  quoteIdentifier,
} from './helpers/postgres.js';
import { runMigrations } from '../src/scripts/migrate.js';

const migrationDirectory = 'src/db/migrations';
const adminDatabaseUrl = process.env['SCHEMA_TEST_DATABASE_URL'];

const createEmptyQueryResult = (): QueryResult<Record<string, never>> => ({
  command: 'SELECT',
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
});

const createDatabaseError = (
  code: string,
  constraint?: string,
): DatabaseError => {
  const error = new DatabaseError('database error', 0, 'error');
  error.code = code;

  if (constraint !== undefined) {
    error.constraint = constraint;
  }

  return error;
};

describe('section 5 pure database helpers', () => {
  it('classifies every known PostgreSQL SQLSTATE without parsing messages', () => {
    const scenarios = [
      {
        error: createDatabaseError('23505', 'transfers_idempotency_key_unique'),
        expected: {
          kind: 'unique_violation',
          sqlState: '23505',
          constraint: 'transfers_idempotency_key_unique',
        },
      },
      {
        error: createDatabaseError('23503', 'transfers_source_account_id_fkey'),
        expected: {
          kind: 'foreign_key_violation',
          sqlState: '23503',
          constraint: 'transfers_source_account_id_fkey',
        },
      },
      {
        error: createDatabaseError('23514', 'transfers_distinct_accounts'),
        expected: {
          kind: 'check_violation',
          sqlState: '23514',
          constraint: 'transfers_distinct_accounts',
        },
      },
      {
        error: createDatabaseError('22P02'),
        expected: {
          kind: 'invalid_text_representation',
          sqlState: '22P02',
          constraint: null,
        },
      },
      {
        error: createDatabaseError('22003'),
        expected: {
          kind: 'numeric_value_out_of_range',
          sqlState: '22003',
          constraint: null,
        },
      },
      {
        error: createDatabaseError('40P01'),
        expected: {
          kind: 'deadlock_detected',
          sqlState: '40P01',
          constraint: null,
        },
      },
      {
        error: createDatabaseError('40001'),
        expected: {
          kind: 'serialization_failure',
          sqlState: '40001',
          constraint: null,
        },
      },
      {
        error: createDatabaseError('55P03'),
        expected: {
          kind: 'lock_not_available',
          sqlState: '55P03',
          constraint: null,
        },
      },
      {
        error: createDatabaseError('57014'),
        expected: {
          kind: 'query_canceled',
          sqlState: '57014',
          constraint: null,
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      expect(classifyDatabaseError(scenario.error)).toEqual({
        ...scenario.expected,
        cause: scenario.error,
      });
    }
  });

  it('returns null for unknown database failures and non-PostgreSQL failures', () => {
    expect(classifyDatabaseError(createDatabaseError('99999'))).toBeNull();
    expect(classifyDatabaseError(new Error('boom'))).toBeNull();
  });

  it('rejects invalid monetary input before sending a query', async () => {
    const query = vi.fn();

    await expect(
      insertAccount(
        { query },
        {
          id: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
          balance: '9223372036854775808',
          currency: 'USD',
        },
      ),
    ).rejects.toThrow(/invalid nonNegative minor-unit amount/i);

    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid database row values during mapping', async () => {
    await expect(
      findAccountById(
        {
          query: () =>
            Promise.resolve({
              command: 'SELECT',
              rowCount: 1,
              oid: 0,
              fields: [],
              rows: [
                {
                  id: 'not-a-uuid',
                  balance_minor: '10',
                  currency: 'USD',
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              ],
            }),
        },
        '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      ),
    ).rejects.toThrow(/valid account UUID/i);
  });

  it('rejects invalid database timestamps during mapping', async () => {
    await expect(
      findTransferByIdempotencyKey(
        {
          query: () =>
            Promise.resolve({
              command: 'SELECT',
              rowCount: 1,
              oid: 0,
              fields: [],
              rows: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  idempotency_key: 'transfer.20260808:acct-001',
                  request_fingerprint:
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  source_account_id: '11111111-1111-4111-8111-111111111111',
                  destination_account_id:
                    '22222222-2222-4222-8222-222222222222',
                  amount_minor: '10',
                  currency: 'USD',
                  status: 'completed',
                  created_at: 'not-a-date',
                },
              ],
            }),
        },
        'transfer.20260808:acct-001',
      ),
    ).rejects.toThrow(/timestamp must be a valid Date/i);
  });

  it('commits on success and releases the client', async () => {
    const release = vi.fn();
    const query = vi.fn(() => Promise.resolve(createEmptyQueryResult()));
    const connect = vi.fn(() =>
      Promise.resolve({
        query,
        release,
      }),
    );

    const result = await executeInTransaction(
      { connect } satisfies TransactionPool,
      () => 'ok',
    );

    expect(result).toBe('ok');
    expect(query.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'BEGIN',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses the same checked-out client for begin, callback queries, and commit', async () => {
    const release = vi.fn();
    const query = vi.fn(() => Promise.resolve(createEmptyQueryResult()));
    const client = { query, release };
    const connect = vi.fn(() => Promise.resolve(client));

    await executeInTransaction(
      { connect } satisfies TransactionPool,
      async (transactionClient) => {
        await transactionClient.query('SELECT 1');
      },
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'BEGIN',
      'SELECT 1',
      'COMMIT',
    ]);
  });

  it('rolls back on callback failure and releases the client', async () => {
    const release = vi.fn();
    const query = vi.fn(() => Promise.resolve(createEmptyQueryResult()));

    await expect(
      executeInTransaction(
        {
          connect: () =>
            Promise.resolve({
              query,
              release,
            }),
        } satisfies TransactionPool,
        () => {
          throw new Error('primary failure');
        },
      ),
    ).rejects.toThrow(/primary failure/i);

    expect(query.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'BEGIN',
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves the original error when rollback also fails', async () => {
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce(createEmptyQueryResult())
      .mockRejectedValueOnce(new Error('rollback failure'));

    const error = await executeInTransaction(
      {
        connect: () =>
          Promise.resolve({
            query,
            release,
          }),
      } satisfies TransactionPool,
      () => {
        throw new Error('primary failure');
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('TransactionRollbackError');
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe('primary failure');
    expect(error).toBeInstanceOf(Object);
    expect(
      'rollbackError' in (error as Record<string, unknown>) &&
        (error as Record<string, unknown>)['rollbackError'],
    ).toBeInstanceOf(Error);
    expect(
      ((error as Record<string, unknown>)['rollbackError'] as Error).message,
    ).toBe('rollback failure');

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(
  adminDatabaseUrl === undefined || adminDatabaseUrl.trim() === '',
)('section 5 database access integration', () => {
  const getDatabaseUrl = (): string => getSchemaTestDatabaseUrl();

  beforeAll(async () => {
    await resetDedicatedTestDatabase();
    await runMigrations({
      connectionString: getDatabaseUrl(),
      migrationsDirectory: migrationDirectory,
    });
  });

  afterAll(async () => {
    await resetDedicatedTestDatabase();
  });

  it('inserts and finds accounts, including max BIGINT balances', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      const inserted = await insertAccount(pool, {
        id: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '9223372036854775807',
        currency: 'USD',
      });

      const found = await findAccountById(
        pool,
        '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      );

      expect(inserted.balance).toBe('9223372036854775807');
      expect(inserted.currency).toBe('USD');
      expect(inserted.createdAt).toMatch(/Z$/);
      expect(inserted.updatedAt).toMatch(/Z$/);
      expect(found).toEqual(inserted);
    } finally {
      await pool.end();
    }
  });

  it('returns null for a missing account', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      await expect(
        findAccountById(pool, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ).resolves.toBeNull();
    } finally {
      await pool.end();
    }
  });

  it('inserts and finds completed transfers by idempotency key', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      await insertAccount(pool, {
        id: '11111111-1111-4111-8111-111111111111',
        balance: '1000',
        currency: 'USD',
      });
      await insertAccount(pool, {
        id: '22222222-2222-4222-8222-222222222222',
        balance: '2000',
        currency: 'USD',
      });

      const inserted = await insertTransfer(pool, {
        id: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'transfer.20260808:acct-001',
        requestFingerprint:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        destinationAccountId: '22222222-2222-4222-8222-222222222222',
        amount: '9223372036854775807',
        currency: 'USD',
        status: 'completed',
      });

      const found = await findTransferByIdempotencyKey(
        pool,
        'transfer.20260808:acct-001',
      );

      expect(inserted.amount).toBe('9223372036854775807');
      expect(inserted.status).toBe('completed');
      expect(found).toEqual(inserted);
    } finally {
      await pool.end();
    }
  });

  it('returns null for a missing idempotency key', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      await expect(
        findTransferByIdempotencyKey(pool, 'transfer.20260808:acct-999'),
      ).resolves.toBeNull();
    } finally {
      await pool.end();
    }
  });

  it('treats SQL-like parameter values as data, not query text', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      const inserted = await insertAccount(pool, {
        id: '44444444-4444-4444-8444-444444444444',
        balance: '1',
        currency: 'USD',
      });
      expect(inserted.accountId).toBe('44444444-4444-4444-8444-444444444444');

      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'accounts'
         ) AS exists`,
      );
      expect(result.rows[0]?.exists).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('classifies duplicate idempotency keys, foreign-key failures, and named check constraints', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      await insertAccount(pool, {
        id: '55555555-5555-4555-8555-555555555555',
        balance: '50',
        currency: 'USD',
      });
      await insertAccount(pool, {
        id: '66666666-6666-4666-8666-666666666666',
        balance: '50',
        currency: 'USD',
      });

      await insertTransfer(pool, {
        id: '77777777-7777-4777-8777-777777777777',
        idempotencyKey: 'transfer.20260808:acct-dup',
        requestFingerprint:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sourceAccountId: '55555555-5555-4555-8555-555555555555',
        destinationAccountId: '66666666-6666-4666-8666-666666666666',
        amount: '1',
        currency: 'USD',
        status: 'completed',
      });

      await expect(
        insertTransfer(pool, {
          id: '88888888-8888-4888-8888-888888888888',
          idempotencyKey: 'transfer.20260808:acct-dup',
          requestFingerprint:
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          sourceAccountId: '55555555-5555-4555-8555-555555555555',
          destinationAccountId: '66666666-6666-4666-8666-666666666666',
          amount: '2',
          currency: 'USD',
          status: 'completed',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        const classified = classifyDatabaseError(error);
        return (
          classified?.kind === 'unique_violation' &&
          classified.constraint === 'transfers_idempotency_key_unique'
        );
      });

      await expect(
        insertTransfer(pool, {
          id: '99999999-9999-4999-8999-999999999999',
          idempotencyKey: 'transfer.20260808:acct-missing',
          requestFingerprint:
            'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          destinationAccountId: '66666666-6666-4666-8666-666666666666',
          amount: '1',
          currency: 'USD',
          status: 'completed',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        const classified = classifyDatabaseError(error);
        return (
          classified?.kind === 'foreign_key_violation' &&
          classified.constraint === 'transfers_source_account_id_fkey'
        );
      });

      await expect(
        pool.query(
          `INSERT INTO transfers (
             id,
             idempotency_key,
             request_fingerprint,
             source_account_id,
             destination_account_id,
             amount_minor,
             currency,
             status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
            'transfer.20260808:acct-check',
            'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            '55555555-5555-4555-8555-555555555555',
            '55555555-5555-4555-8555-555555555555',
            '1',
            'USD',
            'completed',
          ],
        ),
      ).rejects.toSatisfy((error: unknown) => {
        const classified = classifyDatabaseError(error);
        return (
          classified?.kind === 'check_violation' &&
          classified.constraint === 'transfers_distinct_accounts'
        );
      });
    } finally {
      await pool.end();
    }
  });

  it('uses the provided transaction client for repository work and rolls back on failure', async () => {
    const pool = new Pool({ connectionString: getDatabaseUrl() });

    try {
      await expect(
        executeInTransaction(pool, async (client) => {
          await insertAccount(client, {
            id: 'abababab-abab-4bab-8bab-abababababab',
            balance: '10',
            currency: 'USD',
          });

          throw new Error('force rollback');
        }),
      ).rejects.toThrow(/force rollback/i);

      await expect(
        findAccountById(pool, 'abababab-abab-4bab-8bab-abababababab'),
      ).resolves.toBeNull();
    } finally {
      await pool.end();
    }
  });
});

async function resetDedicatedTestDatabase(): Promise<void> {
  const client = createClient(getSchemaTestDatabaseUrl());
  await client.connect();

  try {
    await client.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier('public')} CASCADE`,
    );
    await client.query(`CREATE SCHEMA ${quoteIdentifier('public')}`);
    await client.query(
      `GRANT ALL ON SCHEMA ${quoteIdentifier('public')} TO CURRENT_USER`,
    );
  } finally {
    await client.end();
  }
}
