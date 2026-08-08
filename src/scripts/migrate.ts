import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import { loadEnvironment } from '../config/env.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../db/migrations');
const MIGRATION_LOCK_KEY = 842_314_771_193_221n;
const executedScriptPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;

export type AppliedMigrationRecord = {
  id: string;
  checksum: string;
};

export type RunMigrationsOptions = {
  connectionString: string;
  migrationsDirectory?: string;
};

export type MigrationRunResult = {
  appliedMigrations: string[];
  skippedMigrations: string[];
};

const run = async (): Promise<void> => {
  const environment = loadEnvironment();
  const connectionString = createConnectionString(environment.database);
  const result = await runMigrations({
    connectionString,
  });

  console.info(`Applied ${result.appliedMigrations.length} migration(s).`);
  console.info(`Skipped ${result.skippedMigrations.length} migration(s).`);
};

export const runMigrations = async ({
  connectionString,
  migrationsDirectory: targetDirectory = migrationsDirectory,
}: RunMigrationsOptions): Promise<MigrationRunResult> => {
  const migrationFiles = await listMigrationFiles(targetDirectory);

  if (migrationFiles.length === 0) {
    return {
      appliedMigrations: [],
      skippedMigrations: [],
    };
  }

  const client = new Client({ connectionString });
  let connected = false;
  let lockAcquired = false;

  try {
    await client.connect();
    connected = true;
    await acquireMigrationLock(client);
    lockAcquired = true;
    await ensureMigrationHistoryTable(client);

    const appliedRecords = await getAppliedMigrationRecords(client);
    const appliedById = new Map(
      appliedRecords.map((record) => [record.id, record.checksum]),
    );
    const appliedMigrations: string[] = [];
    const skippedMigrations: string[] = [];

    for (const fileName of migrationFiles) {
      const migrationPath = path.join(targetDirectory, fileName);
      const sql = await readFile(migrationPath, 'utf8');
      const checksum = createMigrationChecksum(sql);
      const previousChecksum = appliedById.get(fileName);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${fileName}. Applied checksum ${previousChecksum} does not match current checksum ${checksum}.`,
          );
        }

        skippedMigrations.push(fileName);
        continue;
      }

      await client.query('BEGIN');

      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (id, checksum)
           VALUES ($1, $2)`,
          [fileName, checksum],
        );
        await client.query('COMMIT');
        appliedMigrations.push(fileName);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return {
      appliedMigrations,
      skippedMigrations,
    };
  } finally {
    try {
      if (connected && lockAcquired) {
        await releaseMigrationLock(client);
      }
    } finally {
      if (connected) {
        await client.end();
      }
    }
  }
};

const listMigrationFiles = async (directory: string): Promise<string[]> => {
  try {
    const directoryEntries = await readdir(directory, {
      withFileTypes: true,
    });

    return directoryEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }

    throw error;
  }
};

const acquireMigrationLock = async (client: Client): Promise<void> => {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
};

const releaseMigrationLock = async (client: Client): Promise<void> => {
  await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
};

const ensureMigrationHistoryTable = async (client: Client): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

const getAppliedMigrationRecords = async (
  client: Client,
): Promise<AppliedMigrationRecord[]> => {
  const { rows } = await client.query<AppliedMigrationRecord>(
    `SELECT id, checksum
     FROM schema_migrations
     ORDER BY id ASC`,
  );

  return rows;
};

const createMigrationChecksum = (sql: string): string => {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
};

const createConnectionString = (
  databaseConfig: ReturnType<typeof loadEnvironment>['database'],
): string => {
  const encodedUser = encodeURIComponent(databaseConfig.user);
  const encodedPassword = encodeURIComponent(databaseConfig.password);
  const encodedDatabaseName = encodeURIComponent(databaseConfig.name);

  return `postgresql://${encodedUser}:${encodedPassword}@${databaseConfig.host}:${databaseConfig.port}/${encodedDatabaseName}`;
};

const isMissingDirectoryError = (
  error: unknown,
): error is NodeJS.ErrnoException => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
};

if (executedScriptPath === fileURLToPath(import.meta.url)) {
  void run();
}
