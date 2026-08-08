import type { TSchema } from '@sinclair/typebox';
import fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type FastifySchemaValidationError,
} from 'fastify';

import {
  createAccountRouteContract,
  type ErrorCode,
  errorStatusByCode,
  isSchemaValueValid,
} from './contracts/index.js';
import { classifyDatabaseError } from './db/index.js';
import {
  registerAccountRoutes,
  type AccountRouteDependencies,
} from './routes/accounts.js';
import {
  registerHealthRoute,
  type HealthDependencies,
} from './routes/health.js';

export type ApplicationDependencies = HealthDependencies &
  AccountRouteDependencies & {
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
    bodyLimit: 1024,
  });

  app.setValidatorCompiler(({ schema, httpPart }) => {
    return (value: unknown) => {
      const resolvedHttpPart = httpPart ?? 'body';
      if (isSchemaValueValid(schema as TSchema, value)) {
        return { value };
      }

      return {
        error: buildValidationErrors(
          schema as TSchema,
          value,
          resolvedHttpPart,
        ),
      };
    };
  });

  registerHealthRoute(app, options.dependencies);
  registerAccountRoutes(app, options.dependencies);

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

    if (hasValidationErrors(error)) {
      const errorCode = mapValidationErrorCode(error.validation);
      reply
        .code(errorStatusByCode[errorCode])
        .send(createErrorResponse(errorCode, request.id));
      return;
    }

    const classifiedError = classifyDatabaseError(error);

    if (classifiedError !== null) {
      request.log.error(
        {
          err: error,
          sqlState: classifiedError.sqlState,
          constraint: classifiedError.constraint,
        },
        'Account persistence failed unexpectedly.',
      );
    } else {
      request.log.error({ err: error }, 'Unexpected application error.');
    }

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

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_JSON: 'Request body must contain valid JSON.',
  INVALID_REQUEST_BODY: 'Request body does not match the required schema.',
  UNEXPECTED_REQUEST_FIELD: 'Request body contains unsupported fields.',
  MALFORMED_UUID: 'Account identifier must be a valid UUID.',
  MISSING_IDEMPOTENCY_KEY: 'Idempotency-Key header is required.',
  INVALID_IDEMPOTENCY_KEY:
    'Idempotency-Key must be 8 to 128 characters using only letters, digits, period, underscore, colon, and hyphen.',
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
  IDEMPOTENCY_CONFLICT:
    'Idempotency-Key has already been used for a different transfer payload.',
  INTERNAL_ERROR: 'An unexpected internal error occurred.',
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

type FastifyValidationError = Error & {
  validation: AppValidationIssue[];
};

const hasValidationErrors = (error: unknown): error is FastifyValidationError =>
  error instanceof Error &&
  'validation' in error &&
  Array.isArray(error.validation);

type AppValidationIssue = Pick<FastifySchemaValidationError, 'keyword'> & {
  instancePath: string;
  schemaPath: string;
  params: Record<string, unknown>;
};

const mapValidationErrorCode = (
  validationErrors: AppValidationIssue[],
): ErrorCode => {
  for (const validationError of validationErrors) {
    if (validationError.keyword === 'additionalProperties') {
      return 'UNEXPECTED_REQUEST_FIELD';
    }

    if (validationError.keyword === 'const') {
      return 'INVALID_CURRENCY';
    }

    if (
      validationError.keyword === 'format' ||
      (validationError.keyword === 'pattern' &&
        validationError.instancePath.endsWith('/accountId'))
    ) {
      return 'MALFORMED_UUID';
    }
  }

  return 'INVALID_REQUEST_BODY';
};

const buildValidationErrors = (
  schema: TSchema,
  value: unknown,
  httpPart: string,
): AppValidationIssue[] => {
  if (
    httpPart === 'body' &&
    schema === createAccountRouteContract.body &&
    isRecord(value)
  ) {
    const unexpectedField = Object.keys(value).find(
      (key) => key !== 'currency' && key !== 'initialBalance',
    );

    if (unexpectedField !== undefined) {
      return [
        {
          keyword: 'additionalProperties',
          instancePath: `/${unexpectedField}`,
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
          params: {
            allowedValue: 'USD',
          },
        },
      ];
    }
  }

  return [
    {
      keyword: httpPart === 'params' ? 'pattern' : 'schema',
      instancePath: '',
      schemaPath: '#',
      params: {},
    },
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
