CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  balance_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounts_balance_minor_non_negative CHECK (balance_minor >= 0),
  CONSTRAINT accounts_currency_usd_only CHECK (currency = 'USD')
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  source_account_id UUID NOT NULL,
  destination_account_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT transfers_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT transfers_request_fingerprint_sha256_format CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT transfers_amount_minor_positive CHECK (amount_minor > 0),
  CONSTRAINT transfers_currency_usd_only CHECK (currency = 'USD'),
  CONSTRAINT transfers_status_completed_only CHECK (status = 'completed'),
  CONSTRAINT transfers_distinct_accounts CHECK (
    source_account_id <> destination_account_id
  ),
  CONSTRAINT transfers_source_account_id_fkey
    FOREIGN KEY (source_account_id)
    REFERENCES accounts (id)
    ON DELETE RESTRICT,
  CONSTRAINT transfers_destination_account_id_fkey
    FOREIGN KEY (destination_account_id)
    REFERENCES accounts (id)
    ON DELETE RESTRICT
);

CREATE INDEX transfers_source_account_history_idx
  ON transfers (source_account_id, created_at DESC, id DESC);

CREATE INDEX transfers_destination_account_history_idx
  ON transfers (destination_account_id, created_at DESC, id DESC);
