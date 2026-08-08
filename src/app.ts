import fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import {
  registerHealthRoute,
  type HealthDependencies,
} from './routes/health.js';

export type ApplicationDependencies = HealthDependencies & {
  closeResources?: () => Promise<void>;
};

export type CreateAppOptions = {
  logger?: FastifyServerOptions['logger'];
  dependencies: ApplicationDependencies;
};

export const createApp = async (
  options: CreateAppOptions,
): Promise<FastifyInstance> => {
  const app = fastify({
    logger: options.logger ?? false,
  });

  registerHealthRoute(app, options.dependencies);

  if (options.dependencies.closeResources !== undefined) {
    app.addHook('onClose', async () => {
      await options.dependencies.closeResources?.();
    });
  }

  await app.ready();

  return app;
};
