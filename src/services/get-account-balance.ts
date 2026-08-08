import type {
  AccountId,
  NonNegativeMinorUnitAmount,
} from '../contracts/index.js';
import type { PersistedAccount } from '../db/index.js';
import type { DatabaseQueryable } from '../db/shared.js';

export type GetAccountBalanceResult = {
  accountId: AccountId;
  balance: NonNegativeMinorUnitAmount;
  currency: 'USD';
};

export type GetAccountBalanceDependencies = {
  findAccountById: (accountId: AccountId) => Promise<PersistedAccount | null>;
};

export class AccountNotFoundError extends Error {
  readonly code = 'UNKNOWN_ACCOUNT';

  constructor(accountId: AccountId) {
    super(`Account ${accountId} was not found.`);
    this.name = 'AccountNotFoundError';
  }
}

export const getAccountBalance =
  (
    dependencies: GetAccountBalanceDependencies,
  ): ((accountId: AccountId) => Promise<GetAccountBalanceResult>) =>
  async (accountId) => {
    const account = await dependencies.findAccountById(accountId);

    if (account === null) {
      throw new AccountNotFoundError(accountId);
    }

    return {
      accountId: account.accountId,
      balance: account.balance,
      currency: account.currency,
    };
  };

export const getAccountBalanceWithDatabase = (
  findAccountById: (
    queryable: DatabaseQueryable,
    accountId: AccountId,
  ) => Promise<PersistedAccount | null>,
  queryable: DatabaseQueryable,
) =>
  getAccountBalance({
    findAccountById: (accountId) => findAccountById(queryable, accountId),
  });
