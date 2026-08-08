import type { FastifyInstance } from 'fastify';

import { createTransferRouteContract } from '../contracts/index.js';
import type {
  CreateTransferInput,
  CreateTransferResult,
} from '../services/create-transfer.js';

export type TransferRouteDependencies = {
  createTransfer: (input: CreateTransferInput) => Promise<CreateTransferResult>;
};

export const registerTransferRoutes = (
  app: FastifyInstance,
  dependencies: TransferRouteDependencies,
): void => {
  app.post<{
    Body: Omit<CreateTransferInput, 'idempotencyKey'>;
    Headers: { 'idempotency-key': string };
  }>(
    createTransferRouteContract.url,
    {
      schema: {
        headers: createTransferRouteContract.headers,
        querystring: createTransferRouteContract.querystring,
        body: createTransferRouteContract.body,
        response: {
          201: createTransferRouteContract.success.schema,
          400: createTransferRouteContract.errors[0]?.schema,
          413: createTransferRouteContract.errors[1]?.schema,
          404: createTransferRouteContract.errors[2]?.schema,
          409: createTransferRouteContract.errors[3]?.schema,
          422: createTransferRouteContract.errors[4]?.schema,
          500: createTransferRouteContract.errors[6]?.schema,
        },
      },
    },
    async (request, reply) => {
      const transfer = await dependencies.createTransfer({
        ...request.body,
        idempotencyKey: request.headers['idempotency-key'],
      });

      reply.code(201);
      return transfer;
    },
  );
};
