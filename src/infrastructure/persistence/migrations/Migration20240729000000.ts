import { Migration } from "@mikro-orm/migrations";

export class Migration20240729000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(19, 2) NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets (id),
        player_id UUID NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind VARCHAR(32) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(32) NOT NULL,
        reference_transaction_id UUID,
        failure_code VARCHAR(64),
        processed_at TIMESTAMPTZ,
        observed_balance_amount NUMERIC(19, 2),
        observed_balance_currency VARCHAR(3),
        reference_retry_attempts INTEGER NOT NULL DEFAULT 0,
        next_reference_attempt_at TIMESTAMPTZ,
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_kind_check CHECK (
          kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        CONSTRAINT wager_transactions_status_check CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        CONSTRAINT wager_transactions_amount_non_negative CHECK (amount >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_reversal_per_reference
      ON wager_transactions (reference_transaction_id)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND status = 'PROCESSED'
        AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
      ON wager_transactions (status, next_reference_attempt_at)
      WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets (id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
        direction VARCHAR(16) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before_amount NUMERIC(19, 2) NOT NULL,
        balance_before_currency VARCHAR(3) NOT NULL,
        balance_after_amount NUMERIC(19, 2) NOT NULL,
        balance_after_currency VARCHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallet_ledger_entries_transaction_unique UNIQUE (transaction_id),
        CONSTRAINT wallet_ledger_entries_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + amount)
          OR
          (direction = 'DEBIT' AND balance_after_amount = balance_before_amount - amount)
        ),
        CONSTRAINT wallet_ledger_entries_currency_consistent CHECK (
          currency = balance_before_currency AND currency = balance_after_currency
        )
      );
    `);

    this.addSql(`
      CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id TEXT NOT NULL,
        consumer_name TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
    `);

    this.addSql(`
      CREATE INDEX outbox_messages_pending_idx
      ON outbox_messages (occurred_at)
      WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
