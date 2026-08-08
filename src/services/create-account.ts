import { randomUUID } from 'node:crypto';

import type { AccountId, Timestamp } from '../contracts/index.js';
import type { InsertAccountParams, PersistedAccount } from '../db/index.js';
import type { DatabaseQueryable } from '../db/shared.js';

export type CreateAccountInput = {
  currency: 'USD';
  initialBalance: string;
};

export type CreateAccountResult = {
  accountId: AccountId;
  balance: string;
  currency: 'USD';
  createdAt: Timestamp;
};

export type CreateAccountDependencies = {
  generateAccountId?: () => string;
  persistAccount: (params: InsertAccountParams) => Promise<PersistedAccount>;
};

export const createAccount =
  (
    dependencies: CreateAccountDependencies,
  ): ((input: CreateAccountInput) => Promise<CreateAccountResult>) =>
  async (input) => {
    const persistedAccount = await dependencies.persistAccount({
      id: inputAccountId(dependencies),
      balance: input.initialBalance,
      currency: input.currency,
    });

    return {
      accountId: persistedAccount.accountId,
      balance: String(persistedAccount.balance),
      currency: persistedAccount.currency,
      createdAt: persistedAccount.createdAt,
    };
  };

const inputAccountId = (dependencies: CreateAccountDependencies): string =>
  (dependencies.generateAccountId ?? randomUUID)();

export const createAccountWithDatabase = (
  persistAccount: (
    queryable: DatabaseQueryable,
    params: InsertAccountParams,
  ) => Promise<PersistedAccount>,
  queryable: DatabaseQueryable,
) =>
  createAccount({
    persistAccount: (params) => persistAccount(queryable, params),
  });
