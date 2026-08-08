import { createApp } from './app.js';
import { loadEnvironment } from './config/env.js';
import { createDatabaseConnection } from './db/pool.js';

const bootstrap = async (): Promise<void> => {
  const environment = loadEnvironment();
  const database = createDatabaseConnection(environment.database);

  const app = await createApp({
    logger: environment.nodeEnv !== 'test',
    dependencies: {
      checkDatabaseHealth: database.checkHealth,
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
