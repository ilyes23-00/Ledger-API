import type { TSchema } from '@sinclair/typebox';

import { ErrorResponseSchema } from './errors.js';
import {
  AccountIdSchema,
  CompletedTransferStatusSchema,
  CurrencyCodeSchema,
  IdempotencyKeySchema,
  NonNegativeMinorUnitAmountSchema,
  PositiveMinorUnitAmountSchema,
  RequestIdSchema,
  TimestampSchema,
  TransactionDirectionSchema,
  TransferIdSchema,
} from './primitives.js';
import {
  AccountBalanceResponseSchema,
  AccountIdParamsSchema,
  AccountTransactionHistoryResponseSchema,
  CreateAccountRequestSchema,
  CreateAccountResponseSchema,
  createAccountRouteContract,
  createTransferRouteContract,
  getAccountBalanceRouteContract,
  getAccountTransactionsRouteContract,
  type OperationResponseDefinition,
  type RouteContract,
  routeContracts,
  TransferHeadersSchema,
  TransferRequestSchema,
  TransferResponseSchema,
} from './routes.js';

type OpenApiParameter = {
  name: string;
  in: 'header' | 'path';
  required: boolean;
  schema: TSchema;
  description?: string;
};

type OpenApiMediaObject = {
  schema: TSchema;
  examples?: Record<string, { value: unknown }>;
};

type OpenApiResponse = {
  description: string;
  content: {
    'application/json': OpenApiMediaObject;
  };
};

type OpenApiOperation = {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: true;
    content: {
      'application/json': OpenApiMediaObject;
    };
  };
  responses: Record<string, OpenApiResponse>;
};

export const contractComponentSchemas = {
  RequestId: RequestIdSchema,
  AccountId: AccountIdSchema,
  TransferId: TransferIdSchema,
  CurrencyCode: CurrencyCodeSchema,
  IdempotencyKey: IdempotencyKeySchema,
  Timestamp: TimestampSchema,
  NonNegativeMinorUnitAmount: NonNegativeMinorUnitAmountSchema,
  PositiveMinorUnitAmount: PositiveMinorUnitAmountSchema,
  CompletedTransferStatus: CompletedTransferStatusSchema,
  TransactionDirection: TransactionDirectionSchema,
  ErrorResponse: ErrorResponseSchema,
  CreateAccountRequest: CreateAccountRequestSchema,
  CreateAccountResponse: CreateAccountResponseSchema,
  TransferRequest: TransferRequestSchema,
  TransferResponse: TransferResponseSchema,
  AccountBalanceResponse: AccountBalanceResponseSchema,
  AccountTransactionHistoryResponse: AccountTransactionHistoryResponseSchema,
  AccountIdParams: AccountIdParamsSchema,
  TransferHeaders: TransferHeadersSchema,
} as const;

export const buildOpenApiDocument = () => {
  const paths = routeContracts.reduce<
    Record<string, Record<string, OpenApiOperation>>
  >((accumulator, contract) => {
    accumulator[convertPathForOpenApi(contract.url)] = {
      [contract.method.toLowerCase()]: buildOperation(contract),
    };

    return accumulator;
  }, {});

  return {
    openapi: '3.0.3',
    info: {
      title: 'Transaction Ledger API',
      version: '1.0.0-contract',
      description:
        'Contract-first OpenAPI document for the transaction ledger API.',
    },
    tags: [{ name: 'Accounts' }, { name: 'Transfers' }],
    paths,
    components: {
      schemas: contractComponentSchemas,
    },
  };
};

function buildOperation(contract: RouteContract): OpenApiOperation {
  const parameters = [
    ...schemaObjectToParameters(contract.headers, 'header'),
    ...schemaObjectToParameters(contract.params, 'path'),
  ];
  const operation: OpenApiOperation = {
    operationId: contract.operationId,
    summary: contract.summary,
    description: contract.description,
    tags: contract.tags,
    responses: buildResponses(contract),
  };

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (contract.body !== undefined) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: contract.body,
        },
      },
    };
  }

  return operation;
}

function buildResponses(
  contract: RouteContract,
): Record<string, OpenApiResponse> {
  return Object.fromEntries([
    [String(contract.success.statusCode), buildResponse(contract.success)],
    ...contract.errors.map((response) => [
      String(response.statusCode),
      buildResponse(response),
    ]),
  ]) as Record<string, OpenApiResponse>;
}

function buildResponse(response: OperationResponseDefinition): OpenApiResponse {
  const mediaObject: OpenApiMediaObject = {
    schema: response.schema,
  };

  if (response.examples !== undefined) {
    mediaObject.examples = Object.fromEntries(
      Object.entries(response.examples).map(([name, value]) => [
        name,
        { value },
      ]),
    );
  }

  return {
    description: response.description,
    content: {
      'application/json': mediaObject,
    },
  };
}

function schemaObjectToParameters(
  schema: TSchema | undefined,
  location: 'header' | 'path',
): OpenApiParameter[] {
  if (
    schema === undefined ||
    schema['type'] !== 'object' ||
    schema['properties'] === undefined
  ) {
    return [];
  }

  const required = new Set(
    Array.isArray(schema['required']) ? schema['required'] : [],
  );
  const properties = schema['properties'] as Record<string, unknown>;

  return Object.entries(properties).map(([name, propertySchema]) => {
    const parameter: OpenApiParameter = {
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      schema: propertySchema as TSchema,
    };

    if (
      typeof propertySchema === 'object' &&
      propertySchema !== null &&
      'description' in propertySchema &&
      typeof propertySchema.description === 'string'
    ) {
      parameter.description = propertySchema.description;
    }

    return parameter;
  });
}

function convertPathForOpenApi(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export const openApiRouteIndex = {
  createAccountRouteContract,
  createTransferRouteContract,
  getAccountBalanceRouteContract,
  getAccountTransactionsRouteContract,
};
