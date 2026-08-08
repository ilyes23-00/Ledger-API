import { describe, expect, it } from 'vitest';

import {
  EnvironmentValidationError,
  loadEnvironment,
} from '../src/config/env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  APP_HOST: '127.0.0.1',
  APP_PORT: '3000',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'ledger',
  DATABASE_USER: 'ledger',
  DATABASE_PASSWORD: 'secret',
  DATABASE_POOL_MAX: '10',
  DATABASE_POOL_MIN: '0',
  DATABASE_POOL_IDLE_TIMEOUT_MS: '30000',
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: '5000',
} satisfies NodeJS.ProcessEnv;

describe('loadEnvironment', () => {
  it('accepts valid configuration', () => {
    const environment = loadEnvironment(validEnvironment);

    expect(environment.server.port).toBe(3000);
    expect(environment.database.poolMax).toBe(10);
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
        DATABASE_POOL_MIN: '101',
        DATABASE_POOL_MAX: '10',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [EnvironmentValidationError: Invalid environment configuration:
      - APP_PORT must be between 1 and 65535
      - DATABASE_POOL_MIN must be between 0 and 100
      - DATABASE_POOL_MIN must be less than or equal to DATABASE_POOL_MAX]
    `);
  });
});
