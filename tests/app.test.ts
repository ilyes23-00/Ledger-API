import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError } from 'pg';

import { createApp } from '../src/app.js';
import {
  CreateAccountResponseSchema,
  isSchemaValueValid,
  MAX_MINOR_UNITS,
} from '../src/contracts/index.js';
import type {
  CreateAccountInput,
  CreateAccountResult,
} from '../src/services/create-account.js';

describe('createApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createDependencies = (overrides?: {
    createAccount?: (input: CreateAccountInput) => Promise<CreateAccountResult>;
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

    await app.close();
  });

  it('returns an unhealthy response when the database is unreachable', async () => {
    const app = await createApp({
      logger: false,
      dependencies: {
        createAccount: createDependencies().createAccount,
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
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);
    expect(createAccount).not.toHaveBeenCalled();

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
    expect(typeof responseBody.requestId).toBe('string');
    expect(responseBody.requestId.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('duplicate key');
    expect(response.body).not.toContain('accounts_pkey');
    expect(response.body).not.toContain('sql');
    expect(response.body).not.toContain('stack');

    await app.close();
  });
});
