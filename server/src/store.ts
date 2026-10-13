import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  Device,
  EntitlementClaimsV2,
  Invoice,
  InvoiceKind,
  IssuedEntitlement,
  Plan,
  Subscription,
  WalletJournalEntry
} from './domain.js'
import { moneyFromStorage, moneyToStorage } from './money.js'

export interface NewInvoice {
  id: string
  characterId: string
  characterName: string
  receiverCharacterId: string
  kind: InvoiceKind
  planId: string | null
  amountMinor: bigint
  durationSeconds: number | null
  paymentCode: string
  createdAt: number
  expiresAt: number
}

export interface StoredPayment {
  journalId: string
  cashierCharacterId: string
  payerCharacterId: string | null
  amountMinor: bigint | null
  reason: string | null
  refType: string
  occurredAt: number
  status: 'received' | 'matched' | 'ignored'
  statusReason: string | null
  invoiceId: string | null
}

export interface LedgerEntry {
  id: string
  characterId: string
  deltaMinor: bigint
  kind: 'payment' | 'subscription_charge' | 'renewal_charge' | 'adjustment'
  invoiceId: string | null
  paymentJournalId: string | null
  subscriptionId: string | null
  note: string
  createdAt: number
}

export interface WalletPollState {
  cashierCharacterId: string
  etag: string | null
  lastModified: string | null
  nextPollAt: number
  consecutiveFailures: number
  updatedAt: number
}

export interface BillingStore {
  close(): void
  transaction<T>(work: () => T): T
  immediateTransaction<T>(work: () => T): T
  upsertPlan(plan: Plan): void
  listPlans(enabledOnly?: boolean): Plan[]
  getPlan(id: string): Plan | null
  createInvoice(invoice: NewInvoice): Invoice
  getInvoice(id: string): Invoice | null
  markInvoiceExpired(id: string): boolean
  findInvoiceByPaymentCode(code: string): (Invoice & { durationSeconds: number | null }) | null
  findPayableInvoicesForPayment(input: {
    payerCharacterId: string
    receiverCharacterId: string
    amountMinor: bigint
    occurredAt: number
  }): Array<Invoice & { durationSeconds: number | null }>
  markInvoicePaid(id: string, journalId: string, paidAt: number): boolean
  insertPayment(entry: WalletJournalEntry, cashierId: string, payerId: string | null, occurredAt: number): boolean
  getPayment(journalId: string): StoredPayment | null
  finishPayment(journalId: string, status: 'matched' | 'ignored', reason: string, invoiceId: string | null): void
  getCreditBalance(characterId: string): bigint
  postLedger(entry: LedgerEntry): boolean
  getSubscriptionForCharacter(characterId: string): Subscription | null
  getSubscription(id: string): Subscription | null
  saveSubscription(subscription: Subscription): void
  listRenewableSubscriptions(cutoff: number): Subscription[]
  registerDevice(input: {
    characterId: string
    deviceCode: string
    label: string | null
    now: number
    maxActive: number
  }): Device
  listDevices(characterId: string, activeOnly?: boolean): Device[]
  getDevice(id: string): Device | null
  getDeviceByCode(characterId: string, deviceCode: string): Device | null
  revokeDevice(id: string, characterId: string, now: number): boolean
  getEntitlement(subscriptionId: string, deviceId: string): IssuedEntitlement | null
  saveEntitlement(entitlement: IssuedEntitlement): void
  deleteEntitlement(subscriptionId: string, deviceId: string): void
  getWalletPollState(cashierCharacterId: string): WalletPollState | null
  saveWalletPollState(state: WalletPollState): void
}

export class SqliteBillingStore implements BillingStore {
  readonly database: Database.Database

  constructor(path = ':memory:') {
    const resolvedPath = path === ':memory:' ? null : resolve(path)
    if (resolvedPath) {
      const directory = dirname(resolvedPath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }
    const previousUmask = resolvedPath ? process.umask(0o077) : null
    try {
      this.database = new Database(path)
    } finally {
      if (previousUmask !== null) process.umask(previousUmask)
    }
    this.database.pragma('foreign_keys = ON')
    this.database.pragma('busy_timeout = 5000')
    if (path !== ':memory:') this.database.pragma('journal_mode = WAL')
    if (resolvedPath) {
      for (const candidate of [resolvedPath, `${resolvedPath}-wal`, `${resolvedPath}-shm`]) {
        if (existsSync(candidate)) chmodSync(candidate, 0o600)
      }
    }
    this.migrate()
  }

  close(): void {
    this.database.close()
  }

  transaction<T>(work: () => T): T {
    return this.database.transaction(work)()
  }

  immediateTransaction<T>(work: () => T): T {
    return this.database.transaction(work).immediate()
  }

  upsertPlan(plan: Plan): void {
    this.database.prepare(`
      INSERT INTO plans (id, name, price_minor, duration_seconds, features_json, enabled)
      VALUES (@id, @name, @priceMinor, @durationSeconds, @featuresJson, @enabled)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        price_minor = excluded.price_minor,
        duration_seconds = excluded.duration_seconds,
        features_json = excluded.features_json,
        enabled = excluded.enabled
    `).run({
      id: plan.id,
      name: plan.name,
      priceMinor: moneyToStorage(plan.priceMinor),
      durationSeconds: plan.durationSeconds,
      featuresJson: JSON.stringify([...plan.features]),
      enabled: plan.enabled ? 1 : 0
    })
  }

  listPlans(enabledOnly = false): Plan[] {
    const sql = enabledOnly
      ? 'SELECT * FROM plans WHERE enabled = 1 ORDER BY price_minor + 0, id'
      : 'SELECT * FROM plans ORDER BY price_minor + 0, id'
    return this.database.prepare(sql).all().map(toPlan)
  }

  getPlan(id: string): Plan | null {
    const row = this.database.prepare('SELECT * FROM plans WHERE id = ?').get(id)
    return row ? toPlan(row) : null
  }

  createInvoice(invoice: NewInvoice): Invoice {
    this.database.prepare(`
      INSERT INTO invoices (
        id, character_id, character_name, receiver_character_id, kind, plan_id,
        amount_minor, duration_seconds, payment_code, status, created_at, expires_at
      ) VALUES (
        @id, @characterId, @characterName, @receiverCharacterId, @kind, @planId,
        @amountMinor, @durationSeconds, @paymentCode, 'pending', @createdAt, @expiresAt
      )
    `).run({ ...invoice, amountMinor: moneyToStorage(invoice.amountMinor) })
    return requireValue(this.getInvoice(invoice.id), 'Failed to read newly created invoice')
  }

  getInvoice(id: string): Invoice | null {
    const row = this.database.prepare('SELECT * FROM invoices WHERE id = ?').get(id)
    return row ? toInvoice(row) : null
  }

  markInvoiceExpired(id: string): boolean {
    const result = this.database.prepare(`
      UPDATE invoices SET status = 'expired'
      WHERE id = ? AND status = 'pending'
    `).run(id)
    return result.changes === 1
  }

  findInvoiceByPaymentCode(code: string): (Invoice & { durationSeconds: number | null }) | null {
    const row = this.database.prepare(`
      SELECT * FROM invoices
      WHERE payment_code = ? COLLATE NOCASE
      LIMIT 1
    `).get(code)
    if (!row) return null
    const record = asRecord(row)
    return { ...toInvoice(row), durationSeconds: nullableInteger(record.duration_seconds) }
  }

  findPayableInvoicesForPayment(input: {
    payerCharacterId: string
    receiverCharacterId: string
    amountMinor: bigint
    occurredAt: number
  }): Array<Invoice & { durationSeconds: number | null }> {
    return this.database.prepare(`
      SELECT * FROM invoices
      WHERE character_id = ?
        AND receiver_character_id = ?
        AND amount_minor = ?
        AND status IN ('pending', 'expired')
        AND payment_journal_id IS NULL
        AND created_at - 300 <= ?
        AND expires_at >= ?
      ORDER BY created_at, id
      LIMIT 2
    `).all(
      input.payerCharacterId,
      input.receiverCharacterId,
      moneyToStorage(input.amountMinor),
      input.occurredAt,
      input.occurredAt
    ).map((row) => {
      const record = asRecord(row)
      return { ...toInvoice(row), durationSeconds: nullableInteger(record.duration_seconds) }
    })
  }

  markInvoicePaid(id: string, journalId: string, paidAt: number): boolean {
    const result = this.database.prepare(`
      UPDATE invoices
      SET status = 'paid', paid_at = ?, payment_journal_id = ?
      WHERE id = ? AND status IN ('pending', 'expired') AND payment_journal_id IS NULL
    `).run(paidAt, journalId, id)
    return result.changes === 1
  }

  insertPayment(
    entry: WalletJournalEntry,
    cashierId: string,
    payerId: string | null,
    occurredAt: number
  ): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO wallet_payments (
        journal_id, cashier_character_id, payer_character_id, amount_minor, reason,
        ref_type, description, first_party_id, second_party_id, occurred_at,
        raw_json, processing_status, received_at
      ) VALUES (
        @journalId, @cashierId, @payerId, @amountMinor, @reason,
        @refType, @description, @firstPartyId, @secondPartyId, @occurredAt,
        @rawJson, 'received', @receivedAt
      )
    `).run({
      ...entry,
      cashierId,
      payerId,
      amountMinor: entry.amountMinor === null ? null : moneyToStorage(entry.amountMinor),
      occurredAt,
      receivedAt: Math.floor(Date.now() / 1_000)
    })
    return result.changes === 1
  }

  getPayment(journalId: string): StoredPayment | null {
    const row = this.database.prepare('SELECT * FROM wallet_payments WHERE journal_id = ?').get(journalId)
    if (!row) return null
    const record = asRecord(row)
    return {
      journalId: stringField(record, 'journal_id'),
      cashierCharacterId: stringField(record, 'cashier_character_id'),
      payerCharacterId: nullableString(record.payer_character_id),
      amountMinor: record.amount_minor === null ? null : moneyFromStorage(record.amount_minor),
      reason: nullableString(record.reason),
      refType: stringField(record, 'ref_type'),
      occurredAt: integerField(record, 'occurred_at'),
      status: enumField(record, 'processing_status', ['received', 'matched', 'ignored'] as const),
      statusReason: nullableString(record.status_reason),
      invoiceId: nullableString(record.invoice_id)
    }
  }

  finishPayment(
    journalId: string,
    status: 'matched' | 'ignored',
    reason: string,
    invoiceId: string | null
  ): void {
    this.database.prepare(`
      UPDATE wallet_payments
      SET processing_status = ?, status_reason = ?, invoice_id = ?
      WHERE journal_id = ?
    `).run(status, reason, invoiceId, journalId)
  }

  getCreditBalance(characterId: string): bigint {
    const row = this.database.prepare(
      'SELECT balance_minor FROM credit_accounts WHERE character_id = ?'
    ).get(characterId)
    return row ? moneyFromStorage(asRecord(row).balance_minor) : 0n
  }

  postLedger(entry: LedgerEntry): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO credit_ledger (
        id, character_id, delta_minor, kind, invoice_id, payment_journal_id,
        subscription_id, note, created_at
      ) VALUES (
        @id, @characterId, @deltaMinor, @kind, @invoiceId, @paymentJournalId,
        @subscriptionId, @note, @createdAt
      )
    `).run({ ...entry, deltaMinor: moneyToStorage(entry.deltaMinor) })
    if (result.changes === 0) return false

    const current = this.getCreditBalance(entry.characterId)
    const next = current + entry.deltaMinor
    if (next < 0n) throw new Error('Credit account cannot become negative')
    this.database.prepare(`
      INSERT INTO credit_accounts (character_id, balance_minor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        balance_minor = excluded.balance_minor,
        updated_at = excluded.updated_at
    `).run(entry.characterId, moneyToStorage(next), entry.createdAt)
    return true
  }

  getSubscriptionForCharacter(characterId: string): Subscription | null {
    const row = this.database.prepare(
      'SELECT * FROM subscriptions WHERE character_id = ?'
    ).get(characterId)
    return row ? toSubscription(row) : null
  }

  getSubscription(id: string): Subscription | null {
    const row = this.database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)
    return row ? toSubscription(row) : null
  }

  saveSubscription(subscription: Subscription): void {
    this.database.prepare(`
      INSERT INTO subscriptions (
        id, character_id, character_name, plan_id, status, auto_renew,
        paid_through, created_at, updated_at
      ) VALUES (
        @id, @characterId, @characterName, @planId, @status, @autoRenew,
        @paidThrough, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        character_name = excluded.character_name,
        plan_id = excluded.plan_id,
        status = excluded.status,
        auto_renew = excluded.auto_renew,
        paid_through = excluded.paid_through,
        updated_at = excluded.updated_at
    `).run({ ...subscription, autoRenew: subscription.autoRenew ? 1 : 0 })
  }

  listRenewableSubscriptions(cutoff: number): Subscription[] {
    return this.database.prepare(`
      SELECT * FROM subscriptions
      WHERE auto_renew = 1 AND status != 'cancelled' AND paid_through <= ?
      ORDER BY paid_through, id
    `).all(cutoff).map(toSubscription)
  }

  registerDevice(input: {
    characterId: string
    deviceCode: string
    label: string | null
    now: number
    maxActive: number
  }): Device {
    return this.transaction(() => {
      const existing = this.getDeviceByCode(input.characterId, input.deviceCode)
      if (existing) {
        this.database.prepare(`
          UPDATE devices
          SET label = ?, status = 'active', updated_at = ?, last_seen_at = ?
          WHERE id = ?
        `).run(input.label, input.now, input.now, existing.id)
        return requireValue(this.getDevice(existing.id), 'Failed to reload device')
      }

      const countRow = asRecord(this.database.prepare(`
        SELECT COUNT(*) AS count FROM devices
        WHERE character_id = ? AND status = 'active'
      `).get(input.characterId))
      if (integerField(countRow, 'count') >= input.maxActive) {
        throw new DeviceLimitError(input.maxActive)
      }

      const id = randomUUID()
      this.database.prepare(`
        INSERT INTO devices (
          id, character_id, device_code, label, status, created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(id, input.characterId, input.deviceCode, input.label, input.now, input.now, input.now)
      return requireValue(this.getDevice(id), 'Failed to read newly registered device')
    })
  }

  listDevices(characterId: string, activeOnly = false): Device[] {
    const sql = activeOnly
      ? "SELECT * FROM devices WHERE character_id = ? AND status = 'active' ORDER BY created_at"
      : 'SELECT * FROM devices WHERE character_id = ? ORDER BY created_at'
    return this.database.prepare(sql).all(characterId).map(toDevice)
  }

  getDevice(id: string): Device | null {
    const row = this.database.prepare('SELECT * FROM devices WHERE id = ?').get(id)
    return row ? toDevice(row) : null
  }

  getDeviceByCode(characterId: string, deviceCode: string): Device | null {
    const row = this.database.prepare(`
      SELECT * FROM devices WHERE character_id = ? AND device_code = ?
    `).get(characterId, deviceCode)
    return row ? toDevice(row) : null
  }

  revokeDevice(id: string, characterId: string, now: number): boolean {
    const result = this.database.prepare(`
      UPDATE devices SET status = 'revoked', updated_at = ?
      WHERE id = ? AND character_id = ? AND status = 'active'
    `).run(now, id, characterId)
    return result.changes === 1
  }

  getEntitlement(subscriptionId: string, deviceId: string): IssuedEntitlement | null {
    const row = this.database.prepare(`
      SELECT * FROM entitlements WHERE subscription_id = ? AND device_id = ?
    `).get(subscriptionId, deviceId)
    return row ? toEntitlement(row) : null
  }

  saveEntitlement(entitlement: IssuedEntitlement): void {
    this.database.prepare(`
      INSERT INTO entitlements (
        id, subscription_id, device_id, revision, token, claims_json, issued_at, expires_at
      ) VALUES (
        @id, @subscriptionId, @deviceId, @revision, @token, @claimsJson, @issuedAt, @expiresAt
      )
      ON CONFLICT(subscription_id, device_id) DO UPDATE SET
        revision = excluded.revision,
        token = excluded.token,
        claims_json = excluded.claims_json,
        issued_at = excluded.issued_at,
        expires_at = excluded.expires_at
    `).run({ ...entitlement, claimsJson: JSON.stringify(entitlement.claims) })
  }

  deleteEntitlement(subscriptionId: string, deviceId: string): void {
    this.database.prepare(
      'DELETE FROM entitlements WHERE subscription_id = ? AND device_id = ?'
    ).run(subscriptionId, deviceId)
  }

  getWalletPollState(cashierCharacterId: string): WalletPollState | null {
    const row = this.database.prepare(`
      SELECT * FROM wallet_poll_state WHERE cashier_character_id = ?
    `).get(cashierCharacterId)
    if (!row) return null
    const record = asRecord(row)
    return {
      cashierCharacterId: stringField(record, 'cashier_character_id'),
      etag: nullableString(record.etag),
      lastModified: nullableString(record.last_modified),
      nextPollAt: integerField(record, 'next_poll_at'),
      consecutiveFailures: integerField(record, 'consecutive_failures'),
      updatedAt: integerField(record, 'updated_at')
    }
  }

  saveWalletPollState(state: WalletPollState): void {
    this.database.prepare(`
      INSERT INTO wallet_poll_state (
        cashier_character_id, etag, last_modified, next_poll_at,
        consecutive_failures, updated_at
      ) VALUES (
        @cashierCharacterId, @etag, @lastModified, @nextPollAt,
        @consecutiveFailures, @updatedAt
      )
      ON CONFLICT(cashier_character_id) DO UPDATE SET
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        next_poll_at = excluded.next_poll_at,
        consecutive_failures = excluded.consecutive_failures,
        updated_at = excluded.updated_at
    `).run(state)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price_minor TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL CHECK(duration_seconds > 0),
        features_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        receiver_character_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('subscription', 'credit')),
        plan_id TEXT REFERENCES plans(id),
        amount_minor TEXT NOT NULL,
        duration_seconds INTEGER,
        payment_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'expired', 'cancelled')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        paid_at INTEGER,
        payment_journal_id TEXT UNIQUE,
        CHECK((kind = 'subscription' AND plan_id IS NOT NULL AND duration_seconds IS NOT NULL)
          OR (kind = 'credit' AND plan_id IS NULL AND duration_seconds IS NULL))
      );

      CREATE INDEX IF NOT EXISTS invoices_character_idx
        ON invoices(character_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS wallet_payments (
        journal_id TEXT PRIMARY KEY,
        cashier_character_id TEXT NOT NULL,
        payer_character_id TEXT,
        amount_minor TEXT,
        reason TEXT,
        ref_type TEXT NOT NULL,
        description TEXT NOT NULL,
        first_party_id TEXT,
        second_party_id TEXT,
        occurred_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        processing_status TEXT NOT NULL CHECK(processing_status IN ('received', 'matched', 'ignored')),
        status_reason TEXT,
        invoice_id TEXT REFERENCES invoices(id),
        received_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_accounts (
        character_id TEXT PRIMARY KEY,
        balance_minor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL UNIQUE,
        character_name TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        status TEXT NOT NULL CHECK(status IN ('active', 'past_due', 'cancelled')),
        auto_renew INTEGER NOT NULL CHECK(auto_renew IN (0, 1)),
        paid_through INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS subscriptions_renewal_idx
        ON subscriptions(auto_renew, status, paid_through);

      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        delta_minor TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('payment', 'subscription_charge', 'renewal_charge', 'adjustment')),
        invoice_id TEXT REFERENCES invoices(id),
        payment_journal_id TEXT REFERENCES wallet_payments(journal_id),
        subscription_id TEXT REFERENCES subscriptions(id),
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_payment_idx
        ON credit_ledger(payment_journal_id) WHERE payment_journal_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_invoice_charge_idx
        ON credit_ledger(invoice_id, kind)
        WHERE invoice_id IS NOT NULL AND kind = 'subscription_charge';

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        device_code TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(character_id, device_code)
      );

      CREATE TABLE IF NOT EXISTS entitlements (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        token TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(subscription_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS wallet_poll_state (
        cashier_character_id TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        next_poll_at INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shared_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        policy_version INTEGER NOT NULL CHECK(policy_version > 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        owner_character_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shared_workspace_members (
        workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'commander', 'editor', 'viewer')),
        joined_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, character_id)
      );

      CREATE INDEX IF NOT EXISTS shared_workspace_members_character_idx
        ON shared_workspace_members(character_id, workspace_id);

      CREATE UNIQUE INDEX IF NOT EXISTS shared_workspace_single_owner_idx
        ON shared_workspace_members(workspace_id) WHERE role = 'owner';

      CREATE TABLE IF NOT EXISTS shared_workspace_consent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL CHECK(policy_version > 0),
        event_type TEXT NOT NULL CHECK(event_type IN ('accepted', 'revoked')),
        scopes_json TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        revoked_at INTEGER,
        occurred_at INTEGER NOT NULL,
        CHECK((event_type = 'accepted' AND revoked_at IS NULL)
          OR (event_type = 'revoked' AND revoked_at IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS shared_workspace_consent_latest_idx
        ON shared_workspace_consent_events(workspace_id, character_id, policy_version, id DESC);

      CREATE TABLE IF NOT EXISTS shared_workspace_records (
        workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
        collection TEXT NOT NULL CHECK(collection IN ('watchlist', 'doctrines', 'routes')),
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        workspace_revision INTEGER NOT NULL CHECK(workspace_revision > 0),
        payload_json TEXT,
        updated_by_character_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        last_mutation_id TEXT NOT NULL,
        PRIMARY KEY(workspace_id, collection, record_id),
        CHECK((deleted_at IS NULL AND payload_json IS NOT NULL)
          OR (deleted_at IS NOT NULL AND payload_json IS NULL))
      );

      CREATE INDEX IF NOT EXISTS shared_workspace_records_revision_idx
        ON shared_workspace_records(workspace_id, workspace_revision);

      CREATE TABLE IF NOT EXISTS shared_workspace_changes (
        workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
        workspace_revision INTEGER NOT NULL CHECK(workspace_revision > 0),
        mutation_id TEXT NOT NULL,
        collection TEXT NOT NULL CHECK(collection IN ('watchlist', 'doctrines', 'routes')),
        record_id TEXT NOT NULL,
        record_revision INTEGER NOT NULL CHECK(record_revision > 0),
        operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
        changed_by_character_id TEXT NOT NULL,
        changed_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, workspace_revision),
        UNIQUE(workspace_id, mutation_id)
      );

      CREATE TABLE IF NOT EXISTS shared_workspace_operations (
        workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
        mutation_id TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        actor_character_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_workspace_revision INTEGER NOT NULL,
        record_collection TEXT,
        record_id TEXT,
        record_revision INTEGER,
        result_record_json TEXT,
        result_change_json TEXT,
        stale_base INTEGER CHECK(stale_base IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, mutation_id)
      );

      CREATE TABLE IF NOT EXISTS shared_workspace_presence (
        workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        solar_system_id TEXT,
        solar_system_name TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        observed_at INTEGER,
        expires_at INTEGER,
        last_mutation_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, character_id),
        CHECK((active = 1 AND solar_system_id IS NOT NULL
          AND observed_at IS NOT NULL AND expires_at IS NOT NULL)
          OR (active = 0 AND solar_system_id IS NULL AND solar_system_name IS NULL
            AND observed_at IS NULL AND expires_at IS NULL))
      );

      CREATE INDEX IF NOT EXISTS shared_workspace_presence_expiry_idx
        ON shared_workspace_presence(workspace_id, expires_at);
    `)
    this.migrateWorkspaceTables()
  }

  private migrateWorkspaceTables(): void {
    this.immediateTransaction(() => {
      const operationColumns = this.tableColumns('shared_workspace_operations')
      if (!operationColumns.has('result_record_json')) {
        this.database.exec(
          'ALTER TABLE shared_workspace_operations ADD COLUMN result_record_json TEXT'
        )
      }
      if (!operationColumns.has('result_change_json')) {
        this.database.exec(
          'ALTER TABLE shared_workspace_operations ADD COLUMN result_change_json TEXT'
        )
      }
      if (!operationColumns.has('stale_base')) {
        this.database.exec(
          'ALTER TABLE shared_workspace_operations ADD COLUMN stale_base INTEGER CHECK(stale_base IN (0, 1))'
        )
      }

      if (this.tableColumns('shared_workspace_consents').size > 0) {
        this.database.exec(`
          INSERT INTO shared_workspace_consent_events (
            workspace_id, character_id, policy_version, event_type, scopes_json,
            accepted_at, revoked_at, occurred_at
          )
          SELECT
            workspace_id,
            character_id,
            policy_version,
            CASE WHEN revoked_at IS NULL THEN 'accepted' ELSE 'revoked' END,
            scopes_json,
            accepted_at,
            revoked_at,
            updated_at
          FROM shared_workspace_consents;
          DROP TABLE shared_workspace_consents;
        `)
      }

      const presenceColumns = this.tableColumns('shared_workspace_presence')
      if (presenceColumns.size > 0 && !presenceColumns.has('active')) {
        this.database.exec(`
          ALTER TABLE shared_workspace_presence RENAME TO shared_workspace_presence_legacy;

          CREATE TABLE shared_workspace_presence (
            workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
            character_id TEXT NOT NULL,
            solar_system_id TEXT,
            solar_system_name TEXT,
            revision INTEGER NOT NULL CHECK(revision > 0),
            active INTEGER NOT NULL CHECK(active IN (0, 1)),
            observed_at INTEGER,
            expires_at INTEGER,
            last_mutation_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(workspace_id, character_id),
            CHECK((active = 1 AND solar_system_id IS NOT NULL
              AND observed_at IS NOT NULL AND expires_at IS NOT NULL)
              OR (active = 0 AND solar_system_id IS NULL AND solar_system_name IS NULL
                AND observed_at IS NULL AND expires_at IS NULL))
          );

          INSERT INTO shared_workspace_presence (
            workspace_id, character_id, solar_system_id, solar_system_name,
            revision, active, observed_at, expires_at, last_mutation_id, updated_at
          )
          SELECT
            workspace_id, character_id, solar_system_id, solar_system_name,
            revision, 1, observed_at, expires_at, last_mutation_id, updated_at
          FROM shared_workspace_presence_legacy;

          DROP TABLE shared_workspace_presence_legacy;
          CREATE INDEX IF NOT EXISTS shared_workspace_presence_expiry_idx
            ON shared_workspace_presence(workspace_id, expires_at);
        `)
      }
    })
  }

  private tableColumns(table: string): Set<string> {
    if (!/^[a-z_]+$/u.test(table)) throw new Error('Invalid internal table name')
    return new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((row) => {
      const name = asRecord(row).name
      if (typeof name !== 'string') throw new TypeError('Invalid SQLite table metadata')
      return name
    }))
  }
}

export class DeviceLimitError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`Active device limit reached (${limit})`)
    this.name = 'DeviceLimitError'
    this.limit = limit
  }
}

function toPlan(row: unknown): Plan {
  const record = asRecord(row)
  const features = JSON.parse(stringField(record, 'features_json')) as unknown
  if (!Array.isArray(features) || !features.every((value) => typeof value === 'string')) {
    throw new TypeError('Corrupt plan feature list')
  }
  return {
    id: stringField(record, 'id'),
    name: stringField(record, 'name'),
    priceMinor: moneyFromStorage(record.price_minor),
    durationSeconds: integerField(record, 'duration_seconds'),
    features,
    enabled: booleanInteger(record.enabled)
  }
}

function toInvoice(row: unknown): Invoice {
  const record = asRecord(row)
  return {
    id: stringField(record, 'id'),
    characterId: stringField(record, 'character_id'),
    characterName: stringField(record, 'character_name'),
    receiverCharacterId: stringField(record, 'receiver_character_id'),
    kind: enumField(record, 'kind', ['subscription', 'credit'] as const),
    planId: nullableString(record.plan_id),
    amountMinor: moneyFromStorage(record.amount_minor),
    paymentCode: stringField(record, 'payment_code'),
    status: enumField(record, 'status', ['pending', 'paid', 'expired', 'cancelled'] as const),
    createdAt: integerField(record, 'created_at'),
    expiresAt: integerField(record, 'expires_at'),
    paidAt: nullableInteger(record.paid_at),
    paymentJournalId: nullableString(record.payment_journal_id)
  }
}

function toSubscription(row: unknown): Subscription {
  const record = asRecord(row)
  return {
    id: stringField(record, 'id'),
    characterId: stringField(record, 'character_id'),
    characterName: stringField(record, 'character_name'),
    planId: stringField(record, 'plan_id'),
    status: enumField(record, 'status', ['active', 'past_due', 'cancelled'] as const),
    autoRenew: booleanInteger(record.auto_renew),
    paidThrough: integerField(record, 'paid_through'),
    createdAt: integerField(record, 'created_at'),
    updatedAt: integerField(record, 'updated_at')
  }
}

function toDevice(row: unknown): Device {
  const record = asRecord(row)
  return {
    id: stringField(record, 'id'),
    characterId: stringField(record, 'character_id'),
    deviceCode: stringField(record, 'device_code'),
    label: nullableString(record.label),
    status: enumField(record, 'status', ['active', 'revoked'] as const),
    createdAt: integerField(record, 'created_at'),
    updatedAt: integerField(record, 'updated_at'),
    lastSeenAt: integerField(record, 'last_seen_at')
  }
}

function toEntitlement(row: unknown): IssuedEntitlement {
  const record = asRecord(row)
  const claims = JSON.parse(stringField(record, 'claims_json')) as EntitlementClaimsV2
  return {
    id: stringField(record, 'id'),
    subscriptionId: stringField(record, 'subscription_id'),
    deviceId: stringField(record, 'device_id'),
    revision: integerField(record, 'revision'),
    token: stringField(record, 'token'),
    claims,
    issuedAt: integerField(record, 'issued_at'),
    expiresAt: integerField(record, 'expires_at')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid database row')
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new TypeError(`Invalid ${key} column`)
  return value
}

function integerField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`Invalid ${key} integer column`)
  }
  return value
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Invalid nullable integer column')
  }
  return value
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError('Invalid nullable string column')
  return value
}

function booleanInteger(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new TypeError('Invalid boolean column')
  return value === 1
}

function enumField<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T
): T[number] {
  const value = stringField(record, key)
  if (!allowed.includes(value)) throw new TypeError(`Invalid ${key} enum column`)
  return value as T[number]
}

function requireValue<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message)
  return value
}
