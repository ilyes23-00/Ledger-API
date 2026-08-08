import type {
  AccountId,
  CurrencyCode,
  PositiveMinorUnitAmount,
  Timestamp,
  TransactionDirection,
  TransferId,
} from '../contracts/index.js';
import type {
  PersistedAccount,
  PersistedAccountTransaction,
} from '../db/index.js';
import type { DatabaseQueryable } from '../db/shared.js';

import { AccountNotFoundError } from './get-account-balance.js';

export type AccountTransactionHistoryItem = {
  transferId: TransferId;
  sourceAccountId: AccountId;
  destinationAccountId: AccountId;
  amount: PositiveMinorUnitAmount;
  currency: CurrencyCode;
  status: 'completed';
  direction: TransactionDirection;
  createdAt: Timestamp;
};

export type GetAccountTransactionsResult = {
  accountId: AccountId;
  transactions: AccountTransactionHistoryItem[];
};

export type GetAccountTransactionsDependencies = {
  findAccountById: (accountId: AccountId) => Promise<PersistedAccount | null>;
  listAccountTransactions: (
    accountId: AccountId,
  ) => Promise<PersistedAccountTransaction[]>;
};

export const getAccountTransactions =
  (dependencies: GetAccountTransactionsDependencies) =>
  async (accountId: AccountId): Promise<GetAccountTransactionsResult> => {
    const account = await dependencies.findAccountById(accountId);

    if (account === null) {
      throw new AccountNotFoundError(accountId);
    }

    const transactions = await dependencies.listAccountTransactions(accountId);

    return {
      accountId: account.accountId,
      transactions: transactions.map((transaction) => ({
        transferId: transaction.transferId,
        sourceAccountId: transaction.sourceAccountId,
        destinationAccountId: transaction.destinationAccountId,
        amount: transaction.amount,
        currency: transaction.currency,
        status: transaction.status,
        direction: transaction.direction,
        createdAt: transaction.createdAt,
      })),
    };
  };

export const getAccountTransactionsWithDatabase = (
  findAccountById: (
    queryable: DatabaseQueryable,
    accountId: AccountId,
  ) => Promise<PersistedAccount | null>,
  listAccountTransactions: (
    queryable: DatabaseQueryable,
    accountId: AccountId,
  ) => Promise<PersistedAccountTransaction[]>,
  queryable: DatabaseQueryable,
) =>
  getAccountTransactions({
    findAccountById: (accountId) => findAccountById(queryable, accountId),
    listAccountTransactions: (accountId) =>
      listAccountTransactions(queryable, accountId),
  });
