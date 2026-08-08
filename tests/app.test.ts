import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError } from 'pg';

import { createApp } from '../src/app.js';
import {
  AccountBalanceResponseSchema,
  AccountTransactionHistoryResponseSchema,
  CreateAccountResponseSchema,
  isSchemaValueValid,
  MAX_MINOR_UNITS,
} from '../src/contracts/index.js';
import type {
  CreateAccountInput,
  CreateAccountResult,
} from '../src/services/create-account.js';
import { AccountNotFoundError } from '../src/services/get-account-balance.js';
import type { GetAccountBalanceResult } from '../src/services/get-account-balance.js';
import type { GetAccountTransactionsResult } from '../src/services/get-account-transactions.js';
import type {
  CreateTransferInput,
  CreateTransferResult,
} from '../src/services/create-transfer.js';

describe('createApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createDependencies = (overrides?: {
    createAccount?: (input: CreateAccountInput) => Promise<CreateAccountResult>;
    getAccountBalance?: (accountId: string) => Promise<GetAccountBalanceResult>;
    getAccountTransactions?: (
      accountId: string,
    ) => Promise<GetAccountTransactionsResult>;
    createTransfer?: (
      input: CreateTransferInput,
    ) => Promise<CreateTransferResult>;
  }) => ({
    checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
    createAccount:
      overrides?.createAccount ??
      (() =>
        Promise.resolve({
          accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
          balance: '2500',
          currency: 'USD' as const,
          createdAt: '2026-08-08T12:00:00.000Z',
        })),
    getAccountBalance:
      overrides?.getAccountBalance ??
      ((accountId) =>
        Promise.resolve({
          accountId,
          balance: '2500',
          currency: 'USD' as const,
        })),
    getAccountTransactions:
      overrides?.getAccountTransactions ??
      ((accountId) =>
        Promise.resolve({
          accountId,
          transactions: [],
        })),
    createTransfer: overrides?.createTransfer ?? vi.fn(),
  });

  it('constructs and closes without binding a network port', async () => {
    const closeResources = vi.fn<() => Promise<void>>().mockResolvedValue();

    const app = await createApp({
      logger: false,
      dependencies: {
        ...createDependencies(),
        closeResources,
      },
    });

    expect(app.server.listening).toBe(false);
    expect(app.server.timeout).toBe(5000);
    expect(app.server.requestTimeout).toBe(10000);
    expect(app.server.keepAliveTimeout).toBe(72000);

    await app.close();

    expect(closeResources).toHaveBeenCalledTimes(1);
  });

  it('returns a healthy response when the database is reachable', async () => {
    const app = await createApp({
      logger: false,
      dependencies: createDependencies(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      database: {
        reachable: true,
      },
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });

  it('returns an unhealthy response when the database is unreachable', async () => {
    const app = await createApp({
      logger: false,
      dependencies: {
        ...createDependencies(),
        checkDatabaseHealth: () => Promise.resolve({ reachable: false }),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'error',
      database: {
        reachable: false,
      },
    });

    await app.close();
  });

  it('returns a safe 503 response when a handler exceeds the configured lifecycle timeout', async () => {
    const app = await createApp({
      logger: false,
      server: {
        handlerTimeoutMs: 25,
      },
      dependencies: createDependencies({
        getAccountBalance: async () => {
          await delay(100);
          return {
            accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
            balance: '2500',
            currency: 'USD',
          };
        },
      }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    });

    await app.close();
  });

  it('applies configured HTTP connection and request timeouts to the underlying Node server', async () => {
    const app = await createApp({
      logger: false,
      server: {
        connectionTimeoutMs: 2100,
        requestTimeoutMs: 3100,
      },
      dependencies: createDependencies(),
    });

    expect(app.server.timeout).toBe(2100);
    expect(app.server.requestTimeout).toBe(3100);
    expect(app.server.keepAliveTimeout).toBe(72000);

    await app.close();
  });

  it('does not accept unexpected query parameters on endpoints that define none', async () => {
    const createAccount = vi.fn();
    const getAccountBalance = vi.fn();
    const getAccountTransactions = vi.fn();
    const createTransfer = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({
        createAccount,
        getAccountBalance,
        getAccountTransactions,
        createTransfer,
      }),
    });

    const createAccountResponse = await app.inject({
      method: 'POST',
      url: '/accounts?unexpected=value',
      payload: {
        currency: 'USD',
        initialBalance: '2500',
      },
    });

    expect(createAccountResponse.statusCode).toBe(400);
    expect(createAccountResponse.json()).toMatchObject({
      code: 'INVALID_REQUEST_BODY',
    });
    expect(createAccount).not.toHaveBeenCalled();

    const balanceResponse = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance?unexpected=value',
    });

    expect(balanceResponse.statusCode).toBe(400);
    expect(balanceResponse.json()).toMatchObject({
      code: 'INVALID_REQUEST_BODY',
    });
    expect(getAccountBalance).not.toHaveBeenCalled();

    const transactionsResponse = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/transactions?unexpected=value',
    });

    expect(transactionsResponse.statusCode).toBe(400);
    expect(transactionsResponse.json()).toMatchObject({
      code: 'INVALID_REQUEST_BODY',
    });
    expect(getAccountTransactions).not.toHaveBeenCalled();

    const transferResponse = await app.inject({
      method: 'POST',
      url: '/transfers?unexpected=value',
      headers: {
        'idempotency-key': 'transfer.20260808:query-reject',
      },
      payload: {
        sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        amount: '2500',
        currency: 'USD',
      },
    });

    expect(transferResponse.statusCode).toBe(400);
    expect(transferResponse.json()).toMatchObject({
      code: 'INVALID_REQUEST_BODY',
    });
    expect(createTransfer).not.toHaveBeenCalled();

    await app.close();
  });

  it('creates an account and returns the persisted response', async () => {
    const createAccount = vi.fn(() =>
      Promise.resolve({
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '2500',
        currency: 'USD' as const,
        createdAt: '2026-08-08T12:00:00.000Z',
      }),
    );
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ createAccount }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        currency: 'USD',
        initialBalance: '2500',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createAccount).toHaveBeenCalledWith({
      currency: 'USD',
      initialBalance: '2500',
    });
    const responseBody = response.json<unknown>();

    expect(isSchemaValueValid(CreateAccountResponseSchema, responseBody)).toBe(
      true,
    );

    await app.close();
  });

  it('accepts zero and maximum opening balances', async () => {
    const createAccount = vi
      .fn()
      .mockResolvedValueOnce({
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '0',
        currency: 'USD' as const,
        createdAt: '2026-08-08T12:00:00.000Z',
      })
      .mockResolvedValueOnce({
        accountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
        balance: MAX_MINOR_UNITS,
        currency: 'USD' as const,
        createdAt: '2026-08-08T12:01:00.000Z',
      });
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ createAccount }),
    });

    const zeroResponse = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        currency: 'USD',
        initialBalance: '0',
      },
    });
    const maxResponse = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        currency: 'USD',
        initialBalance: MAX_MINOR_UNITS,
      },
    });

    expect(zeroResponse.statusCode).toBe(201);
    const zeroBody = zeroResponse.json<{ balance: string }>();
    const maxBody = maxResponse.json<{ balance: string }>();

    expect(zeroBody.balance).toBe('0');
    expect(maxResponse.statusCode).toBe(201);
    expect(maxBody.balance).toBe(MAX_MINOR_UNITS);

    await app.close();
  });

  it('returns an existing account balance that matches the balance schema', async () => {
    const getAccountBalance = vi.fn((accountId: string) =>
      Promise.resolve({
        accountId,
        balance: '2500',
        currency: 'USD' as const,
      }),
    );
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountBalance }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });

    expect(response.statusCode).toBe(200);
    expect(getAccountBalance).toHaveBeenCalledTimes(1);
    expect(getAccountBalance).toHaveBeenCalledWith(
      '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
    );

    const responseBody = response.json<unknown>();
    expect(isSchemaValueValid(AccountBalanceResponseSchema, responseBody)).toBe(
      true,
    );
    expect(responseBody).toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
    });

    await app.close();
  });

  it('returns zero and maximum balances exactly for the balance endpoint', async () => {
    const getAccountBalance = vi
      .fn()
      .mockResolvedValueOnce({
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '0',
        currency: 'USD' as const,
      })
      .mockResolvedValueOnce({
        accountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
        balance: MAX_MINOR_UNITS,
        currency: 'USD' as const,
      });
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountBalance }),
    });

    const zeroResponse = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });
    const maxResponse = await app.inject({
      method: 'GET',
      url: '/accounts/7c8382a9-2e0c-4506-a338-8b944fd46b95/balance',
    });

    expect(zeroResponse.statusCode).toBe(200);
    expect(zeroResponse.json()).toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '0',
      currency: 'USD',
    });
    expect(maxResponse.statusCode).toBe(200);
    expect(maxResponse.json()).toEqual({
      accountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
      balance: MAX_MINOR_UNITS,
      currency: 'USD',
    });

    await app.close();
  });

  it('returns a safe 404 response for an unknown account balance request', async () => {
    const getAccountBalance = vi.fn(() =>
      Promise.reject(
        new AccountNotFoundError('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
      ),
    );
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountBalance }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });

    expect(response.statusCode).toBe(404);
    const responseBody = response.json<{
      code: string;
      message: string;
      requestId: string;
    }>();
    expect(responseBody.code).toBe('UNKNOWN_ACCOUNT');
    expect(responseBody.message).toBe('Referenced account does not exist.');
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);

    await app.close();
  });

  it('rejects malformed account UUIDs before calling the balance service', async () => {
    const getAccountBalance = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountBalance }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/not-a-uuid/balance',
    });

    expect(response.statusCode).toBe(400);
    const responseBody = response.json<{
      code: string;
      message: string;
      requestId: string;
    }>();
    expect(responseBody.code).toBe('MALFORMED_UUID');
    expect(responseBody.message).toBe(
      'Account identifier must be a valid UUID.',
    );
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);
    expect(getAccountBalance).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns a safe 500 response for unexpected balance lookup failures', async () => {
    const databaseError = new DatabaseError(
      'relation "accounts" does not exist',
      0,
      'error',
    );
    databaseError.code = '42P01';

    const app = await createApp({
      logger: false,
      dependencies: createDependencies({
        getAccountBalance: () => Promise.reject(databaseError),
      }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });

    expect(response.statusCode).toBe(500);
    const responseBody = response.json<{
      code: string;
      message: string;
      requestId: string;
    }>();
    expect(responseBody.code).toBe('INTERNAL_ERROR');
    expect(responseBody.message).toBe('An unexpected internal error occurred.');
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('relation');
    expect(response.body).not.toContain('accounts');
    expect(response.body).not.toContain('stack');
    expect(response.body).not.toContain('sql');

    await app.close();
  });

  it('reads the balance on every request for the same account', async () => {
    const getAccountBalance = vi.fn((accountId: string) =>
      Promise.resolve({
        accountId,
        balance: '2500',
        currency: 'USD' as const,
      }),
    );
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountBalance }),
    });

    const firstResponse = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });
    const secondResponse = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/balance',
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(getAccountBalance).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('returns transaction history with the documented response shape', async () => {
    const getAccountTransactions = vi.fn((accountId: string) =>
      Promise.resolve({
        accountId,
        transactions: [
          {
            transferId: '6c20e9be-1ca5-4dc4-8f73-cb72794d4c6a',
            sourceAccountId: accountId,
            destinationAccountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
            amount: '1250',
            currency: 'USD' as const,
            status: 'completed' as const,
            direction: 'outgoing' as const,
            createdAt: '2026-08-08T12:00:00.000Z',
          },
        ],
      }),
    );
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountTransactions }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/transactions',
    });

    expect(response.statusCode).toBe(200);
    expect(getAccountTransactions).toHaveBeenCalledWith(
      '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
    );
    expect(
      isSchemaValueValid(
        AccountTransactionHistoryResponseSchema,
        response.json<unknown>(),
      ),
    ).toBe(true);

    await app.close();
  });

  it('returns empty history for an account with no transfers', async () => {
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({
        getAccountTransactions: (accountId) =>
          Promise.resolve({
            accountId,
            transactions: [],
          }),
      }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/transactions',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      transactions: [],
    });

    await app.close();
  });

  it('rejects malformed account UUIDs before calling the transaction history service', async () => {
    const getAccountTransactions = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({ getAccountTransactions }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/not-a-uuid/transactions',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'MALFORMED_UUID',
      message: 'Account identifier must be a valid UUID.',
    });
    expect(getAccountTransactions).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns safe 404 and 500 responses for transaction history lookups', async () => {
    const databaseError = new DatabaseError(
      'select * from transfers failed at /internal/path',
      0,
      'error',
    );
    databaseError.code = '42P01';

    const notFoundApp = await createApp({
      logger: false,
      dependencies: createDependencies({
        getAccountTransactions: () =>
          Promise.reject(
            new AccountNotFoundError('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
          ),
      }),
    });

    const notFoundResponse = await notFoundApp.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/transactions',
    });

    expect(notFoundResponse.statusCode).toBe(404);
    expect(notFoundResponse.json()).toMatchObject({
      code: 'UNKNOWN_ACCOUNT',
      message: 'Referenced account does not exist.',
    });

    await notFoundApp.close();

    const failureApp = await createApp({
      logger: false,
      dependencies: createDependencies({
        getAccountTransactions: () => Promise.reject(databaseError),
      }),
    });

    const failureResponse = await failureApp.inject({
      method: 'GET',
      url: '/accounts/6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a/transactions',
    });

    expect(failureResponse.statusCode).toBe(500);
    expect(failureResponse.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
    });
    expect(failureResponse.body).not.toContain('select *');
    expect(failureResponse.body).not.toContain('/internal/path');
    expect(failureResponse.body).not.toContain('42P01');
    expect(failureResponse.body).not.toContain('stack');

    await failureApp.close();
  });

  it.each([
    [{ initialBalance: '2500' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'AED', initialBalance: '2500' }, 'INVALID_CURRENCY'],
    [{ currency: 'EUR', initialBalance: '2500' }, 'INVALID_CURRENCY'],
    [{ currency: 'usd', initialBalance: '2500' }, 'INVALID_CURRENCY'],
    [{ currency: 'Usd', initialBalance: '2500' }, 'INVALID_CURRENCY'],
    [{ currency: 'ZZZ', initialBalance: '2500' }, 'INVALID_CURRENCY'],
    [{ currency: 'USD', initialBalance: '-1' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: '+1' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: '1.25' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: '1e3' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: ' 1' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: '01' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: '' }, 'INVALID_REQUEST_BODY'],
    [{ currency: 'USD', initialBalance: 'abc' }, 'INVALID_REQUEST_BODY'],
    [
      { currency: 'USD', initialBalance: '9223372036854775808' },
      'INVALID_REQUEST_BODY',
    ],
    [{ currency: 'USD', initialBalance: 2500 }, 'INVALID_REQUEST_BODY'],
    [
      {
        accountId: '11111111-1111-4111-8111-111111111111',
        currency: 'USD',
        initialBalance: '2500',
      },
      'UNEXPECTED_REQUEST_FIELD',
    ],
  ])(
    'rejects invalid request payload %j with a safe 400 response',
    async (payload, expectedCode) => {
      const createAccount = vi.fn();
      const app = await createApp({
        logger: false,
        dependencies: createDependencies({
          createAccount,
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/accounts',
        payload,
      });

      const responseBody = response.json<{
        code: string;
        message: string;
        requestId: string;
      }>();

      expect(response.statusCode).toBe(400);
      expect(responseBody.code).toBe(expectedCode);
      expect(typeof responseBody.message).toBe('string');
      expect(responseBody.message.length).toBeGreaterThan(0);
      expect(typeof responseBody.requestId).toBe('string');
      expect(responseBody.requestId.length).toBeGreaterThan(0);
      expect(createAccount).not.toHaveBeenCalled();

      await app.close();
    },
  );

  it('rejects malformed JSON with a safe 400 response', async () => {
    const createAccount = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({
        createAccount,
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{"currency":"USD","initialBalance":"2500"',
    });

    expect(response.statusCode).toBe(400);
    const responseBody = response.json<{
      code: string;
      message: string;
      requestId: string;
    }>();

    expect(responseBody.code).toBe('INVALID_JSON');
    expect(responseBody.message).toBe('Request body must contain valid JSON.');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);
    expect(createAccount).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns a safe 413 response when the JSON body exceeds the application limit', async () => {
    const createAccount = vi.fn();
    const app = await createApp({
      logger: false,
      dependencies: createDependencies({
        createAccount,
      }),
    });

    const oversizedBalance = '9'.repeat(17_000);
    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        currency: 'USD',
        initialBalance: oversizedBalance,
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size.',
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
    expect(createAccount).not.toHaveBeenCalled();
    expect(response.body).not.toContain('Fastify');
    expect(response.body).not.toContain('FST_ERR');

    await app.close();
  });

  it('keeps permissive CORS headers disabled for ordinary and preflight-style requests', async () => {
    const app = await createApp({
      logger: false,
      dependencies: createDependencies(),
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'https://example.com',
      },
    });
    expect(getResponse.headers['access-control-allow-origin']).toBeUndefined();

    const optionsResponse = await app.inject({
      method: 'OPTIONS',
      url: '/accounts',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(
      optionsResponse.headers['access-control-allow-origin'],
    ).toBeUndefined();
    expect(
      optionsResponse.headers['access-control-allow-methods'],
    ).toBeUndefined();

    await app.close();
  });

  it('returns a safe 500 response for unexpected persistence failures', async () => {
    const databaseError = new DatabaseError('duplicate key', 0, 'error');
    databaseError.code = '23505';
    databaseError.constraint = 'accounts_pkey';

    const app = await createApp({
      logger: false,
      dependencies: createDependencies({
        createAccount: () => Promise.reject(databaseError),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        currency: 'USD',
        initialBalance: '2500',
      },
    });

    expect(response.statusCode).toBe(500);
    const responseBody = response.json<{
      code: string;
      message: string;
      requestId: string;
    }>();

    expect(responseBody.code).toBe('INTERNAL_ERROR');
    expect(responseBody.message).toBe('An unexpected internal error occurred.');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('duplicate key');
    expect(response.body).not.toContain('accounts_pkey');
    expect(response.body).not.toContain('sql');
    expect(response.body).not.toContain('stack');

    await app.close();
  });

  it('emits structured JSON logs with request IDs while keeping sensitive values absent or redacted', async () => {
    const stream = new PassThrough();
    const logLines: string[] = [];
    const sensitiveAuthorizationValue = 'Bearer top-secret-token';
    const sensitiveCookieValue = 'session=super-secret-cookie';
    const sensitiveDatabaseUrl =
      'postgresql://ledger:super-secret-password@db.internal:5432/ledger_history_test';

    stream.on('data', (chunk: Buffer | string) => {
      logLines.push(String(chunk));
    });

    const app = await createApp({
      logger: {
        level: 'info',
        stream,
      },
      dependencies: {
        ...createDependencies(),
        createTransfer: () => Promise.reject(new Error('boom')),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        'idempotency-key': 'transfer.20260808:log-safety-001',
        authorization: sensitiveAuthorizationValue,
        cookie: sensitiveCookieValue,
      },
      payload: {
        sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        amount: '2500',
        currency: 'USD',
      },
    });

    expect(response.statusCode).toBe(500);

    await app.close();

    const combinedLogs = logLines.join('');
    const responseBody = response.json<{
      requestId: string;
    }>();
    const parsedLines = logLines
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(parsedLines.length).toBeGreaterThan(0);
    expect(parsedLines.every((line) => typeof line['time'] === 'number')).toBe(
      true,
    );
    expect(
      parsedLines.some((line) => line['reqId'] === responseBody.requestId),
    ).toBe(true);
    expect(
      parsedLines.some(
        (line) =>
          line['msg'] === 'Unexpected request failure.' &&
          typeof line['err'] === 'object',
      ),
    ).toBe(true);
    expect(combinedLogs).toContain(responseBody.requestId);
    expect(combinedLogs).not.toContain('"amount":"2500"');
    expect(combinedLogs).not.toContain('transfer.20260808:log-safety-001');
    expect(combinedLogs).not.toContain(sensitiveAuthorizationValue);
    expect(combinedLogs).not.toContain(sensitiveCookieValue);
    expect(combinedLogs).not.toContain('top-secret-token');
    expect(combinedLogs).not.toContain('super-secret-cookie');
    expect(combinedLogs).not.toContain('super-secret-password');
    expect(combinedLogs).not.toContain(sensitiveDatabaseUrl);
  });
});
