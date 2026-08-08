import { DatabaseError } from 'pg';

export type ClassifiedDatabaseError =
  | {
      kind: 'unique_violation';
      sqlState: '23505';
      constraint: string | null;
      cause: DatabaseError;
    }
  | {
      kind: 'foreign_key_violation';
      sqlState: '23503';
      constraint: string | null;
      cause: DatabaseError;
    }
  | {
      kind: 'check_violation';
      sqlState: '23514';
      constraint: string | null;
      cause: DatabaseError;
    }
  | {
      kind: 'invalid_text_representation';
      sqlState: '22P02';
      constraint: null;
      cause: DatabaseError;
    }
  | {
      kind: 'numeric_value_out_of_range';
      sqlState: '22003';
      constraint: null;
      cause: DatabaseError;
    }
  | {
      kind: 'deadlock_detected';
      sqlState: '40P01';
      constraint: null;
      cause: DatabaseError;
    }
  | {
      kind: 'serialization_failure';
      sqlState: '40001';
      constraint: null;
      cause: DatabaseError;
    }
  | {
      kind: 'lock_not_available';
      sqlState: '55P03';
      constraint: null;
      cause: DatabaseError;
    }
  | {
      kind: 'query_canceled';
      sqlState: '57014';
      constraint: null;
      cause: DatabaseError;
    };

const SQLSTATE_CLASSIFIERS = {
  '22003': 'numeric_value_out_of_range',
  '22P02': 'invalid_text_representation',
  '23503': 'foreign_key_violation',
  '23505': 'unique_violation',
  '23514': 'check_violation',
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
  '55P03': 'lock_not_available',
  '57014': 'query_canceled',
} as const;

export const classifyDatabaseError = (
  error: unknown,
): ClassifiedDatabaseError | null => {
  if (!(error instanceof DatabaseError)) {
    return null;
  }

  const kind =
    SQLSTATE_CLASSIFIERS[error.code as keyof typeof SQLSTATE_CLASSIFIERS];

  if (kind === undefined) {
    return null;
  }

  switch (kind) {
    case 'unique_violation':
      return {
        kind,
        sqlState: '23505',
        constraint: error.constraint ?? null,
        cause: error,
      };
    case 'foreign_key_violation':
      return {
        kind,
        sqlState: '23503',
        constraint: error.constraint ?? null,
        cause: error,
      };
    case 'check_violation':
      return {
        kind,
        sqlState: '23514',
        constraint: error.constraint ?? null,
        cause: error,
      };
    case 'invalid_text_representation':
      return {
        kind,
        sqlState: '22P02',
        constraint: null,
        cause: error,
      };
    case 'numeric_value_out_of_range':
      return {
        kind,
        sqlState: '22003',
        constraint: null,
        cause: error,
      };
    case 'deadlock_detected':
      return {
        kind,
        sqlState: '40P01',
        constraint: null,
        cause: error,
      };
    case 'serialization_failure':
      return {
        kind,
        sqlState: '40001',
        constraint: null,
        cause: error,
      };
    case 'lock_not_available':
      return {
        kind,
        sqlState: '55P03',
        constraint: null,
        cause: error,
      };
    case 'query_canceled':
      return {
        kind,
        sqlState: '57014',
        constraint: null,
        cause: error,
      };
  }
};
