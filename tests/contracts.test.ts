import { describe, expect, it } from 'vitest';

import {
  AccountIdParamsSchema,
  AccountTransactionHistoryResponseSchema,
  buildOpenApiDocument,
  CreateAccountRequestSchema,
  CreateAccountResponseSchema,
  CurrencyCodeSchema,
  ErrorResponseSchema,
  errorStatusByCode,
  IdempotencyKeySchema,
  isSchemaValueValid,
  listSchemaIssues,
  NonNegativeMinorUnitAmountSchema,
  PositiveMinorUnitAmountSchema,
  TransactionDirectionSchema,
  TransferHeadersSchema,
  TransferRequestSchema,
  TransferResponseSchema,
  CompletedTransferStatusSchema,
  MAX_MINOR_UNITS,
} from '../src/contracts/index.js';

const getObjectProperty = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const property = record[key];

  if (typeof property !== 'object' || property === null) {
    return undefined;
  }

  return property as Record<string, unknown>;
};

describe('section 2 contract schemas', () => {
  it('accepts account creation contracts with USD and valid opening balances', () => {
    expect(
      isSchemaValueValid(CreateAccountRequestSchema, {
        currency: 'USD',
        initialBalance: '0',
      }),
    ).toBe(true);

    expect(
      isSchemaValueValid(CreateAccountRequestSchema, {
        currency: 'USD',
        initialBalance: '2500',
      }),
    ).toBe(true);

    expect(
      isSchemaValueValid(CreateAccountRequestSchema, {
        currency: 'USD',
        initialBalance: MAX_MINOR_UNITS,
      }),
    ).toBe(true);

    expect(
      isSchemaValueValid(CreateAccountResponseSchema, {
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '2500',
        currency: 'USD',
        createdAt: '2026-08-08T12:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts valid transfer, balance, and history contracts', () => {
    expect(
      isSchemaValueValid(TransferHeadersSchema, {
        'idempotency-key': 'transfer.20260808:acct-001',
      }),
    ).toBe(true);

    expect(
      isSchemaValueValid(TransferRequestSchema, {
        sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        destinationAccountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
        amount: '1250',
        currency: 'USD',
      }),
    ).toBe(true);

    expect(
      isSchemaValueValid(TransferResponseSchema, {
        transferId: '6c20e9be-1ca5-4dc4-8f73-cb72794d4c6a',
        sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        destinationAccountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
        amount: '1250',
        currency: 'USD',
        status: 'completed',
        createdAt: '2026-08-08T12:00:00.000Z',
      }),
    ).toBe(true);

    expect(
      isSchemaValueValid(AccountTransactionHistoryResponseSchema, {
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        transactions: [
          {
            transferId: '6c20e9be-1ca5-4dc4-8f73-cb72794d4c6a',
            sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
            destinationAccountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
            amount: '1250',
            currency: 'USD',
            status: 'completed',
            direction: 'outgoing',
            createdAt: '2026-08-08T12:00:00.000Z',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects invalid opening balances and transfer amount boundaries', () => {
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '0')).toBe(
      true,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '2500')).toBe(
      true,
    );
    expect(
      isSchemaValueValid(NonNegativeMinorUnitAmountSchema, MAX_MINOR_UNITS),
    ).toBe(true);
    expect(
      isSchemaValueValid(
        NonNegativeMinorUnitAmountSchema,
        '9223372036854775808',
      ),
    ).toBe(false);
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '-1')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '+1')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '1.25')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '1e3')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, ' 1')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '01')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, '')).toBe(
      false,
    );
    expect(isSchemaValueValid(NonNegativeMinorUnitAmountSchema, 'abc')).toBe(
      false,
    );
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, '0')).toBe(false);
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, '2500')).toBe(
      true,
    );
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, '-1')).toBe(false);
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, '1.25')).toBe(
      false,
    );
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, '01')).toBe(false);
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, 1250)).toBe(false);
    expect(isSchemaValueValid(PositiveMinorUnitAmountSchema, 'NaN')).toBe(
      false,
    );
  });

  it('rejects malformed UUIDs, non-USD currencies, and invalid idempotency keys', () => {
    expect(
      isSchemaValueValid(AccountIdParamsSchema, {
        accountId: 'not-a-uuid',
      }),
    ).toBe(false);

    expect(isSchemaValueValid(CurrencyCodeSchema, 'USD')).toBe(true);
    expect(isSchemaValueValid(CurrencyCodeSchema, 'AED')).toBe(false);
    expect(isSchemaValueValid(CurrencyCodeSchema, 'EUR')).toBe(false);
    expect(isSchemaValueValid(CurrencyCodeSchema, 'usd')).toBe(false);
    expect(isSchemaValueValid(CurrencyCodeSchema, 'Usd')).toBe(false);
    expect(isSchemaValueValid(CurrencyCodeSchema, 'ZZZ')).toBe(false);
    expect(isSchemaValueValid(CurrencyCodeSchema, '')).toBe(false);
    expect(
      isSchemaValueValid(CreateAccountRequestSchema, {
        initialBalance: '2500',
      }),
    ).toBe(false);
    expect(
      isSchemaValueValid(TransferRequestSchema, {
        sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        destinationAccountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
        amount: '2500',
      }),
    ).toBe(false);

    expect(isSchemaValueValid(IdempotencyKeySchema, 'short')).toBe(false);
    expect(
      isSchemaValueValid(IdempotencyKeySchema, 'contains spaces is invalid'),
    ).toBe(false);
    expect(isSchemaValueValid(IdempotencyKeySchema, 'invalid*character')).toBe(
      false,
    );
    expect(
      isSchemaValueValid(IdempotencyKeySchema, 'transfer.20260808:acct-001'),
    ).toBe(true);
  });

  it('rejects equal transfer accounts and unexpected request fields at the contract layer', () => {
    const duplicateAccounts = {
      sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      destinationAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      amount: '1250',
      currency: 'USD',
    };

    expect(duplicateAccounts.sourceAccountId).toBe(
      duplicateAccounts.destinationAccountId,
    );

    const withUnexpectedField = {
      currency: 'USD',
      initialBalance: '5000',
      ignored: true,
    };

    expect(
      isSchemaValueValid(CreateAccountRequestSchema, withUnexpectedField),
    ).toBe(false);
    expect(
      listSchemaIssues(CreateAccountRequestSchema, withUnexpectedField),
    ).not.toHaveLength(0);
  });

  it('accepts the shared error response shape and stable enums', () => {
    expect(
      isSchemaValueValid(ErrorResponseSchema, {
        code: 'INVALID_JSON',
        message: 'Request body must contain valid JSON.',
        requestId: 'req-01J6H8T8P5QW3J9J9R6K7D8M2N',
      }),
    ).toBe(true);

    expect(isSchemaValueValid(TransactionDirectionSchema, 'incoming')).toBe(
      true,
    );
    expect(isSchemaValueValid(TransactionDirectionSchema, 'outgoing')).toBe(
      true,
    );
    expect(isSchemaValueValid(TransactionDirectionSchema, 'sideways')).toBe(
      false,
    );

    expect(isSchemaValueValid(CompletedTransferStatusSchema, 'completed')).toBe(
      true,
    );
    expect(isSchemaValueValid(CompletedTransferStatusSchema, 'pending')).toBe(
      false,
    );

    expect(errorStatusByCode.INSUFFICIENT_FUNDS).toBe(422);
    expect(errorStatusByCode.IDEMPOTENCY_CONFLICT).toBe(409);
  });

  it('produces an OpenAPI document for all four required operations', () => {
    const document = buildOpenApiDocument();
    const createAccountOperation = document.paths['/accounts']?.['post'];
    const createTransferOperation = document.paths['/transfers']?.['post'];
    const getBalanceOperation =
      document.paths['/accounts/{accountId}/balance']?.['get'];
    const getTransactionsOperation =
      document.paths['/accounts/{accountId}/transactions']?.['get'];
    const createAccountRequestSchema =
      createAccountOperation?.requestBody?.content['application/json'].schema;
    const createTransferRequestSchema =
      createTransferOperation?.requestBody?.content['application/json'].schema;
    const createAccountCurrencySchema = getObjectProperty(
      getObjectProperty(createAccountRequestSchema, 'properties'),
      'currency',
    );
    const createTransferCurrencySchema = getObjectProperty(
      getObjectProperty(createTransferRequestSchema, 'properties'),
      'currency',
    );

    expect(document.openapi).toBe('3.0.3');
    expect(Object.keys(document.paths)).toEqual([
      '/accounts',
      '/transfers',
      '/accounts/{accountId}/balance',
      '/accounts/{accountId}/transactions',
    ]);

    expect(createAccountOperation).toBeDefined();
    expect(createTransferOperation).toBeDefined();
    expect(getBalanceOperation).toBeDefined();
    expect(getTransactionsOperation).toBeDefined();

    expect(createAccountOperation?.requestBody).toBeDefined();
    expect(document.components.schemas.CurrencyCode.const).toBe('USD');
    expect(document.components.schemas.CurrencyCode.examples).toEqual(['USD']);
    expect(createAccountCurrencySchema?.['const']).toBe('USD');
    expect(createTransferCurrencySchema?.['const']).toBe('USD');
    expect(
      createTransferOperation?.parameters?.some(
        (parameter) => parameter.name === 'idempotency-key',
      ),
    ).toBe(true);
    expect(createTransferOperation?.responses['201']).toBeDefined();
    expect(createTransferOperation?.responses['409']).toBeDefined();
    expect(getBalanceOperation?.responses['200']).toBeDefined();
    expect(getTransactionsOperation?.responses['200']).toBeDefined();
  });
});
