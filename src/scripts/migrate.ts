import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../db/migrations');

const run = async (): Promise<void> => {
  const migrationFiles = await listMigrationFiles();

  if (migrationFiles.length === 0) {
    console.info('No migration files found.');
    return;
  }

  console.info(`Discovered ${migrationFiles.length} migration file(s):`);

  for (const fileName of migrationFiles) {
    console.info(`- ${fileName}`);
  }
};

const listMigrationFiles = async (): Promise<string[]> => {
  try {
    const directoryEntries = await readdir(migrationsDirectory, {
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

const isMissingDirectoryError = (
  error: unknown,
): error is NodeJS.ErrnoException => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
};

void run();
