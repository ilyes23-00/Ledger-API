import { describe, expect, it, vi } from 'vitest';

import { createAccount } from '../src/services/create-account.js';

describe('section 6 account creation use case', () => {
  it('generates the account UUID server-side and returns the persisted record', async () => {
    const persistAccount = vi.fn().mockResolvedValue({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });

    const execute = createAccount({
      generateAccountId: () => '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      persistAccount,
    });

    await expect(
      execute({
        currency: 'USD',
        initialBalance: '2500',
      }),
    ).resolves.toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
      createdAt: '2026-08-08T12:00:00.000Z',
    });

    expect(persistAccount).toHaveBeenCalledWith({
      id: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
    });
  });
});
