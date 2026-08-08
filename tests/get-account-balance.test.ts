import { describe, expect, it, vi } from 'vitest';

import {
  AccountNotFoundError,
  getAccountBalance,
} from '../src/services/get-account-balance.js';

describe('section 7 account balance use case', () => {
  it('returns the existing account ID, exact balance, and USD', async () => {
    const findAccountById = vi.fn().mockResolvedValue({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });

    const execute = getAccountBalance({ findAccountById });

    await expect(
      execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).resolves.toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
    });

    expect(findAccountById).toHaveBeenCalledTimes(1);
    expect(findAccountById).toHaveBeenCalledWith(
      '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
    );
  });

  it('preserves zero and maximum BIGINT balances exactly', async () => {
    const findAccountById = vi
      .fn()
      .mockResolvedValueOnce({
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '0',
        currency: 'USD',
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:00:00.000Z',
      })
      .mockResolvedValueOnce({
        accountId: '7c8382a9-2e0c-4506-a338-8b944fd46b95',
        balance: '9223372036854775807',
        currency: 'USD',
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:00:00.000Z',
      });

    const execute = getAccountBalance({ findAccountById });

    await expect(
      execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).resolves.toMatchObject({
      balance: '0',
    });
    await expect(
      execute('7c8382a9-2e0c-4506-a338-8b944fd46b95'),
    ).resolves.toMatchObject({
      balance: '9223372036854775807',
    });

    expect(findAccountById).toHaveBeenCalledTimes(2);
  });

  it('throws a typed not-found error for a missing account', async () => {
    const execute = getAccountBalance({
      findAccountById: vi.fn().mockResolvedValue(null),
    });

    await expect(
      execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('preserves unexpected repository failures for application handling', async () => {
    const failure = new Error('database offline');
    const execute = getAccountBalance({
      findAccountById: vi.fn().mockRejectedValue(failure),
    });

    await expect(execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a')).rejects.toBe(
      failure,
    );
  });
});
