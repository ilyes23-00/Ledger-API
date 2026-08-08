import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { RequestIdSchema } from './primitives.js';

export const ErrorCodeSchema = Type.Union(
  [
    Type.Literal('INVALID_JSON'),
    Type.Literal('INVALID_REQUEST_BODY'),
    Type.Literal('UNEXPECTED_REQUEST_FIELD'),
    Type.Literal('MALFORMED_UUID'),
    Type.Literal('MISSING_IDEMPOTENCY_KEY'),
    Type.Literal('INVALID_IDEMPOTENCY_KEY'),
    Type.Literal('INVALID_CURRENCY'),
    Type.Literal('ZERO_AMOUNT'),
    Type.Literal('NEGATIVE_AMOUNT'),
    Type.Literal('FRACTIONAL_AMOUNT'),
    Type.Literal('UNSAFE_AMOUNT'),
    Type.Literal('EQUAL_ACCOUNT_IDS'),
    Type.Literal('UNKNOWN_ACCOUNT'),
    Type.Literal('CURRENCY_MISMATCH'),
    Type.Literal('INSUFFICIENT_FUNDS'),
    Type.Literal('IDEMPOTENCY_CONFLICT'),
    Type.Literal('INTERNAL_ERROR'),
  ],
  {
    description: 'Stable machine-readable error code.',
  },
);

export const ErrorResponseSchema = Type.Object(
  {
    code: ErrorCodeSchema,
    message: Type.String({
      minLength: 1,
      description: 'Human-readable error message safe to expose to clients.',
    }),
    requestId: RequestIdSchema,
  },
  {
    additionalProperties: false,
    description: 'Shared safe error response shape.',
  },
);

export type ErrorCode = Static<typeof ErrorCodeSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export type ErrorExample = {
  code: ErrorCode;
  message: string;
};

export type ErrorResponseDefinition = {
  description: string;
  schema: TSchema;
  examples: Record<string, ErrorResponse>;
};

export const createErrorResponseDefinition = (
  description: string,
  examples: ErrorExample[],
): ErrorResponseDefinition => {
  const mappedExamples = Object.fromEntries(
    examples.map((example) => [
      example.code,
      {
        code: example.code,
        message: example.message,
        requestId: 'req-01J6H8T8P5QW3J9J9R6K7D8M2N',
      },
    ]),
  );

  return {
    description,
    schema: ErrorResponseSchema,
    examples: mappedExamples,
  };
};
