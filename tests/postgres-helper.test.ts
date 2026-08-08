import { describe, expect, it, vi } from 'vitest';

import {
  getSchemaTestDatabaseUrl,
  parseSchemaTestDatabaseName,
  SCHEMA_TEST_DATABASE_URL_ENV,
} from './helpers/postgres.js';

describe('schema test database safety guard', () => {
  it('accepts ledger_schema_test', () => {
    expect(
      parseSchemaTestDatabaseName(
        'postgresql://ledger:secret@127.0.0.1:5432/ledger_schema_test',
      ),
    ).toBe('ledger_schema_test');
  });

  it('accepts other names ending in _test', () => {
    expect(
      parseSchemaTestDatabaseName(
        'postgresql://ledger:secret@127.0.0.1:5432/integration_test',
      ),
    ).toBe('integration_test');
  });

  it('rejects postgres, ledger, production, and prod', () => {
    for (const databaseName of ['postgres', 'ledger', 'production', 'prod']) {
      expect(() =>
        parseSchemaTestDatabaseName(
          `postgresql://ledger:secret@127.0.0.1:5432/${databaseName}`,
        ),
      ).toThrow(/must not target reserved or non-test database names/i);
    }
  });

  it('rejects application_name=schema_test without a dedicated test database name', () => {
    vi.stubEnv(
      SCHEMA_TEST_DATABASE_URL_ENV,
      'postgresql://ledger:secret@127.0.0.1:5432/postgres?application_name=schema_test',
    );

    expect(() => getSchemaTestDatabaseUrl()).toThrow(
      /must not target reserved or non-test database names/i,
    );
  });

  it('rejects missing, empty, and malformed database urls before destructive work', () => {
    vi.unstubAllEnvs();
    expect(() => getSchemaTestDatabaseUrl()).toThrow(/is required/i);

    vi.stubEnv(SCHEMA_TEST_DATABASE_URL_ENV, '   ');
    expect(() => getSchemaTestDatabaseUrl()).toThrow(/is required/i);

    expect(() => parseSchemaTestDatabaseName('not-a-url')).toThrow(
      /must be a valid PostgreSQL connection URL/i,
    );
    expect(() =>
      parseSchemaTestDatabaseName('postgresql://ledger:secret@127.0.0.1'),
    ).toThrow(/must include a non-empty database name/i);
  });
});
