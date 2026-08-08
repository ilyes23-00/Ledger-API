import { createApp } from './app.js';
import { loadEnvironment } from './config/env.js';
import {
  findAccountById,
  listAccountTransactions,
  insertAccount,
  insertTransferIfAbsent,
  findTransferByIdempotencyKey,
  lockAccountsById,
  updateAccountBalance,
} from './db/index.js';
import { createDatabaseConnection } from './db/pool.js';
import { createAccountWithDatabase } from './services/create-account.js';
import { createTransfer } from './services/create-transfer.js';
import { getAccountBalanceWithDatabase } from './services/get-account-balance.js';
import { getAccountTransactionsWithDatabase } from './services/get-account-transactions.js';

const bootstrap = async (): Promise<void> => {
  const environment = loadEnvironment();
  const database = createDatabaseConnection(environment.database);

  const app = await createApp({
    logger: environment.nodeEnv !== 'test',
    server: {
      connectionTimeoutMs: environment.server.connectionTimeoutMs,
      requestTimeoutMs: environment.server.requestTimeoutMs,
      handlerTimeoutMs: environment.server.handlerTimeoutMs,
    },
    dependencies: {
      checkDatabaseHealth: database.checkHealth,
      createAccount: createAccountWithDatabase(insertAccount, database.pool),
      getAccountBalance: getAccountBalanceWithDatabase(
        findAccountById,
        database.pool,
      ),
      getAccountTransactions: getAccountTransactionsWithDatabase(
        findAccountById,
        listAccountTransactions,
        database.pool,
      ),
      createTransfer: createTransfer({
        transactionPool: database.pool,
        insertTransferIfAbsent,
        findTransferByIdempotencyKey,
        lockAccountsById,
        updateAccountBalance,
      }),
      closeResources: database.close,
    },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');

    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ error, signal }, 'Failed to shut down cleanly');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await app.listen({
      host: environment.server.host,
      port: environment.server.port,
    });
  } catch (error) {
    app.log.error({ error }, 'Failed to start server');
    await app.close();
    process.exitCode = 1;
  }
};

void bootstrap();
