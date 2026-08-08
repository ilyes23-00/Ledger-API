import { createHash, randomUUID } from 'node:crypto';

import { MAX_MINOR_UNITS } from '../contracts/index.js';
import type {
  AccountId,
  CompletedTransferStatus,
  CurrencyCode,
  IdempotencyKey,
  PositiveMinorUnitAmount,
  Timestamp,
  TransferId,
  TransferRequest,
} from '../contracts/index.js';
import type {
  LockedAccount,
  PersistedTransfer,
  TransactionPool,
  TransactionClient,
} from '../db/index.js';
import { executeInTransaction } from '../db/index.js';

const COMPLETED_TRANSFER_STATUS: CompletedTransferStatus = 'completed';
const BIGINT_MAX = BigInt(MAX_MINOR_UNITS);
const DEFAULT_TRANSACTION_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSACTION_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 10_000;

export type CreateTransferInput = TransferRequest & {
  idempotencyKey: IdempotencyKey;
};

export type CreateTransferResult = {
  transferId: TransferId;
  sourceAccountId: AccountId;
  destinationAccountId: AccountId;
  amount: string;
  currency: CurrencyCode;
  status: CompletedTransferStatus;
  createdAt: Timestamp;
};

export type CanonicalTransferRequest = {
  sourceAccountId: AccountId;
  destinationAccountId: AccountId;
  amount: string;
  currency: CurrencyCode;
};

export type CreateTransferDependencies = {
  transactionPool: TransactionPool;
  insertTransferIfAbsent: (
    client: TransactionClient,
    params: {
      id: TransferId;
      idempotencyKey: IdempotencyKey;
      requestFingerprint: string;
      sourceAccountId: AccountId;
      destinationAccountId: AccountId;
      amount: PositiveMinorUnitAmount;
      currency: CurrencyCode;
      status: CompletedTransferStatus;
    },
  ) => Promise<PersistedTransfer | null>;
  findTransferByIdempotencyKey: (
    client: TransactionClient,
    idempotencyKey: IdempotencyKey,
  ) => Promise<PersistedTransfer | null>;
  lockAccountsById: (
    client: TransactionClient,
    firstAccountId: AccountId,
    secondAccountId: AccountId,
  ) => Promise<LockedAccount[]>;
  updateAccountBalance: (
    client: TransactionClient,
    accountId: AccountId,
    nextBalance: string,
  ) => Promise<void>;
  generateTransferId?: () => string;
  transactionTimeouts?: {
    statementTimeoutMs?: number;
    lockTimeoutMs?: number;
    idleInTransactionSessionTimeoutMs?: number;
  };
};

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class UnknownAccountError extends Error {
  readonly code = 'UNKNOWN_ACCOUNT';
}

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
}

export class InsufficientFundsError extends Error {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class BalanceLimitExceededError extends Error {
  readonly code = 'BALANCE_LIMIT_EXCEEDED';
}

export class EqualAccountIdsError extends Error {
  readonly code = 'EQUAL_ACCOUNT_IDS';
}

export const createTransfer =
  (dependencies: CreateTransferDependencies) =>
  async (input: CreateTransferInput): Promise<CreateTransferResult> => {
    const canonicalRequest = canonicalizeTransferRequest(input);
    const requestFingerprint = createTransferFingerprint(canonicalRequest);

    return executeInTransaction(
      dependencies.transactionPool,
      async (client) => {
        await configureTransactionTimeouts(
          client,
          dependencies.transactionTimeouts,
        );

        const insertedTransfer = await dependencies.insertTransferIfAbsent(
          client,
          {
            id: inputTransferId(dependencies),
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            sourceAccountId: canonicalRequest.sourceAccountId,
            destinationAccountId: canonicalRequest.destinationAccountId,
            amount: canonicalRequest.amount,
            currency: canonicalRequest.currency,
            status: COMPLETED_TRANSFER_STATUS,
          },
        );

        if (insertedTransfer === null) {
          const existingTransfer =
            await dependencies.findTransferByIdempotencyKey(
              client,
              input.idempotencyKey,
            );

          if (existingTransfer === null) {
            throw new Error('Existing idempotent transfer row was not found.');
          }

          ensureMatchingPersistedTransfer(
            existingTransfer,
            canonicalRequest,
            requestFingerprint,
          );
          return mapTransferResult(existingTransfer);
        }

        const [firstAccountId, secondAccountId] = sortAccountIds(
          canonicalRequest.sourceAccountId,
          canonicalRequest.destinationAccountId,
        );
        const lockedAccounts = await dependencies.lockAccountsById(
          client,
          firstAccountId,
          secondAccountId,
        );

        if (lockedAccounts.length !== 2) {
          throw new UnknownAccountError('Referenced account does not exist.');
        }

        const lockedAccountById = new Map<AccountId, LockedAccount>(
          lockedAccounts.map((account) => [account.accountId, account]),
        );
        const sourceAccount = lockedAccountById.get(
          canonicalRequest.sourceAccountId,
        );
        const destinationAccount = lockedAccountById.get(
          canonicalRequest.destinationAccountId,
        );

        if (sourceAccount === undefined || destinationAccount === undefined) {
          throw new UnknownAccountError('Referenced account does not exist.');
        }

        if (
          sourceAccount.currency !== canonicalRequest.currency ||
          destinationAccount.currency !== canonicalRequest.currency
        ) {
          throw new CurrencyMismatchError(
            'Source and destination accounts must use the same currency.',
          );
        }

        const amount = BigInt(canonicalRequest.amount);
        const sourceBalance = BigInt(sourceAccount.balance);
        const destinationBalance = BigInt(destinationAccount.balance);

        if (sourceBalance < amount) {
          throw new InsufficientFundsError(
            'Source account balance is insufficient for this transfer.',
          );
        }

        const nextDestinationBalance = destinationBalance + amount;

        if (nextDestinationBalance > BIGINT_MAX) {
          throw new BalanceLimitExceededError(
            'Destination account balance would exceed the maximum supported value.',
          );
        }

        await dependencies.updateAccountBalance(
          client,
          sourceAccount.accountId,
          String(sourceBalance - amount),
        );
        await dependencies.updateAccountBalance(
          client,
          destinationAccount.accountId,
          String(nextDestinationBalance),
        );

        return mapTransferResult(insertedTransfer);
      },
    );
  };

export const canonicalizeTransferRequest = (
  input: TransferRequest,
): CanonicalTransferRequest => {
  const sourceAccountId = input.sourceAccountId.toLowerCase();
  const destinationAccountId = input.destinationAccountId.toLowerCase();

  if (sourceAccountId === destinationAccountId) {
    throw new EqualAccountIdsError(
      'Source and destination accounts must be different.',
    );
  }

  return {
    sourceAccountId,
    destinationAccountId,
    amount: String(input.amount),
    currency: input.currency,
  };
};

export const createTransferFingerprint = (
  input: CanonicalTransferRequest,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.sourceAccountId,
        input.destinationAccountId,
        input.amount,
        input.currency,
      ]),
      'utf8',
    )
    .digest('hex');

const configureTransactionTimeouts = async (
  client: TransactionClient,
  timeouts?: CreateTransferDependencies['transactionTimeouts'],
): Promise<void> => {
  await client.query('SELECT set_config($1, $2, true)', [
    'statement_timeout',
    `${timeouts?.statementTimeoutMs ?? DEFAULT_TRANSACTION_STATEMENT_TIMEOUT_MS}ms`,
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'lock_timeout',
    `${timeouts?.lockTimeoutMs ?? DEFAULT_TRANSACTION_LOCK_TIMEOUT_MS}ms`,
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'idle_in_transaction_session_timeout',
    `${timeouts?.idleInTransactionSessionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS}ms`,
  ]);
  await client.query('SET CONSTRAINTS ALL DEFERRED');
};

const inputTransferId = (
  dependencies: CreateTransferDependencies,
): TransferId => (dependencies.generateTransferId ?? randomUUID)();

const ensureMatchingPersistedTransfer = (
  transfer: PersistedTransfer,
  request: CanonicalTransferRequest,
  requestFingerprint: string,
): void => {
  if (
    transfer.requestFingerprint !== requestFingerprint ||
    transfer.sourceAccountId !== request.sourceAccountId ||
    transfer.destinationAccountId !== request.destinationAccountId ||
    transfer.amount !== request.amount ||
    transfer.currency !== request.currency
  ) {
    throw new IdempotencyConflictError(
      'Idempotency-Key has already been used for a different transfer payload.',
    );
  }
};

const mapTransferResult = (
  persistedTransfer: PersistedTransfer,
): CreateTransferResult => ({
  transferId: persistedTransfer.transferId,
  sourceAccountId: persistedTransfer.sourceAccountId,
  destinationAccountId: persistedTransfer.destinationAccountId,
  amount: persistedTransfer.amount as string,
  currency: persistedTransfer.currency,
  status: persistedTransfer.status,
  createdAt: persistedTransfer.createdAt,
});

const sortAccountIds = (
  firstAccountId: AccountId,
  secondAccountId: AccountId,
): [AccountId, AccountId] =>
  firstAccountId < secondAccountId
    ? [firstAccountId, secondAccountId]
    : [secondAccountId, firstAccountId];
