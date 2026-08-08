import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';

describe('createApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs and closes without binding a network port', async () => {
    const closeResources = vi.fn<() => Promise<void>>().mockResolvedValue();

    const app = await createApp({
      logger: false,
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
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
      dependencies: {
        checkDatabaseHealth: () => Promise.resolve({ reachable: true }),
      },
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
});
