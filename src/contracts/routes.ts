import { Type, type Static, type TSchema } from '@sinclair/typebox';

import {
  createErrorResponseDefinition,
  type ErrorCode,
  type ErrorResponseDefinition,
} from './errors.js';
import {
  AccountIdSchema,
  CompletedTransferStatusSchema,
  CurrencyCodeSchema,
  IdempotencyKeySchema,
  NonNegativeMinorUnitAmountSchema,
  PositiveMinorUnitAmountSchema,
  TimestampSchema,
  TransactionDirectionSchema,
  TRANSACTION_HISTORY_ORDER_DESCRIPTION,
  TransferIdSchema,
} from './primitives.js';

export const HttpMethodSchema = Type.Union([
  Type.Literal('GET'),
  Type.Literal('POST'),
]);

export type HttpMethod = Static<typeof HttpMethodSchema>;

export type OperationResponseDefinition = {
  statusCode: number;
  description: string;
  schema: TSchema;
  examples?: Record<string, unknown>;
};

export type RouteContract = {
  method: HttpMethod;
  url: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  headers?: TSchema;
  params?: TSchema;
  body?: TSchema;
  success: OperationResponseDefinition;
  errors: OperationResponseDefinition[];
};

export const CreateAccountRequestSchema = Type.Object(
  {
    currency: CurrencyCodeSchema,
    initialBalance: NonNegativeMinorUnitAmountSchema,
  },
  {
    additionalProperties: false,
    description:
      'Account creation request. initialBalance is serialized as a canonical decimal string of minor units and is the trusted account-opening funding boundary.',
  },
);

export const CreateAccountResponseSchema = Type.Object(
  {
    accountId: AccountIdSchema,
    balance: NonNegativeMinorUnitAmountSchema,
    currency: CurrencyCodeSchema,
    createdAt: TimestampSchema,
  },
  {
    additionalProperties: false,
    description: 'Created account response.',
  },
);

export const TransferRequestSchema = Type.Object(
  {
    sourceAccountId: AccountIdSchema,
    destinationAccountId: AccountIdSchema,
    amount: PositiveMinorUnitAmountSchema,
    currency: CurrencyCodeSchema,
  },
  {
    additionalProperties: false,
    description:
      'Transfer request. amount is serialized as a canonical decimal string of minor units, must be greater than zero, and uses the same explicit USD currency field as accounts.',
  },
);

export const TransferResponseSchema = Type.Object(
  {
    transferId: TransferIdSchema,
    sourceAccountId: AccountIdSchema,
    destinationAccountId: AccountIdSchema,
    amount: PositiveMinorUnitAmountSchema,
    currency: CurrencyCodeSchema,
    status: CompletedTransferStatusSchema,
    createdAt: TimestampSchema,
  },
  {
    additionalProperties: false,
    description:
      'Completed transfer response. Exact idempotent replays return the same response body and status code.',
  },
);

export const AccountBalanceResponseSchema = Type.Object(
  {
    accountId: AccountIdSchema,
    balance: NonNegativeMinorUnitAmountSchema,
    currency: CurrencyCodeSchema,
  },
  {
    additionalProperties: false,
    description: 'Current account balance response.',
  },
);

export const TransactionHistoryItemSchema = Type.Object(
  {
    transferId: TransferIdSchema,
    sourceAccountId: AccountIdSchema,
    destinationAccountId: AccountIdSchema,
    amount: PositiveMinorUnitAmountSchema,
    currency: CurrencyCodeSchema,
    status: CompletedTransferStatusSchema,
    direction: TransactionDirectionSchema,
    createdAt: TimestampSchema,
  },
  {
    additionalProperties: false,
    description:
      'Completed transfer entry in transaction history, relative to the requested account.',
  },
);

export const AccountTransactionHistoryResponseSchema = Type.Object(
  {
    accountId: AccountIdSchema,
    transactions: Type.Array(TransactionHistoryItemSchema, {
      description: TRANSACTION_HISTORY_ORDER_DESCRIPTION,
    }),
  },
  {
    additionalProperties: false,
    description:
      'Transaction history response ordered by createdAt descending, then transferId descending.',
  },
);

export const AccountIdParamsSchema = Type.Object(
  {
    accountId: AccountIdSchema,
  },
  {
    additionalProperties: false,
  },
);

export const TransferHeadersSchema = Type.Object(
  {
    'idempotency-key': IdempotencyKeySchema,
  },
  {
    additionalProperties: false,
    description:
      'Required idempotency header. Header names are case-insensitive on the wire; this schema uses the normalized lowercase name.',
  },
);

const createSuccess = (
  statusCode: number,
  description: string,
  schema: TSchema,
): OperationResponseDefinition => ({
  statusCode,
  description,
  schema,
});

const createError = (
  statusCode: number,
  definition: ErrorResponseDefinition,
): OperationResponseDefinition => ({
  statusCode,
  description: definition.description,
  schema: definition.schema,
  examples: definition.examples,
});

const badRequestErrors = createErrorResponseDefinition(
  'Bad Request. Returned for invalid JSON, invalid schema, malformed identifiers, invalid currency formatting, invalid amounts, equal account identifiers, missing required headers, invalid header values, or unexpected request fields.',
  [
    { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' },
    {
      code: 'INVALID_REQUEST_BODY',
      message: 'Request body does not match the required schema.',
    },
    {
      code: 'UNEXPECTED_REQUEST_FIELD',
      message: 'Request body contains unsupported fields.',
    },
    {
      code: 'MALFORMED_UUID',
      message: 'Account identifier must be a valid UUID.',
    },
    {
      code: 'INVALID_CURRENCY',
      message: 'Currency must be the exact literal value USD.',
    },
    {
      code: 'ZERO_AMOUNT',
      message: 'Transfer amount must be greater than zero.',
    },
    {
      code: 'NEGATIVE_AMOUNT',
      message: 'Amount cannot be negative.',
    },
    {
      code: 'FRACTIONAL_AMOUNT',
      message: 'Amount must be a whole number of minor units.',
    },
    {
      code: 'UNSAFE_AMOUNT',
      message: 'Amount exceeds the maximum supported minor-unit value.',
    },
    {
      code: 'EQUAL_ACCOUNT_IDS',
      message: 'Source and destination accounts must be different.',
    },
    {
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key header is required.',
    },
    {
      code: 'INVALID_IDEMPOTENCY_KEY',
      message:
        'Idempotency-Key must be 8 to 128 characters using only letters, digits, period, underscore, colon, and hyphen.',
    },
  ],
);

const notFoundErrors = createErrorResponseDefinition(
  'Not Found. Returned when a referenced account does not exist.',
  [
    {
      code: 'UNKNOWN_ACCOUNT',
      message: 'Referenced account does not exist.',
    },
  ],
);

const conflictErrors = createErrorResponseDefinition(
  'Conflict. Returned when the request conflicts with current resource state, including conflicting idempotency-key reuse or account currency mismatch.',
  [
    {
      code: 'IDEMPOTENCY_CONFLICT',
      message:
        'Idempotency-Key has already been used for a different transfer payload.',
    },
    {
      code: 'CURRENCY_MISMATCH',
      message: 'Source and destination accounts must use the same currency.',
    },
  ],
);

const insufficientFundsErrors = createErrorResponseDefinition(
  'Unprocessable Content. Returned when the source account does not have enough funds to complete the transfer.',
  [
    {
      code: 'INSUFFICIENT_FUNDS',
      message: 'Source account balance is insufficient for this transfer.',
    },
  ],
);

const internalServerErrors = createErrorResponseDefinition(
  'Internal Server Error. Returned for unexpected failures. Responses never include stack traces, SQL, credentials, internal paths, or database details.',
  [
    {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    },
  ],
);

export const createAccountRouteContract: RouteContract = {
  method: 'POST',
  url: '/accounts',
  operationId: 'createAccount',
  summary: 'Create an account',
  description:
    'Creates an account with the explicit USD currency and a non-negative opening balance in minor units. Account creation is the trusted opening-funding boundary.',
  tags: ['Accounts'],
  body: CreateAccountRequestSchema,
  success: createSuccess(201, 'Account created.', CreateAccountResponseSchema),
  errors: [
    createError(400, badRequestErrors),
    createError(500, internalServerErrors),
  ],
};

export const createTransferRouteContract: RouteContract = {
  method: 'POST',
  url: '/transfers',
  operationId: 'createTransfer',
  summary: 'Create a transfer',
  description:
    'Creates a completed USD transfer. Money conservation for transfers is measured immediately before and after each completed transfer. Exact idempotent replays return the original 201 response body.',
  tags: ['Transfers'],
  headers: TransferHeadersSchema,
  body: TransferRequestSchema,
  success: createSuccess(
    201,
    'Transfer completed. Exact idempotent replays return this same response and status.',
    TransferResponseSchema,
  ),
  errors: [
    createError(400, badRequestErrors),
    createError(404, notFoundErrors),
    createError(409, conflictErrors),
    createError(422, insufficientFundsErrors),
    createError(500, internalServerErrors),
  ],
};

export const getAccountBalanceRouteContract: RouteContract = {
  method: 'GET',
  url: '/accounts/:accountId/balance',
  operationId: 'getAccountBalance',
  summary: 'Get account balance',
  description: 'Returns the current balance and currency for an account.',
  tags: ['Accounts'],
  params: AccountIdParamsSchema,
  success: createSuccess(
    200,
    'Account balance retrieved.',
    AccountBalanceResponseSchema,
  ),
  errors: [
    createError(400, badRequestErrors),
    createError(404, notFoundErrors),
    createError(500, internalServerErrors),
  ],
};

export const getAccountTransactionsRouteContract: RouteContract = {
  method: 'GET',
  url: '/accounts/:accountId/transactions',
  operationId: 'getAccountTransactions',
  summary: 'Get account transaction history',
  description:
    'Returns completed transfers for the account ordered by createdAt descending, then transferId descending.',
  tags: ['Accounts'],
  params: AccountIdParamsSchema,
  success: createSuccess(
    200,
    'Account transaction history retrieved.',
    AccountTransactionHistoryResponseSchema,
  ),
  errors: [
    createError(400, badRequestErrors),
    createError(404, notFoundErrors),
    createError(500, internalServerErrors),
  ],
};

export const routeContracts = [
  createAccountRouteContract,
  createTransferRouteContract,
  getAccountBalanceRouteContract,
  getAccountTransactionsRouteContract,
] as const;

export const errorStatusByCode: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  INVALID_REQUEST_BODY: 400,
  UNEXPECTED_REQUEST_FIELD: 400,
  MALFORMED_UUID: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  INVALID_IDEMPOTENCY_KEY: 400,
  INVALID_CURRENCY: 400,
  ZERO_AMOUNT: 400,
  NEGATIVE_AMOUNT: 400,
  FRACTIONAL_AMOUNT: 400,
  UNSAFE_AMOUNT: 400,
  EQUAL_ACCOUNT_IDS: 400,
  UNKNOWN_ACCOUNT: 404,
  CURRENCY_MISMATCH: 409,
  INSUFFICIENT_FUNDS: 422,
  IDEMPOTENCY_CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export type CreateAccountRequest = Static<typeof CreateAccountRequestSchema>;
export type CreateAccountResponse = Static<typeof CreateAccountResponseSchema>;
export type TransferRequest = Static<typeof TransferRequestSchema>;
export type TransferResponse = Static<typeof TransferResponseSchema>;
export type AccountBalanceResponse = Static<
  typeof AccountBalanceResponseSchema
>;
export type AccountTransactionHistoryResponse = Static<
  typeof AccountTransactionHistoryResponseSchema
>;
