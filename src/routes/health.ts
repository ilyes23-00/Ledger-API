import type { FastifyInstance } from 'fastify';

import type { DatabaseHealth } from '../db/pool.js';

export type HealthDependencies = {
  checkDatabaseHealth: () => Promise<DatabaseHealth>;
};

export const registerHealthRoute = (
  app: FastifyInstance,
  dependencies: HealthDependencies,
): void => {
  app.get('/health', async (_request, reply) => {
    const database = await dependencies.checkDatabaseHealth();

    if (!database.reachable) {
      reply.code(503);
      return {
        status: 'error',
        database: {
          reachable: false,
        },
      };
    }

    reply.code(200);
    return {
      status: 'ok',
      database: {
        reachable: true,
      },
    };
  });
};
