import {
  Kind,
  Type,
  type Static,
  type TSchema,
  TypeRegistry,
} from '@sinclair/typebox';

export const MAX_MINOR_UNITS = '9223372036854775807';
export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const TRANSACTION_HISTORY_ORDER_DESCRIPTION =
  'Transactions are ordered by createdAt descending, then transferId descending.';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const IDEMPOTENCY_KEY_PATTERN =
  '^[A-Za-z0-9](?:[A-Za-z0-9._:-]{6,126}[A-Za-z0-9])$';
const RFC3339_UTC_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$';
const CANONICAL_INTEGER_STRING_PATTERN = '^(0|[1-9][0-9]*)$';

const MINOR_UNIT_STRING_KIND = 'MinorUnitString';

type MinorUnitMode = 'nonNegative' | 'positive';

type MinorUnitSchema = TSchema & {
  [Kind]: typeof MINOR_UNIT_STRING_KIND;
  minimumMode: MinorUnitMode;
};

TypeRegistry.Set(MINOR_UNIT_STRING_KIND, (schema, value) =>
  validateMinorUnitString(value, (schema as MinorUnitSchema).minimumMode),
);

export const RequestIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  description:
    'Opaque request identifier included in logs and error responses for support and tracing.',
  examples: ['req-01J6H8T8P5QW3J9J9R6K7D8M2N'],
});

export const AccountIdSchema = Type.String({
  pattern: UUID_PATTERN,
  description: 'Server-generated UUID that uniquely identifies an account.',
  examples: ['6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'],
});

export const TransferIdSchema = Type.String({
  pattern: UUID_PATTERN,
  description: 'Server-generated UUID that uniquely identifies a transfer.',
  examples: ['6c20e9be-1ca5-4dc4-8f73-cb72794d4c6a'],
});

export const CurrencyCodeSchema = Type.Literal('USD', {
  description:
    'The only supported currency code. Requests and responses must use the exact literal value USD.',
  examples: ['USD'],
});

export const IdempotencyKeySchema = Type.String({
  pattern: IDEMPOTENCY_KEY_PATTERN,
  minLength: MIN_IDEMPOTENCY_KEY_LENGTH,
  maxLength: MAX_IDEMPOTENCY_KEY_LENGTH,
  description:
    'Required transfer idempotency key. Allowed characters are letters, digits, period, underscore, colon, and hyphen.',
  examples: ['transfer.20260808:acct-001'],
});

export const TimestampSchema = Type.String({
  pattern: RFC3339_UTC_PATTERN,
  description: 'UTC timestamp serialized in RFC 3339 format.',
  examples: ['2026-08-08T12:00:00.000Z'],
});

export const CompletedTransferStatusSchema = Type.Literal('completed', {
  description: 'Completed transfer status.',
});

export const TransactionDirectionSchema = Type.Union(
  [Type.Literal('incoming'), Type.Literal('outgoing')],
  {
    description:
      'Direction of a completed transfer relative to the requested account.',
  },
);

export const NonNegativeMinorUnitAmountSchema = createMinorUnitSchema(
  'nonNegative',
  'Non-negative integer minor units serialized as a canonical decimal string. Zero is allowed for account opening balance, which is the trusted opening-funding boundary.',
  ['0', '2500'],
);

export const PositiveMinorUnitAmountSchema = createMinorUnitSchema(
  'positive',
  'Positive integer minor units serialized as a canonical decimal string. Zero is not allowed for transfers.',
  ['1', '2500'],
);

export type AccountId = Static<typeof AccountIdSchema>;
export type TransferId = Static<typeof TransferIdSchema>;
export type CurrencyCode = Static<typeof CurrencyCodeSchema>;
export type IdempotencyKey = Static<typeof IdempotencyKeySchema>;
export type Timestamp = Static<typeof TimestampSchema>;
export type CompletedTransferStatus = Static<
  typeof CompletedTransferStatusSchema
>;
export type TransactionDirection = Static<typeof TransactionDirectionSchema>;
export type NonNegativeMinorUnitAmount = Static<
  typeof NonNegativeMinorUnitAmountSchema
>;
export type PositiveMinorUnitAmount = Static<
  typeof PositiveMinorUnitAmountSchema
>;

export const validateMinorUnitString = (
  value: unknown,
  mode: MinorUnitMode,
): value is string => {
  if (typeof value !== 'string') {
    return false;
  }

  if (!new RegExp(CANONICAL_INTEGER_STRING_PATTERN).test(value)) {
    return false;
  }

  if (mode === 'positive' && value === '0') {
    return false;
  }

  if (value.length > MAX_MINOR_UNITS.length) {
    return false;
  }

  if (value.length === MAX_MINOR_UNITS.length && value > MAX_MINOR_UNITS) {
    return false;
  }

  return true;
};

function createMinorUnitSchema(
  minimumMode: MinorUnitMode,
  description: string,
  examples: string[],
): TSchema {
  return Type.Unsafe<string>({
    [Kind]: MINOR_UNIT_STRING_KIND,
    minimumMode,
    type: 'string',
    pattern: CANONICAL_INTEGER_STRING_PATTERN,
    minLength: 1,
    maxLength: MAX_MINOR_UNITS.length,
    description,
    examples,
    'x-money-format': 'minor-unit-string',
    'x-money-maximum': MAX_MINOR_UNITS,
  });
}
