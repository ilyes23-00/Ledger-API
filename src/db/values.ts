import {
  AccountIdSchema,
  CompletedTransferStatusSchema,
  IdempotencyKeySchema,
  isSchemaValueValid,
  TransferIdSchema,
  type AccountId,
  type CompletedTransferStatus,
  validateMinorUnitString,
  type CurrencyCode,
  type IdempotencyKey,
  type NonNegativeMinorUnitAmount,
  type PositiveMinorUnitAmount,
  type Timestamp,
  type TransferId,
} from '../contracts/index.js';

type MinorUnitMode = 'nonNegative' | 'positive';

export const assertValidCurrency = (value: unknown): CurrencyCode => {
  if (value !== 'USD') {
    throw new Error('Currency value must be the exact literal USD.');
  }

  return value;
};

export const assertAccountId = (value: unknown): AccountId => {
  if (!isSchemaValueValid(AccountIdSchema, value)) {
    throw new Error('Value must be a valid account UUID.');
  }

  return value as AccountId;
};

export const assertTransferId = (value: unknown): TransferId => {
  if (!isSchemaValueValid(TransferIdSchema, value)) {
    throw new Error('Value must be a valid transfer UUID.');
  }

  return value as TransferId;
};

export const assertIdempotencyKey = (value: unknown): IdempotencyKey => {
  if (!isSchemaValueValid(IdempotencyKeySchema, value)) {
    throw new Error('Value must satisfy the idempotency-key schema.');
  }

  return value as IdempotencyKey;
};

export const assertCompletedTransferStatus = (
  value: unknown,
): CompletedTransferStatus => {
  if (!isSchemaValueValid(CompletedTransferStatusSchema, value)) {
    throw new Error('Value must be the completed transfer status.');
  }

  return value as CompletedTransferStatus;
};

export function assertValidMinorUnitAmount(
  value: unknown,
  mode: 'nonNegative',
): NonNegativeMinorUnitAmount;
export function assertValidMinorUnitAmount(
  value: unknown,
  mode: 'positive',
): PositiveMinorUnitAmount;
export function assertValidMinorUnitAmount(
  value: unknown,
  mode: MinorUnitMode,
): string {
  if (!validateMinorUnitString(value, mode)) {
    throw new Error(`Invalid ${mode} minor-unit amount.`);
  }

  return value;
}

export const mapDatabaseTimestamp = (value: unknown): Timestamp => {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error('Database timestamp must be a valid Date.');
  }

  return value.toISOString();
};
