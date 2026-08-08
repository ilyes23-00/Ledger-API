import { describe, expect, it, vi } from 'vitest';

import {
  EqualAccountIdsError,
  canonicalizeTransferRequest,
  createTransfer,
  createTransferFingerprint,
} from '../src/services/create-transfer.js';

describe('section 8 transfer canonicalization and fingerprinting', () => {
  it('normalizes UUID casing before fingerprinting and produces deterministic SHA-256 output', () => {
    const canonicalRequest = canonicalizeTransferRequest({
      sourceAccountId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amount: '2500',
      currency: 'USD',
    });

    const repeatedFingerprint = createTransferFingerprint({
      sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amount: '2500',
      currency: 'USD',
    });

    expect(canonicalRequest).toEqual({
      sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amount: '2500',
      currency: 'USD',
    });
    expect(createTransferFingerprint(canonicalRequest)).toBe(
      repeatedFingerprint,
    );
    expect(repeatedFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects equal normalized account identifiers before opening a transaction', () => {
    expect(() =>
      canonicalizeTransferRequest({
        sourceAccountId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        destinationAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        amount: '1',
        currency: 'USD',
      }),
    ).toThrow(EqualAccountIdsError);
  });

  it('does not open a transaction for equal account IDs', async () => {
    const connect = vi.fn();
    const execute = createTransfer({
      transactionPool: { connect },
      insertTransferIfAbsent: vi.fn(),
      findTransferByIdempotencyKey: vi.fn(),
      lockAccountsById: vi.fn(),
      updateAccountBalance: vi.fn(),
    });

    await expect(
      execute({
        idempotencyKey: 'transfer.20260808:no-transaction',
        sourceAccountId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        destinationAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        amount: '1',
        currency: 'USD',
      }),
    ).rejects.toBeInstanceOf(EqualAccountIdsError);

    expect(connect).not.toHaveBeenCalled();
  });

  it('configures bounded transaction-local statement, lock, and idle-in-transaction timeouts before transfer SQL', async () => {
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const connect = vi.fn().mockResolvedValue({ query, release });
    const execute = createTransfer({
      transactionPool: { connect },
      insertTransferIfAbsent: vi.fn().mockResolvedValue({
        transferId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        idempotencyKey: 'transfer.20260808:timeout-config',
        requestFingerprint: 'a'.repeat(64),
        sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        amount: '1',
        currency: 'USD',
        status: 'completed',
        createdAt: '2026-08-08T12:00:00.000Z',
      }),
      findTransferByIdempotencyKey: vi.fn(),
      lockAccountsById: vi.fn().mockResolvedValue([
        {
          accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          balance: '5',
          currency: 'USD',
        },
        {
          accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          balance: '0',
          currency: 'USD',
        },
      ]),
      updateAccountBalance: vi.fn().mockResolvedValue(undefined),
      transactionTimeouts: {
        statementTimeoutMs: 1200,
        lockTimeoutMs: 800,
        idleInTransactionSessionTimeoutMs: 900,
      },
    });

    await execute({
      idempotencyKey: 'transfer.20260808:timeout-config',
      sourceAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      destinationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amount: '1',
      currency: 'USD',
    });

    expect(query.mock.calls.slice(0, 5)).toEqual([
      ['BEGIN'],
      ['SELECT set_config($1, $2, true)', ['statement_timeout', '1200ms']],
      ['SELECT set_config($1, $2, true)', ['lock_timeout', '800ms']],
      [
        'SELECT set_config($1, $2, true)',
        ['idle_in_transaction_session_timeout', '900ms'],
      ],
      ['SET CONSTRAINTS ALL DEFERRED'],
    ]);
  });
});
