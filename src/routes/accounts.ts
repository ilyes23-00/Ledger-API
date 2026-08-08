import type { FastifyInstance } from 'fastify';

import { createAccountRouteContract } from '../contracts/index.js';
import type {
  CreateAccountInput,
  CreateAccountResult,
} from '../services/create-account.js';

export type AccountRouteDependencies = {
  createAccount: (input: CreateAccountInput) => Promise<CreateAccountResult>;
};

export const registerAccountRoutes = (
  app: FastifyInstance,
  dependencies: AccountRouteDependencies,
): void => {
  app.post<{ Body: CreateAccountInput }>(
    createAccountRouteContract.url,
    {
      schema: {
        body: createAccountRouteContract.body,
        response: {
          201: createAccountRouteContract.success.schema,
          400: createAccountRouteContract.errors[0]?.schema,
          500: createAccountRouteContract.errors[1]?.schema,
        },
      },
    },
    async (request, reply) => {
      const account = await dependencies.createAccount(request.body);

      reply.code(201);
      return account;
    },
  );
};
