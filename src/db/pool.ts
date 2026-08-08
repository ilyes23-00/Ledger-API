import { Pool } from 'pg';

import type { AppEnvironment } from '../config/env.js';

export type DatabaseHealth = {
  reachable: boolean;
};

export type DatabaseConnection = {
  pool: Pool;
  checkHealth: () => Promise<DatabaseHealth>;
  close: () => Promise<void>;
};

export const createDatabaseConnection = (
  databaseConfig: AppEnvironment['database'],
): DatabaseConnection => {
  const pool = new Pool({
    host: databaseConfig.host,
    port: databaseConfig.port,
    database: databaseConfig.name,
    user: databaseConfig.user,
    password: databaseConfig.password,
    max: databaseConfig.poolMax,
    min: databaseConfig.poolMin,
    idleTimeoutMillis: databaseConfig.idleTimeoutMs,
    connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
    statement_timeout: databaseConfig.statementTimeoutMs,
    lock_timeout: databaseConfig.lockTimeoutMs,
    idle_in_transaction_session_timeout:
      databaseConfig.idleInTransactionSessionTimeoutMs,
    allowExitOnIdle: false,
  });

  return {
    pool,
    checkHealth: async () => {
      try {
        await pool.query('SELECT 1');
        return { reachable: true };
      } catch {
        return { reachable: false };
      }
    },
    close: async () => {
      await pool.end();
    },
  };
};
