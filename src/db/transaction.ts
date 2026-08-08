import type { PoolClient } from 'pg';

export type TransactionClient = Pick<PoolClient, 'release'> & {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type TransactionPool = {
  connect: () => Promise<TransactionClient>;
};

export class TransactionRollbackError extends Error {
  public readonly rollbackError: unknown;

  public constructor(primaryError: unknown, rollbackError: unknown) {
    super('Database transaction rollback failed.', { cause: primaryError });
    this.name = 'TransactionRollbackError';
    this.rollbackError = rollbackError;
  }
}

export const executeInTransaction = async <TResult>(
  pool: TransactionPool,
  callback: (client: TransactionClient) => TResult | Promise<TResult>,
): Promise<TResult> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    try {
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new TransactionRollbackError(error, rollbackError);
      }

      throw error;
    }
  } finally {
    client.release();
  }
};
