import type {
  AccountId,
  CurrencyCode,
  IdempotencyKey,
  Timestamp,
  TransactionDirection,
  TransferId,
} from '../contracts/index.js';
import type {
  CompletedTransferStatus,
  PositiveMinorUnitAmount,
} from '../contracts/index.js';

import type { DatabaseQueryable } from './shared.js';
import { queryOne } from './shared.js';
import {
  assertAccountId,
  assertCompletedTransferStatus,
  assertIdempotencyKey,
  assertTransferId,
  assertValidCurrency,
  assertValidMinorUnitAmount,
  mapDatabaseTimestamp,
} from './values.js';

type TransferRow = {
  id: unknown;
  idempotency_key: unknown;
  request_fingerprint: unknown;
  source_account_id: unknown;
  destination_account_id: unknown;
  amount_minor: unknown;
  currency: unknown;
  status: unknown;
  created_at: unknown;
};

export type PersistedTransfer = {
  transferId: TransferId;
  idempotencyKey: IdempotencyKey;
  requestFingerprint: string;
  sourceAccountId: AccountId;
  destinationAccountId: AccountId;
  amount: PositiveMinorUnitAmount;
  currency: CurrencyCode;
  status: CompletedTransferStatus;
  createdAt: Timestamp;
};

export type InsertTransferParams = {
  id: TransferId;
  idempotencyKey: IdempotencyKey;
  requestFingerprint: string;
  sourceAccountId: AccountId;
  destinationAccountId: AccountId;
  amount: PositiveMinorUnitAmount;
  currency: CurrencyCode;
  status: CompletedTransferStatus;
};

type AccountTransactionHistoryRow = {
  id: unknown;
  source_account_id: unknown;
  destination_account_id: unknown;
  amount_minor: unknown;
  currency: unknown;
  status: unknown;
  direction: unknown;
  created_at: unknown;
};

export type PersistedAccountTransaction = {
  transferId: TransferId;
  sourceAccountId: AccountId;
  destinationAccountId: AccountId;
  amount: PositiveMinorUnitAmount;
  currency: CurrencyCode;
  status: CompletedTransferStatus;
  direction: TransactionDirection;
  createdAt: Timestamp;
};

export const insertTransfer = async (
  queryable: DatabaseQueryable,
  params: InsertTransferParams,
): Promise<PersistedTransfer> => {
  assertValidMinorUnitAmount(params.amount, 'positive');
  assertValidCurrency(params.currency);

  const row = await queryOne<TransferRow>(
    queryable,
    `INSERT INTO transfers (
       id,
       idempotency_key,
       request_fingerprint,
       source_account_id,
       destination_account_id,
       amount_minor,
       currency,
       status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING
       id,
       idempotency_key,
       request_fingerprint,
       source_account_id,
       destination_account_id,
       amount_minor,
       currency,
       status,
       created_at`,
    [
      params.id,
      params.idempotencyKey,
      params.requestFingerprint,
      params.sourceAccountId,
      params.destinationAccountId,
      params.amount,
      params.currency,
      params.status,
    ],
  );

  if (row === null) {
    throw new Error('Transfer insert did not return a row.');
  }

  return mapTransferRow(row);
};

export const insertTransferIfAbsent = async (
  queryable: DatabaseQueryable,
  params: InsertTransferParams,
): Promise<PersistedTransfer | null> => {
  assertValidMinorUnitAmount(params.amount, 'positive');
  assertValidCurrency(params.currency);

  const row = await queryOne<TransferRow>(
    queryable,
    `INSERT INTO transfers (
       id,
       idempotency_key,
       request_fingerprint,
       source_account_id,
       destination_account_id,
       amount_minor,
       currency,
       status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING
       id,
       idempotency_key,
       request_fingerprint,
       source_account_id,
       destination_account_id,
       amount_minor,
       currency,
       status,
       created_at`,
    [
      params.id,
      params.idempotencyKey,
      params.requestFingerprint,
      params.sourceAccountId,
      params.destinationAccountId,
      params.amount,
      params.currency,
      params.status,
    ],
  );

  return row === null ? null : mapTransferRow(row);
};

export const findTransferByIdempotencyKey = async (
  queryable: DatabaseQueryable,
  idempotencyKey: IdempotencyKey,
): Promise<PersistedTransfer | null> => {
  const row = await queryOne<TransferRow>(
    queryable,
    `SELECT
       id,
       idempotency_key,
       request_fingerprint,
       source_account_id,
       destination_account_id,
       amount_minor,
       currency,
       status,
       created_at
     FROM transfers
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );

  return row === null ? null : mapTransferRow(row);
};

export const listAccountTransactions = async (
  queryable: DatabaseQueryable,
  accountId: AccountId,
): Promise<PersistedAccountTransaction[]> => {
  const { rows } = await queryable.query(
    `SELECT
       id,
       source_account_id,
       destination_account_id,
       amount_minor,
       currency,
       status,
       direction,
       created_at
     FROM (
       SELECT
         id,
         source_account_id,
         destination_account_id,
         amount_minor,
         currency,
         status,
         'outgoing'::text AS direction,
         created_at
       FROM transfers
       WHERE source_account_id = $1

       UNION ALL

       SELECT
         id,
         source_account_id,
         destination_account_id,
         amount_minor,
         currency,
         status,
         'incoming'::text AS direction,
         created_at
       FROM transfers
       WHERE destination_account_id = $1
     ) AS account_transfers
     ORDER BY created_at DESC, id DESC`,
    [accountId],
  );

  return rows.map((row) =>
    mapAccountTransactionHistoryRow(row as AccountTransactionHistoryRow),
  );
};

const mapTransferRow = (row: TransferRow): PersistedTransfer => {
  if (typeof row.request_fingerprint !== 'string') {
    throw new Error('Database transfer row fingerprint must be a string.');
  }

  if (!/^[0-9a-f]{64}$/.test(row.request_fingerprint)) {
    throw new Error(
      'Database transfer row fingerprint must be a SHA-256 hex string.',
    );
  }

  if (row.status !== 'completed') {
    throw new Error('Database transfer row status must be completed.');
  }

  return {
    transferId: assertTransferId(row.id),
    idempotencyKey: assertIdempotencyKey(row.idempotency_key),
    requestFingerprint: row.request_fingerprint,
    sourceAccountId: assertAccountId(row.source_account_id),
    destinationAccountId: assertAccountId(row.destination_account_id),
    amount: assertValidMinorUnitAmount(row.amount_minor, 'positive'),
    currency: assertValidCurrency(row.currency),
    status: assertCompletedTransferStatus(row.status),
    createdAt: mapDatabaseTimestamp(row.created_at),
  };
};

const mapAccountTransactionHistoryRow = (
  row: AccountTransactionHistoryRow,
): PersistedAccountTransaction => ({
  transferId: assertTransferId(row.id),
  sourceAccountId: assertAccountId(row.source_account_id),
  destinationAccountId: assertAccountId(row.destination_account_id),
  amount: assertValidMinorUnitAmount(row.amount_minor, 'positive'),
  currency: assertValidCurrency(row.currency),
  status: assertCompletedTransferStatus(row.status),
  direction: assertTransactionDirection(row.direction),
  createdAt: mapDatabaseTimestamp(row.created_at),
});

const assertTransactionDirection = (value: unknown): TransactionDirection => {
  if (value !== 'incoming' && value !== 'outgoing') {
    throw new Error(
      'Database transaction history row direction must be incoming or outgoing.',
    );
  }

  return value;
};
