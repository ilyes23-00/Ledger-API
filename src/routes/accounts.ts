import type { FastifyInstance } from 'fastify';

import {
  createAccountRouteContract,
  getAccountBalanceRouteContract,
  getAccountTransactionsRouteContract,
} from '../contracts/index.js';
import type {
  CreateAccountInput,
  CreateAccountResult,
} from '../services/create-account.js';
import type { GetAccountBalanceResult } from '../services/get-account-balance.js';
import type { GetAccountTransactionsResult } from '../services/get-account-transactions.js';

export type AccountRouteDependencies = {
  createAccount: (input: CreateAccountInput) => Promise<CreateAccountResult>;
  getAccountBalance: (accountId: string) => Promise<GetAccountBalanceResult>;
  getAccountTransactions: (
    accountId: string,
  ) => Promise<GetAccountTransactionsResult>;
};

export const registerAccountRoutes = (
  app: FastifyInstance,
  dependencies: AccountRouteDependencies,
): void => {
  app.post<{ Body: CreateAccountInput }>(
    createAccountRouteContract.url,
    {
      schema: {
        querystring: createAccountRouteContract.querystring,
        body: createAccountRouteContract.body,
        response: {
          201: createAccountRouteContract.success.schema,
          400: createAccountRouteContract.errors[0]?.schema,
          413: createAccountRouteContract.errors[1]?.schema,
          500: createAccountRouteContract.errors[2]?.schema,
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
        querystring: getAccountBalanceRouteContract.querystring,
        response: {
          200: getAccountBalanceRouteContract.success.schema,
          400: getAccountBalanceRouteContract.errors[0]?.schema,
          404: getAccountBalanceRouteContract.errors[1]?.schema,
          500: getAccountBalanceRouteContract.errors[2]?.schema,
        },
      },
    },
    async (request) => dependencies.getAccountBalance(request.params.accountId),
  );

  app.get<{ Params: { accountId: string } }>(
    getAccountTransactionsRouteContract.url,
    {
      schema: {
        params: getAccountTransactionsRouteContract.params,
        querystring: getAccountTransactionsRouteContract.querystring,
        response: {
          200: getAccountTransactionsRouteContract.success.schema,
          400: getAccountTransactionsRouteContract.errors[0]?.schema,
          404: getAccountTransactionsRouteContract.errors[1]?.schema,
          500: getAccountTransactionsRouteContract.errors[2]?.schema,
        },
      },
    },
    async (request) =>
      dependencies.getAccountTransactions(request.params.accountId),
  );
};
