import type { FastifyInstance } from 'fastify';

import {
  createAccountRouteContract,
  errorStatusByCode,
  getAccountBalanceRouteContract,
} from '../contracts/index.js';
import type {
  CreateAccountInput,
  CreateAccountResult,
} from '../services/create-account.js';
import {
  AccountNotFoundError,
  type GetAccountBalanceResult,
} from '../services/get-account-balance.js';

export type AccountRouteDependencies = {
  createAccount: (input: CreateAccountInput) => Promise<CreateAccountResult>;
  getAccountBalance: (accountId: string) => Promise<GetAccountBalanceResult>;
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

  app.get<{ Params: { accountId: string } }>(
    getAccountBalanceRouteContract.url,
    {
      schema: {
        params: getAccountBalanceRouteContract.params,
        response: {
          200: getAccountBalanceRouteContract.success.schema,
          400: getAccountBalanceRouteContract.errors[0]?.schema,
          404: getAccountBalanceRouteContract.errors[1]?.schema,
          500: getAccountBalanceRouteContract.errors[2]?.schema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await dependencies.getAccountBalance(request.params.accountId);
      } catch (error) {
        if (error instanceof AccountNotFoundError) {
          reply.code(errorStatusByCode.UNKNOWN_ACCOUNT);
          return {
            code: 'UNKNOWN_ACCOUNT' as const,
            message: 'Referenced account does not exist.',
            requestId: request.id,
          };
        }

        throw error;
      }
    },
  );
};
