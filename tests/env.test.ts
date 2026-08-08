import { describe, expect, it } from 'vitest';

import {
  EnvironmentValidationError,
  loadEnvironment,
} from '../src/config/env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  APP_HOST: '127.0.0.1',
  APP_PORT: '3000',
  APP_CONNECTION_TIMEOUT_MS: '5000',
  APP_REQUEST_TIMEOUT_MS: '10000',
  APP_HANDLER_TIMEOUT_MS: '15000',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'ledger',
  DATABASE_USER: 'ledger',
  DATABASE_PASSWORD: 'secret',
  DATABASE_POOL_MAX: '10',
  DATABASE_POOL_MIN: '0',
  DATABASE_POOL_IDLE_TIMEOUT_MS: '30000',
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_STATEMENT_TIMEOUT_MS: '15000',
  DATABASE_LOCK_TIMEOUT_MS: '5000',
  DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: '10000',
} satisfies NodeJS.ProcessEnv;

describe('loadEnvironment', () => {
  it('accepts valid configuration', () => {
    const environment = loadEnvironment(validEnvironment);

    expect(environment.server.port).toBe(3000);
    expect(environment.server.connectionTimeoutMs).toBe(5000);
    expect(environment.server.requestTimeoutMs).toBe(10000);
    expect(environment.server.handlerTimeoutMs).toBe(15000);
    expect(environment.database.poolMax).toBe(10);
    expect(environment.database.statementTimeoutMs).toBe(15000);
    expect(environment.nodeEnv).toBe('test');
  });

  it('rejects missing required values', () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        DATABASE_HOST: '',
        DATABASE_PASSWORD: undefined,
      }),
    ).toThrowError(EnvironmentValidationError);
  });

  it('rejects invalid numeric bounds', () => {
    expect(() =>
      loadEnvironment({
        ...validEnvironment,
        APP_PORT: '70000',
        APP_CONNECTION_TIMEOUT_MS: '999999',
        APP_REQUEST_TIMEOUT_MS: '999999',
        DATABASE_POOL_MIN: '101',
        DATABASE_POOL_MAX: '10',
        DATABASE_LOCK_TIMEOUT_MS: '15000',
        DATABASE_STATEMENT_TIMEOUT_MS: '15000',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [EnvironmentValidationError: Invalid environment configuration:
      - APP_PORT must be between 1 and 65535
      - APP_REQUEST_TIMEOUT_MS must be between 1000 and 120000
      - APP_CONNECTION_TIMEOUT_MS must be between 1000 and 120000
      - DATABASE_POOL_MIN must be between 0 and 100
      - DATABASE_POOL_MIN must be less than or equal to DATABASE_POOL_MAX
      - DATABASE_LOCK_TIMEOUT_MS must be less than DATABASE_STATEMENT_TIMEOUT_MS]
    `);
  });

  it.each([
    'APP_CONNECTION_TIMEOUT_MS',
    'APP_REQUEST_TIMEOUT_MS',
    'APP_HANDLER_TIMEOUT_MS',
    'DATABASE_POOL_IDLE_TIMEOUT_MS',
    'DATABASE_POOL_CONNECTION_TIMEOUT_MS',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_LOCK_TIMEOUT_MS',
    'DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
  ] as const)('rejects zero, negative, and malformed values for %s', (key) => {
    for (const invalidValue of ['0', '-1', 'not-a-number']) {
      expect(() =>
        loadEnvironment({
          ...validEnvironment,
          [key]: invalidValue,
        }),
      ).toThrowError(EnvironmentValidationError);
    }
  });
});
