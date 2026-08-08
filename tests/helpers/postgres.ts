import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

export const SCHEMA_TEST_DATABASE_URL_ENV = 'SCHEMA_TEST_DATABASE_URL';
const REJECTED_DATABASE_NAMES = new Set([
  'postgres',
  'ledger',
  'production',
  'prod',
]);
const TEST_DATABASE_NAME_PATTERN = /^[a-z0-9_]+_test$/;

export const getSchemaTestDatabaseUrl = (): string => {
  const databaseUrl = process.env[SCHEMA_TEST_DATABASE_URL_ENV];

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error(
      `${SCHEMA_TEST_DATABASE_URL_ENV} is required for real PostgreSQL schema tests.`,
    );
  }

  const databaseName = parseSchemaTestDatabaseName(databaseUrl);

  if (!TEST_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(
      `${SCHEMA_TEST_DATABASE_URL_ENV} must target a dedicated test database whose name ends with _test.`,
    );
  }

  return databaseUrl;
};

export const parseSchemaTestDatabaseName = (databaseUrl: string): string => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error(
      `${SCHEMA_TEST_DATABASE_URL_ENV} must be a valid PostgreSQL connection URL.`,
    );
  }

  const databaseName = decodeURIComponent(
    parsedUrl.pathname.replace(/^\/+/, ''),
  );

  if (databaseName.trim() === '') {
    throw new Error(
      `${SCHEMA_TEST_DATABASE_URL_ENV} must include a non-empty database name.`,
    );
  }

  if (REJECTED_DATABASE_NAMES.has(databaseName.toLowerCase())) {
    throw new Error(
      `${SCHEMA_TEST_DATABASE_URL_ENV} must not target reserved or non-test database names such as postgres, ledger, production, or prod.`,
    );
  }

  return databaseName;
};

export const createTestDatabaseName = (): string =>
  `ledger_${randomUUID().replace(/-/g, '')}_test`;

export const createClient = (connectionString: string): Client =>
  new Client({
    connectionString,
  });

export const withAdminDatabase = (
  connectionString: string,
  databaseName: string,
): string => {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

export const quoteIdentifier = (identifier: string): string => {
  return `"${identifier.replaceAll('"', '""')}"`;
};
