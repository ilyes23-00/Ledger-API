import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  runMigrations,
  type AppliedMigrationRecord,
} from '../src/scripts/migrate.js';
import {
  createClient,
  getSchemaTestDatabaseUrl,
  parseSchemaTestDatabaseName,
  quoteIdentifier,
} from './helpers/postgres.js';

type ColumnRecord = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
};

type ConstraintRecord = {
  constraint_name: string;
  constraint_type: string;
};

type ForeignKeyRecord = {
  constraint_name: string;
  delete_rule: string;
};

type IndexRecord = {
  indexname: string;
  indexdef: string;
};

const migrationDirectory = path.resolve('src/db/migrations');
const adminDatabaseUrl = process.env['SCHEMA_TEST_DATABASE_URL'];

describe.skipIf(
  adminDatabaseUrl === undefined || adminDatabaseUrl.trim() === '',
)('section 4 PostgreSQL schema and migrations', () => {
  const getDatabaseUrl = (): string => getSchemaTestDatabaseUrl();

  beforeAll(async () => {
    await resetDedicatedTestDatabase();
  });

  afterAll(async () => {
    await resetDedicatedTestDatabase();
  });

  it('applies migrations on an empty database and reruns idempotently', async () => {
    const firstRun = await runMigrations({
      connectionString: getDatabaseUrl(),
      migrationsDirectory: migrationDirectory,
    });
    const secondRun = await runMigrations({
      connectionString: getDatabaseUrl(),
      migrationsDirectory: migrationDirectory,
    });

    expect(firstRun.appliedMigrations).toEqual(['0001_initial_schema.sql']);
    expect(secondRun.appliedMigrations).toEqual([]);
    expect(secondRun.skippedMigrations).toEqual(['0001_initial_schema.sql']);
  });

  it('creates the required tables, columns, constraints, foreign keys, indexes, and migration history', async () => {
    const client = createClient(getDatabaseUrl());
    await client.connect();

    try {
      const { rows: accountColumns } = await client.query<ColumnRecord>(
        `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'accounts'
         ORDER BY ordinal_position`,
      );
      expect(accountColumns).toEqual([
        {
          column_name: 'id',
          data_type: 'uuid',
          udt_name: 'uuid',
          is_nullable: 'NO',
        },
        {
          column_name: 'balance_minor',
          data_type: 'bigint',
          udt_name: 'int8',
          is_nullable: 'NO',
        },
        {
          column_name: 'currency',
          data_type: 'text',
          udt_name: 'text',
          is_nullable: 'NO',
        },
        {
          column_name: 'created_at',
          data_type: 'timestamp with time zone',
          udt_name: 'timestamptz',
          is_nullable: 'NO',
        },
        {
          column_name: 'updated_at',
          data_type: 'timestamp with time zone',
          udt_name: 'timestamptz',
          is_nullable: 'NO',
        },
      ]);

      const { rows: transferColumns } = await client.query<ColumnRecord>(
        `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transfers'
         ORDER BY ordinal_position`,
      );
      expect(transferColumns.map((column) => column.column_name)).toEqual([
        'id',
        'idempotency_key',
        'request_fingerprint',
        'source_account_id',
        'destination_account_id',
        'amount_minor',
        'currency',
        'status',
        'created_at',
      ]);

      const { rows: constraints } = await client.query<ConstraintRecord>(
        `SELECT constraint_name, constraint_type
         FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name IN ('accounts', 'transfers')
         ORDER BY table_name, constraint_name`,
      );
      expect(constraints).toEqual(
        expect.arrayContaining([
          {
            constraint_name: 'accounts_balance_minor_non_negative',
            constraint_type: 'CHECK',
          },
          {
            constraint_name: 'accounts_currency_usd_only',
            constraint_type: 'CHECK',
          },
          {
            constraint_name: 'transfers_amount_minor_positive',
            constraint_type: 'CHECK',
          },
          {
            constraint_name: 'transfers_currency_usd_only',
            constraint_type: 'CHECK',
          },
          {
            constraint_name: 'transfers_destination_account_id_fkey',
            constraint_type: 'FOREIGN KEY',
          },
          {
            constraint_name: 'transfers_distinct_accounts',
            constraint_type: 'CHECK',
          },
          {
            constraint_name: 'transfers_idempotency_key_unique',
            constraint_type: 'UNIQUE',
          },
          {
            constraint_name: 'transfers_request_fingerprint_sha256_format',
            constraint_type: 'CHECK',
          },
          {
            constraint_name: 'transfers_source_account_id_fkey',
            constraint_type: 'FOREIGN KEY',
          },
          {
            constraint_name: 'transfers_status_completed_only',
            constraint_type: 'CHECK',
          },
        ]),
      );

      const { rows: foreignKeys } = await client.query<ForeignKeyRecord>(
        `SELECT rc.constraint_name, rc.delete_rule
         FROM information_schema.referential_constraints AS rc
         WHERE rc.constraint_schema = 'public'
         ORDER BY rc.constraint_name`,
      );
      expect(foreignKeys).toEqual([
        {
          constraint_name: 'transfers_destination_account_id_fkey',
          delete_rule: 'RESTRICT',
        },
        {
          constraint_name: 'transfers_source_account_id_fkey',
          delete_rule: 'RESTRICT',
        },
      ]);

      const { rows: indexes } = await client.query<IndexRecord>(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'transfers'
         ORDER BY indexname`,
      );
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            indexname: 'transfers_destination_account_history_idx',
          }),
          expect.objectContaining({
            indexname: 'transfers_idempotency_key_unique',
          }),
          expect.objectContaining({
            indexname: 'transfers_pkey',
          }),
          expect.objectContaining({
            indexname: 'transfers_source_account_history_idx',
          }),
        ]),
      );

      const { rows: appliedMigrations } =
        await client.query<AppliedMigrationRecord>(
          `SELECT id, checksum
         FROM schema_migrations
         ORDER BY id`,
        );
      expect(appliedMigrations).toHaveLength(1);
      expect(appliedMigrations[0]?.id).toBe('0001_initial_schema.sql');
      expect(appliedMigrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await client.end();
    }
  });

  it('enforces required constraints and accepts representative valid rows', async () => {
    const client = createClient(getDatabaseUrl());
    await client.connect();

    try {
      await client.query(
        `INSERT INTO accounts (id, balance_minor, currency)
         VALUES
           ('11111111-1111-4111-8111-111111111111', 1000, 'USD'),
           ('22222222-2222-4222-8222-222222222222', 500, 'USD')`,
      );

      await client.query(
        `INSERT INTO transfers (
           id,
           idempotency_key,
           request_fingerprint,
           source_account_id,
           destination_account_id,
           amount_minor,
           currency,
           status
         ) VALUES (
           '33333333-3333-4333-8333-333333333333',
           'transfer.20260808:acct-001',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           250,
           'USD',
           'completed'
         )`,
      );

      await expectConstraintFailure(
        client,
        `INSERT INTO accounts (id, balance_minor, currency)
         VALUES ('44444444-4444-4444-8444-444444444444', -1, 'USD')`,
        'accounts_balance_minor_non_negative',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO accounts (id, balance_minor, currency)
         VALUES ('55555555-5555-4555-8555-555555555555', 0, 'EUR')`,
        'accounts_currency_usd_only',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           '66666666-6666-4666-8666-666666666666',
           'transfer.20260808:acct-002',
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           0,
           'USD',
           'completed'
         )`,
        'transfers_amount_minor_positive',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           '77777777-7777-4777-8777-777777777777',
           'transfer.20260808:acct-003',
           'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           -1,
           'USD',
           'completed'
         )`,
        'transfers_amount_minor_positive',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           '88888888-8888-4888-8888-888888888888',
           'transfer.20260808:acct-004',
           'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           1,
           'EUR',
           'completed'
         )`,
        'transfers_currency_usd_only',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           '99999999-9999-4999-8999-999999999999',
           'transfer.20260808:acct-005',
           'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
           '11111111-1111-4111-8111-111111111111',
           '11111111-1111-4111-8111-111111111111',
           1,
           'USD',
           'completed'
         )`,
        'transfers_distinct_accounts',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
           'transfer.20260808:acct-001',
           'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           1,
           'USD',
           'completed'
         )`,
        'transfers_idempotency_key_unique',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
           'transfer.20260808:acct-006',
           'not-a-valid-fingerprint',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           1,
           'USD',
           'completed'
         )`,
        'transfers_request_fingerprint_sha256_format',
      );
      await expectConstraintFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad',
           'transfer.20260808:acct-007',
           '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
           '11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           1,
           'USD',
           'pending'
         )`,
        'transfers_status_completed_only',
      );
      await expectForeignKeyFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae',
           'transfer.20260808:acct-008',
           '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdea',
           'aaaaaaaa-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           1,
           'USD',
           'completed'
         )`,
        'transfers_source_account_id_fkey',
      );
      await expectForeignKeyFailure(
        client,
        `INSERT INTO transfers (
           id, idempotency_key, request_fingerprint, source_account_id,
           destination_account_id, amount_minor, currency, status
         ) VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf',
           'transfer.20260808:acct-009',
           '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdeb',
           '11111111-1111-4111-8111-111111111111',
           'bbbbbbbb-2222-4222-8222-222222222222',
           1,
           'USD',
           'completed'
         )`,
        'transfers_destination_account_id_fkey',
      );
    } finally {
      await client.end();
    }
  });

  it('detects changed migration contents using checksums', async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'ledger-migrations-'),
    );
    const originalFile = path.join(
      migrationDirectory,
      '0001_initial_schema.sql',
    );
    const tempFile = path.join(tempDirectory, '0001_initial_schema.sql');
    const originalContents = await readFile(originalFile, 'utf8');
    await writeFile(
      tempFile,
      `${originalContents}\n-- checksum mutation for test\n`,
      'utf8',
    );

    try {
      await expect(
        runMigrations({
          connectionString: getDatabaseUrl(),
          migrationsDirectory: tempDirectory,
        }),
      ).rejects.toThrow(/checksum mismatch/i);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('rolls back a failed migration without leaving partial schema changes', async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'ledger-failed-migration-'),
    );
    await writeFile(
      path.join(tempDirectory, '0001_partial_failure.sql'),
      `CREATE TABLE rollback_probe (id INT PRIMARY KEY);
       SELECT does_not_exist();
      `,
      'utf8',
    );

    try {
      await expect(
        runMigrations({
          connectionString: getDatabaseUrl(),
          migrationsDirectory: tempDirectory,
        }),
      ).rejects.toThrow();

      const client = createClient(getDatabaseUrl());
      await client.connect();

      try {
        const { rows } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'rollback_probe'
           ) AS exists`,
        );
        expect(rows[0]?.exists).toBe(false);
      } finally {
        await client.end();
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

async function resetDedicatedTestDatabase(): Promise<void> {
  const client = createClient(getSchemaTestDatabaseUrl());
  await client.connect();

  try {
    const databaseName = parseSchemaTestDatabaseName(
      getSchemaTestDatabaseUrl(),
    );

    await client.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier('public')} CASCADE`,
    );
    await client.query(`CREATE SCHEMA ${quoteIdentifier('public')}`);
    await client.query(
      `GRANT ALL ON SCHEMA ${quoteIdentifier('public')} TO CURRENT_USER`,
    );
    await client.query(
      `COMMENT ON SCHEMA ${quoteIdentifier('public')} IS ${escapeLiteral(
        `reset for ${databaseName}`,
      )}`,
    );
  } finally {
    await client.end();
  }
}

function escapeLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function expectConstraintFailure(
  client: ReturnType<typeof createClient>,
  sql: string,
  constraintName: string,
): Promise<void> {
  await expect(client.query(sql)).rejects.toMatchObject({
    constraint: constraintName,
  });
}

async function expectForeignKeyFailure(
  client: ReturnType<typeof createClient>,
  sql: string,
  constraintName: string,
): Promise<void> {
  await expect(client.query(sql)).rejects.toMatchObject({
    constraint: constraintName,
  });
}
