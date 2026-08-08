ALTER TABLE transfers
  DROP CONSTRAINT transfers_source_account_id_fkey,
  DROP CONSTRAINT transfers_destination_account_id_fkey;

ALTER TABLE transfers
  ADD CONSTRAINT transfers_source_account_id_fkey
    FOREIGN KEY (source_account_id)
    REFERENCES accounts (id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT transfers_destination_account_id_fkey
    FOREIGN KEY (destination_account_id)
    REFERENCES accounts (id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;
