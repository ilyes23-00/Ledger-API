import type { TSchema } from '@sinclair/typebox';
import helmet from '@fastify/helmet';
import fastify, {
  type FastifyInstance,
  type FastifySchemaValidationError,
  type FastifyServerOptions,
} from 'fastify';

import {
  MAX_MINOR_UNITS,
  AccountIdSchema,
  createAccountRouteContract,
  createTransferRouteContract,
  type ErrorCode,
  errorStatusByCode,
  isSchemaValueValid,
} from './contracts/index.js';
import {
  registerAccountRoutes,
  type AccountRouteDependencies,
} from './routes/accounts.js';
import {
  registerHealthRoute,
  type HealthDependencies,
} from './routes/health.js';
import {
  registerTransferRoutes,
  type TransferRouteDependencies,
} from './routes/transfers.js';
import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  EqualAccountIdsError,
  IdempotencyConflictError,
  InsufficientFundsError,
  UnknownAccountError,
} from './services/create-transfer.js';
import { AccountNotFoundError } from './services/get-account-balance.js';

export type ApplicationDependencies = HealthDependencies &
  AccountRouteDependencies & {
    createTransfer?: TransferRouteDependencies['createTransfer'];
    closeResources?: () => Promise<void>;
  };

export type CreateAppOptions = {
  logger?: FastifyServerOptions['logger'];
  dependencies: ApplicationDependencies;
  server?: {
    connectionTimeoutMs?: number;
    requestTimeoutMs?: number;
    handlerTimeoutMs?: number;
  };
};

const JSON_BODY_LIMIT_BYTES = 16 * 1024;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 15_000;
const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.set-cookie',
  'req.headers.idempotency-key',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'DATABASE_PASSWORD',
  'DATABASE_URL',
  'SCHEMA_TEST_DATABASE_URL',
  'idempotency-key',
] as const;

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_JSON: 'Request body must contain valid JSON.',
  INVALID_REQUEST_BODY: 'Request body does not match the required schema.',
  UNEXPECTED_REQUEST_FIELD: 'Request body contains unsupported fields.',
  MALFORMED_UUID: 'Account identifier must be a valid UUID.',
  MISSING_IDEMPOTENCY_KEY: 'Idempotency-Key header is required.',
  INVALID_IDEMPOTENCY_KEY:
    'Idempotency-Key must be 8 to 128 characters using only letters, digits, period, underscore, colon, and hyphen.',
  PAYLOAD_TOO_LARGE: 'Request body exceeds the maximum allowed size.',
  INVALID_CURRENCY: 'Currency must be the exact literal value USD.',
  ZERO_AMOUNT: 'Transfer amount must be greater than zero.',
  NEGATIVE_AMOUNT: 'Amount cannot be negative.',
  FRACTIONAL_AMOUNT: 'Amount must be a whole number of minor units.',
  UNSAFE_AMOUNT: 'Amount exceeds the maximum supported minor-unit value.',
  EQUAL_ACCOUNT_IDS: 'Source and destination accounts must be different.',
  UNKNOWN_ACCOUNT: 'Referenced account does not exist.',
  CURRENCY_MISMATCH:
    'Source and destination accounts must use the same currency.',
  INSUFFICIENT_FUNDS:
    'Source account balance is insufficient for this transfer.',
  BALANCE_LIMIT_EXCEEDED:
    'Destination account balance would exceed the maximum supported value.',
  IDEMPOTENCY_CONFLICT:
    'Idempotency-Key has already been used for a different transfer payload.',
  INTERNAL_ERROR: 'An unexpected internal error occurred.',
};

type AppValidationIssue = Pick<FastifySchemaValidationError, 'keyword'> & {
  instancePath: string;
  schemaPath: string;
  params: Record<string, unknown>;
};

type FastifyValidationError = Error & {
  validation: AppValidationIssue[];
};

type KnownDomainError =
  | AccountNotFoundError
  | UnknownAccountError
  | IdempotencyConflictError
  | CurrencyMismatchError
  | InsufficientFundsError
  | BalanceLimitExceededError
  | EqualAccountIdsError;

export const createApp = async (
  options: CreateAppOptions,
): Promise<FastifyInstance> => {
  const fastifyOptions: FastifyServerOptions = {
    logger: buildLoggerOptions(options.logger),
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    connectionTimeout:
      options.server?.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    requestTimeout:
      options.server?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    handlerTimeout:
      options.server?.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
  };
  const app: FastifyInstance = fastify(fastifyOptions);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  app.setValidatorCompiler(({ schema, httpPart }) => {
    return (value: unknown) => {
      if (isSchemaValueValid(schema as TSchema, value)) {
        return { value };
      }

      return {
        error: buildValidationErrors(schema as TSchema, value, httpPart),
      };
    };
  });

  registerHealthRoute(app, options.dependencies);
  registerAccountRoutes(app, options.dependencies);

  if (options.dependencies.createTransfer !== undefined) {
    registerTransferRoutes(app, {
      createTransfer: options.dependencies.createTransfer,
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      return;
    }

    if (isInvalidJsonError(error)) {
      reply
        .code(errorStatusByCode.INVALID_JSON)
        .send(createErrorResponse('INVALID_JSON', request.id));
      return;
    }

    if (isPayloadTooLargeError(error)) {
      reply
        .code(errorStatusByCode.PAYLOAD_TOO_LARGE)
        .send(createErrorResponse('PAYLOAD_TOO_LARGE', request.id));
      return;
    }

    if (isHandlerTimeoutError(error)) {
      reply.code(503).send(createErrorResponse('INTERNAL_ERROR', request.id));
      return;
    }

    if (hasValidationErrors(error)) {
      const errorCode = mapValidationErrorCode(error.validation);
      reply
        .code(errorStatusByCode[errorCode])
        .send(createErrorResponse(errorCode, request.id));
      return;
    }

    if (isKnownDomainError(error)) {
      reply
        .code(errorStatusByCode[error.code])
        .send(createErrorResponse(error.code, request.id));
      return;
    }

    request.log.error({ err: error }, 'Unexpected request failure.');

    reply
      .code(errorStatusByCode.INTERNAL_ERROR)
      .send(createErrorResponse('INTERNAL_ERROR', request.id));
  });

  if (options.dependencies.closeResources !== undefined) {
    app.addHook('onClose', async () => {
      await options.dependencies.closeResources?.();
    });
  }

  await app.ready();

  return app;
};

const createErrorResponse = (code: ErrorCode, requestId: string) => ({
  code,
  message: ERROR_MESSAGES[code],
  requestId,
});

const isInvalidJsonError = (error: unknown): error is { code: string } =>
  error instanceof Error &&
  'code' in error &&
  error.code === 'FST_ERR_CTP_INVALID_JSON_BODY';

const isPayloadTooLargeError = (error: unknown): error is { code: string } =>
  error instanceof Error &&
  'code' in error &&
  error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';

const isHandlerTimeoutError = (error: unknown): error is { code: string } =>
  error instanceof Error &&
  'code' in error &&
  error.code === 'FST_ERR_HANDLER_TIMEOUT';

const hasValidationErrors = (error: unknown): error is FastifyValidationError =>
  error instanceof Error &&
  'validation' in error &&
  Array.isArray(error.validation);

const isKnownDomainError = (error: unknown): error is KnownDomainError =>
  error instanceof AccountNotFoundError ||
  error instanceof UnknownAccountError ||
  error instanceof IdempotencyConflictError ||
  error instanceof CurrencyMismatchError ||
  error instanceof InsufficientFundsError ||
  error instanceof BalanceLimitExceededError ||
  error instanceof EqualAccountIdsError;

const mapValidationErrorCode = (
  validationErrors: AppValidationIssue[],
): ErrorCode => {
  for (const validationError of validationErrors) {
    if (validationError.keyword === 'additionalProperties') {
      return validationError.instancePath === ''
        ? 'UNEXPECTED_REQUEST_FIELD'
        : 'INVALID_REQUEST_BODY';
    }

    if (validationError.keyword === 'const') {
      return 'INVALID_CURRENCY';
    }

    if (validationError.keyword === 'missing-idempotency-key') {
      return 'MISSING_IDEMPOTENCY_KEY';
    }

    if (validationError.keyword === 'invalid-idempotency-key') {
      return 'INVALID_IDEMPOTENCY_KEY';
    }

    if (validationError.keyword === 'amount-zero') {
      return 'ZERO_AMOUNT';
    }

    if (validationError.keyword === 'amount-negative') {
      return 'NEGATIVE_AMOUNT';
    }

    if (validationError.keyword === 'amount-fractional') {
      return 'FRACTIONAL_AMOUNT';
    }

    if (
      validationError.keyword === 'amount-invalid' ||
      validationError.keyword === 'amount-signed'
    ) {
      return 'INVALID_REQUEST_BODY';
    }

    if (validationError.keyword === 'amount-unsafe') {
      return 'UNSAFE_AMOUNT';
    }

    if (validationError.keyword === 'equal-account-ids') {
      return 'EQUAL_ACCOUNT_IDS';
    }

    if (
      validationError.keyword === 'format' ||
      (validationError.keyword === 'pattern' &&
        (validationError.instancePath.endsWith('/accountId') ||
          validationError.instancePath.endsWith('/sourceAccountId') ||
          validationError.instancePath.endsWith('/destinationAccountId') ||
          validationError.schemaPath.includes('accountId') ||
          validationError.instancePath === ''))
    ) {
      return 'MALFORMED_UUID';
    }
  }

  return 'INVALID_REQUEST_BODY';
};

const buildValidationErrors = (
  schema: TSchema,
  value: unknown,
  httpPart: string | undefined,
): AppValidationIssue[] => {
  if (
    httpPart === 'headers' &&
    schema === createTransferRouteContract.headers
  ) {
    return buildTransferHeaderErrors(value);
  }

  if (
    httpPart === 'body' &&
    (schema === createAccountRouteContract.body ||
      schema === createTransferRouteContract.body) &&
    isRecord(value)
  ) {
    return buildBodyValidationErrors(schema, value);
  }

  if (httpPart === 'params' && isRecord(value) && 'accountId' in value) {
    return [
      {
        keyword: 'pattern',
        instancePath: '/accountId',
        schemaPath: '#/properties/accountId/pattern',
        params: {},
      },
    ];
  }

  if (httpPart === 'querystring' && isRecord(value)) {
    const [firstQueryKey] = Object.keys(value);

    if (firstQueryKey !== undefined) {
      return [
        {
          keyword: 'additionalProperties',
          instancePath: `/${firstQueryKey}`,
          schemaPath: '#/additionalProperties',
          params: {
            additionalProperty: firstQueryKey,
          },
        },
      ];
    }
  }

  return [
    {
      keyword: 'validation',
      instancePath: '',
      schemaPath: '#',
      params: {},
    },
  ];
};

const buildBodyValidationErrors = (
  schema: TSchema,
  value: Record<string, unknown>,
): AppValidationIssue[] => {
  const allowedFields =
    schema === createAccountRouteContract.body
      ? new Set(['currency', 'initialBalance'])
      : new Set([
          'sourceAccountId',
          'destinationAccountId',
          'amount',
          'currency',
        ]);

  const unexpectedField = Object.keys(value).find(
    (key) => !allowedFields.has(key),
  );

  if (unexpectedField !== undefined) {
    return [
      {
        keyword: 'additionalProperties',
        instancePath: '',
        schemaPath: '#/additionalProperties',
        params: {
          additionalProperty: unexpectedField,
        },
      },
    ];
  }

  if ('currency' in value && value['currency'] !== 'USD') {
    return [
      {
        keyword: 'const',
        instancePath: '/currency',
        schemaPath: '#/properties/currency/const',
        params: {},
      },
    ];
  }

  if (
    schema === createTransferRouteContract.body &&
    'sourceAccountId' in value &&
    !isSchemaValueValid(AccountIdSchema, value['sourceAccountId'])
  ) {
    return [
      {
        keyword: 'pattern',
        instancePath: '/sourceAccountId',
        schemaPath: '#/properties/sourceAccountId/pattern',
        params: {},
      },
    ];
  }

  if (
    schema === createTransferRouteContract.body &&
    'destinationAccountId' in value &&
    !isSchemaValueValid(AccountIdSchema, value['destinationAccountId'])
  ) {
    return [
      {
        keyword: 'pattern',
        instancePath: '/destinationAccountId',
        schemaPath: '#/properties/destinationAccountId/pattern',
        params: {},
      },
    ];
  }

  if (
    schema === createTransferRouteContract.body &&
    value['sourceAccountId'] === value['destinationAccountId']
  ) {
    return [
      {
        keyword: 'equal-account-ids',
        instancePath: '/destinationAccountId',
        schemaPath: '#/properties/destinationAccountId',
        params: {},
      },
    ];
  }

  if (schema === createTransferRouteContract.body && 'amount' in value) {
    const amount = value['amount'];

    if (typeof amount !== 'string') {
      return [
        {
          keyword: 'amount-signed',
          instancePath: '/amount',
          schemaPath: '#/properties/amount',
          params: {},
        },
      ];
    }

    if (amount === '0') {
      return [
        {
          keyword: 'amount-zero',
          instancePath: '/amount',
          schemaPath: '#/properties/amount',
          params: {},
        },
      ];
    }

    if (amount.startsWith('-')) {
      return [
        {
          keyword: 'amount-negative',
          instancePath: '/amount',
          schemaPath: '#/properties/amount',
          params: {},
        },
      ];
    }

    if (amount.includes('.')) {
      return [
        {
          keyword: 'amount-fractional',
          instancePath: '/amount',
          schemaPath: '#/properties/amount',
          params: {},
        },
      ];
    }

    if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
      return [
        {
          keyword: 'amount-invalid',
          instancePath: '/amount',
          schemaPath: '#/properties/amount',
          params: {},
        },
      ];
    }

    if (
      amount.length > MAX_MINOR_UNITS.length ||
      (amount.length === MAX_MINOR_UNITS.length && amount > MAX_MINOR_UNITS)
    ) {
      return [
        {
          keyword: 'amount-unsafe',
          instancePath: '/amount',
          schemaPath: '#/properties/amount',
          params: {},
        },
      ];
    }
  }

  return [
    {
      keyword: 'validation',
      instancePath: '',
      schemaPath: '#',
      params: {},
    },
  ];
};

const buildTransferHeaderErrors = (value: unknown): AppValidationIssue[] => {
  if (!isRecord(value)) {
    return [
      {
        keyword: 'missing-idempotency-key',
        instancePath: '/idempotency-key',
        schemaPath: '#/headers/idempotency-key',
        params: {},
      },
    ];
  }

  const idempotencyKey = value['idempotency-key'];

  if (typeof idempotencyKey !== 'string') {
    return [
      {
        keyword: 'missing-idempotency-key',
        instancePath: '/idempotency-key',
        schemaPath: '#/headers/idempotency-key',
        params: {},
      },
    ];
  }

  const transferHeaderSchema =
    createTransferRouteContract.headers as TSchema & {
      properties: Record<string, TSchema>;
    };
  const idempotencyKeySchema =
    transferHeaderSchema.properties['idempotency-key'];

  if (idempotencyKeySchema === undefined) {
    return [
      {
        keyword: 'invalid-idempotency-key',
        instancePath: '/idempotency-key',
        schemaPath: '#/headers/idempotency-key',
        params: {},
      },
    ];
  }

  if (!isSchemaValueValid(idempotencyKeySchema, idempotencyKey)) {
    return [
      {
        keyword: 'invalid-idempotency-key',
        instancePath: '/idempotency-key',
        schemaPath: '#/headers/idempotency-key',
        params: {},
      },
    ];
  }

  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const buildLoggerOptions = (
  logger: FastifyServerOptions['logger'] | undefined,
): Exclude<FastifyServerOptions['logger'], undefined> => {
  if (logger === false) {
    return false;
  }

  const baseOptions = {
    redact: [...REDACTED_LOG_PATHS],
  };

  if (logger === true || logger === undefined) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    ...logger,
    redact: [...REDACTED_LOG_PATHS],
  };
};

export const appConstants = {
  jsonBodyLimitBytes: JSON_BODY_LIMIT_BYTES,
};
