import { describe, expect, it, vi } from 'vitest';

import { AccountNotFoundError } from '../src/services/get-account-balance.js';
import { getAccountTransactions } from '../src/services/get-account-transactions.js';

describe('section 9 transaction history use case', () => {
  it('returns empty history for an existing account with no transfers', async () => {
    const findAccountById = vi.fn().mockResolvedValue({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      balance: '2500',
      currency: 'USD',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:00:00.000Z',
    });
    const listAccountTransactions = vi.fn().mockResolvedValue([]);

    const execute = getAccountTransactions({
      findAccountById,
      listAccountTransactions,
    });

    await expect(
      execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).resolves.toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      transactions: [],
    });

    expect(findAccountById).toHaveBeenCalledTimes(1);
    expect(listAccountTransactions).toHaveBeenCalledWith(
      '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
    );
  });

  it('maps incoming, outgoing, mixed, exact money strings, and deterministic ordering', async () => {
    const execute = getAccountTransactions({
      findAccountById: vi.fn().mockResolvedValue({
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '2500',
        currency: 'USD',
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:00:00.000Z',
      }),
      listAccountTransactions: vi.fn().mockResolvedValue([
        {
          transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          destinationAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
          amount: '9223372036854775807',
          currency: 'USD',
          status: 'completed',
          direction: 'incoming',
          createdAt: '2026-08-08T12:00:00.000Z',
        },
        {
          transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
          destinationAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          amount: '1',
          currency: 'USD',
          status: 'completed',
          direction: 'outgoing',
          createdAt: '2026-08-08T12:00:00.000Z',
        },
      ]),
    });

    await expect(
      execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).resolves.toEqual({
      accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
      transactions: [
        {
          transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          destinationAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
          amount: '9223372036854775807',
          currency: 'USD',
          status: 'completed',
          direction: 'incoming',
          createdAt: '2026-08-08T12:00:00.000Z',
        },
        {
          transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceAccountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
          destinationAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          amount: '1',
          currency: 'USD',
          status: 'completed',
          direction: 'outgoing',
          createdAt: '2026-08-08T12:00:00.000Z',
        },
      ],
    });
  });

  it('throws a typed not-found error for a missing account', async () => {
    const execute = getAccountTransactions({
      findAccountById: vi.fn().mockResolvedValue(null),
      listAccountTransactions: vi.fn(),
    });

    await expect(
      execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('preserves repository failures and does not invoke history lookup for unknown accounts', async () => {
    const failure = new Error('database offline');
    const findAccountById = vi.fn().mockResolvedValue(null);
    const listAccountTransactions = vi.fn().mockRejectedValue(failure);

    const missingExecute = getAccountTransactions({
      findAccountById,
      listAccountTransactions,
    });

    await expect(
      missingExecute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a'),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(listAccountTransactions).not.toHaveBeenCalled();

    const execute = getAccountTransactions({
      findAccountById: vi.fn().mockResolvedValue({
        accountId: '6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a',
        balance: '2500',
        currency: 'USD',
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:00:00.000Z',
      }),
      listAccountTransactions: vi.fn().mockRejectedValue(failure),
    });

    await expect(execute('6f73d5a4-5d2e-4e7c-a7f7-0b4a7625df5a')).rejects.toBe(
      failure,
    );
  });
});
