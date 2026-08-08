import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  TransferResponseSchema,
  isSchemaValueValid,
} from '../src/contracts/index.js';
import {
  CurrencyMismatchError,
  EqualAccountIdsError,
} from '../src/services/create-transfer.js';

describe('section 8 transfer route HTTP behavior', () => {
  it('creates a transfer and forwards the idempotency key to the service', async () => {
    const createTransfer = vi.fn().mockResolvedValue({
      transferId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amount: '2500',
      currency: 'USD',
      status: 'completed',
      createdAt: '2026-08-08T12:00:00.000Z',
    });

    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
        createAccount: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountTransactions: vi.fn(),
        createTransfer,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        'idempotency-key': 'transfer.20260808:acct-001',
      },
      payload: {
        sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        amount: '2500',
        currency: 'USD',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createTransfer).toHaveBeenCalledWith({
      sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amount: '2500',
      currency: 'USD',
      idempotencyKey: 'transfer.20260808:acct-001',
    });
    expect(isSchemaValueValid(TransferResponseSchema, response.json())).toBe(
      true,
    );

    await app.close();
  });

  it('rejects a missing idempotency key before calling the transfer service', async () => {
    const createTransfer = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
        createAccount: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountTransactions: vi.fn(),
        createTransfer,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: {
        sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        amount: '2500',
        currency: 'USD',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
    expect(createTransfer).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects invalid transfer requests before calling the transfer service', async () => {
    const createTransfer = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
        createAccount: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountTransactions: vi.fn(),
        createTransfer,
      },
    });

    const invalidCases = [
      {
        name: 'invalid key',
        headers: { 'idempotency-key': 'short' },
        payload: validPayload(),
        expectedCode: 'INVALID_IDEMPOTENCY_KEY',
      },
      {
        name: 'invalid uuid',
        headers: { 'idempotency-key': 'transfer.20260808:invalid-uuid' },
        payload: {
          ...validPayload(),
          sourceAccountId: 'not-a-uuid',
        },
        expectedCode: 'MALFORMED_UUID',
      },
      {
        name: 'zero amount',
        headers: { 'idempotency-key': 'transfer.20260808:zero' },
        payload: {
          ...validPayload(),
          amount: '0',
        },
        expectedCode: 'ZERO_AMOUNT',
      },
      {
        name: 'negative amount',
        headers: { 'idempotency-key': 'transfer.20260808:negative' },
        payload: {
          ...validPayload(),
          amount: '-1',
        },
        expectedCode: 'NEGATIVE_AMOUNT',
      },
      {
        name: 'malformed amount',
        headers: { 'idempotency-key': 'transfer.20260808:malformed' },
        payload: {
          ...validPayload(),
          amount: '1.5',
        },
        expectedCode: 'FRACTIONAL_AMOUNT',
      },
      {
        name: 'above maximum amount',
        headers: { 'idempotency-key': 'transfer.20260808:unsafe' },
        payload: {
          ...validPayload(),
          amount: '9223372036854775808',
        },
        expectedCode: 'UNSAFE_AMOUNT',
      },
      {
        name: 'non-USD currency',
        headers: { 'idempotency-key': 'transfer.20260808:currency' },
        payload: {
          ...validPayload(),
          currency: 'EUR',
        },
        expectedCode: 'INVALID_CURRENCY',
      },
      {
        name: 'unexpected field',
        headers: { 'idempotency-key': 'transfer.20260808:extra' },
        payload: {
          ...validPayload(),
          note: 'extra',
        },
        expectedCode: 'UNEXPECTED_REQUEST_FIELD',
      },
    ] as const;

    for (const invalidCase of invalidCases) {
      const response = await app.inject({
        method: 'POST',
        url: '/transfers',
        headers: invalidCase.headers,
        payload: invalidCase.payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: invalidCase.expectedCode,
      });
    }

    const malformedJsonResponse = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'transfer.20260808:invalid-json',
      },
      payload: '{"sourceAccountId":',
    });

    expect(malformedJsonResponse.statusCode).toBe(400);
    expect(malformedJsonResponse.json()).toMatchObject({
      code: 'INVALID_JSON',
    });
    expect(createTransfer).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps an equal-account domain error to a safe 400 response', async () => {
    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
        createAccount: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountTransactions: vi.fn(),
        createTransfer: () =>
          Promise.reject(
            new EqualAccountIdsError(
              'same source/destination /Users/macbook/Projects/assigemnet/chekin',
            ),
          ),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        'idempotency-key': 'transfer.20260808:same-account',
      },
      payload: validPayload(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'EQUAL_ACCOUNT_IDS',
      message: 'Source and destination accounts must be different.',
    });
    expect(response.body).not.toContain('/Users/macbook');

    await app.close();
  });

  it('maps a currency mismatch domain error to a safe 409 response', async () => {
    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
        createAccount: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountTransactions: vi.fn(),
        createTransfer: () =>
          Promise.reject(
            new CurrencyMismatchError(
              'source EUR destination USD /Users/macbook/Projects/assigemnet/chekin',
            ),
          ),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        'idempotency-key': 'transfer.20260808:currency-mismatch',
      },
      payload: validPayload(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'CURRENCY_MISMATCH',
      message: 'Source and destination accounts must use the same currency.',
    });
    expect(response.body).not.toContain('/Users/macbook');

    await app.close();
  });

  it('returns a safe 500 response for unexpected transfer failures without leaking internals', async () => {
    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
        createAccount: vi.fn(),
        getAccountBalance: vi.fn(),
        getAccountTransactions: vi.fn(),
        createTransfer: () =>
          Promise.reject(
            new Error(
              'duplicate key value violates unique constraint transfers_idempotency_key_unique at /Users/macbook/Projects/assigemnet/chekin 23505 postgresql://ledger:secret@127.0.0.1:54329/ledger_history_test',
            ),
          ),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        'idempotency-key': 'transfer.20260808:unexpected-transfer-error',
      },
      payload: validPayload(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    });
    expect(response.body).not.toContain('duplicate key');
    expect(response.body).not.toContain('transfers_idempotency_key_unique');
    expect(response.body).not.toContain('23505');
    expect(response.body).not.toContain('postgresql://');
    expect(response.body).not.toContain('/Users/macbook');

    await app.close();
  });
});

const validPayload = () => ({
  sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  amount: '2500',
  currency: 'USD',
});
