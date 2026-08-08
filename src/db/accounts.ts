import {
  MAX_MINOR_UNITS,
  type AccountId,
  type CurrencyCode,
  type NonNegativeMinorUnitAmount,
  type Timestamp,
} from '../contracts/index.js';

import type { DatabaseQueryable } from './shared.js';
import { queryOne } from './shared.js';
import {
  assertAccountId,
  assertValidCurrency,
  assertValidMinorUnitAmount,
  mapDatabaseTimestamp,
} from './values.js';

type AccountRow = {
  id: unknown;
  balance_minor: unknown;
  currency: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export type PersistedAccount = {
  accountId: AccountId;
  balance: NonNegativeMinorUnitAmount;
  currency: CurrencyCode;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type InsertAccountParams = {
  id: AccountId;
  balance: NonNegativeMinorUnitAmount;
  currency: CurrencyCode;
};

type LockedAccountRow = {
  id: unknown;
  balance_minor: unknown;
  currency: unknown;
};

export type LockedAccount = {
  accountId: AccountId;
  balance: string;
  currency: CurrencyCode;
};

export const insertAccount = async (
  queryable: DatabaseQueryable,
  params: InsertAccountParams,
): Promise<PersistedAccount> => {
  assertValidMinorUnitAmount(params.balance, 'nonNegative');
  assertValidCurrency(params.currency);

  const row = await queryOne<AccountRow>(
    queryable,
    `INSERT INTO accounts (
       id,
       balance_minor,
       currency
     ) VALUES ($1, $2, $3)
     RETURNING
       id,
       balance_minor,
       currency,
       created_at,
       updated_at`,
    [params.id, params.balance, params.currency],
  );

  if (row === null) {
    throw new Error('Account insert did not return a row.');
  }

  return mapAccountRow(row);
};

export const findAccountById = async (
  queryable: DatabaseQueryable,
  accountId: AccountId,
): Promise<PersistedAccount | null> => {
  const row = await queryOne<AccountRow>(
    queryable,
    `SELECT
       id,
       balance_minor,
       currency,
       created_at,
       updated_at
     FROM accounts
     WHERE id = $1`,
    [accountId],
  );

  return row === null ? null : mapAccountRow(row);
};

export const lockAccountsById = async (
  queryable: DatabaseQueryable,
  firstAccountId: AccountId,
  secondAccountId: AccountId,
): Promise<LockedAccount[]> => {
  const { rows } = await queryable.query(
    `SELECT id, balance_minor, currency
     FROM accounts
     WHERE id = ANY($1::uuid[])
     ORDER BY id ASC
     FOR UPDATE`,
    [[firstAccountId, secondAccountId]],
  );

  return rows.map((row) => mapLockedAccountRow(row as LockedAccountRow));
};

export const updateAccountBalance = async (
  queryable: DatabaseQueryable,
  accountId: AccountId,
  nextBalance: NonNegativeMinorUnitAmount,
): Promise<void> => {
  const { rows } = await queryable.query(
    `UPDATE accounts
     SET balance_minor = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id`,
    [accountId, nextBalance],
  );

  if (rows.length !== 1) {
    throw new Error('Account balance update affected an unexpected row count.');
  }
};

const mapAccountRow = (row: AccountRow): PersistedAccount => {
  return {
    accountId: assertAccountId(row.id),
    balance: assertValidMinorUnitAmount(row.balance_minor, 'nonNegative'),
    currency: assertValidCurrency(row.currency),
    createdAt: mapDatabaseTimestamp(row.created_at),
    updatedAt: mapDatabaseTimestamp(row.updated_at),
  };
};

const mapLockedAccountRow = (row: LockedAccountRow): LockedAccount => {
  const balance = assertValidMinorUnitAmount(
    row.balance_minor,
    'nonNegative',
  ) as string;

  if (balance.length > MAX_MINOR_UNITS.length || balance > MAX_MINOR_UNITS) {
    throw new Error(
      'Locked account balance exceeds the supported BIGINT limit.',
    );
  }

  return {
    accountId: assertAccountId(row.id),
    balance,
    currency: assertValidCurrency(row.currency),
  };
};
