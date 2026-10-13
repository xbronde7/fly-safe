import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ServiceError } from '../src/domain.js'
import { formatIsk } from '../src/money.js'
import {
  DEVICE_CODE,
  PLAN,
  PRINCIPAL,
  createFixture,
  walletEntry
} from './fixture.js'

describe('payment and entitlement lifecycle', () => {
  it('allows device registration before payment, then atomically activates subscription', () => {
    const fixture = createFixture()
    const device = fixture.billing.registerDevice(PRINCIPAL, DEVICE_CODE, 'Main PC')

    assert.throws(
      () => fixture.entitlements.getOrIssue(PRINCIPAL.characterId, DEVICE_CODE),
      (error) => error instanceof ServiceError && error.code === 'subscription_required'
    )

    const invoice = fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    assert.equal(invoice.paymentCode, 'FS-ABCDEFGH')
    const first = fixture.billing.processWalletEntry(walletEntry())
    assert.equal(first.status, 'matched')
    assert.equal(first.duplicate, false)
    assert.equal(formatIsk(fixture.store.getCreditBalance(PRINCIPAL.characterId)), '0.00')

    const subscription = fixture.store.getSubscriptionForCharacter(PRINCIPAL.characterId)
    assert.ok(subscription)
    assert.equal(subscription.paidThrough, 1_700_000_000 + PLAN.durationSeconds)

    const entitlement = fixture.entitlements.getOrIssue(PRINCIPAL.characterId, DEVICE_CODE)
    const claims = fixture.signer.verify(entitlement.token)
    assert.equal(claims.v, 2)
    assert.equal(claims.characterId, PRINCIPAL.characterId)
    assert.equal(claims.deviceId, device.id)
    assert.equal(claims.deviceCode, DEVICE_CODE)
    assert.equal(claims.paidThrough, subscription.paidThrough)
    assert.deepEqual(claims.features, PLAN.features)

    const duplicate = fixture.billing.processWalletEntry(walletEntry())
    assert.equal(duplicate.duplicate, true)
    assert.equal(
      fixture.store.getSubscriptionForCharacter(PRINCIPAL.characterId)?.paidThrough,
      subscription.paidThrough
    )
    fixture.store.close()
  })

  it('rejects mismatched amount without crediting or consuming invoice', () => {
    const fixture = createFixture()
    const invoice = fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    const result = fixture.billing.processWalletEntry(walletEntry({ amountIsk: '99999999' }))
    assert.equal(result.status, 'ignored')
    assert.equal(result.reason, 'wrong_amount')
    assert.equal(fixture.store.getInvoice(invoice.id)?.status, 'pending')
    assert.equal(fixture.store.getCreditBalance(PRINCIPAL.characterId), 0n)
    fixture.store.close()
  })

  it('uses prepaid credits for one due renewal and rotates entitlement revision', () => {
    const fixture = createFixture(['FS-ABCDEFGH', 'FS-JKLMNPQR'])
    fixture.billing.registerDevice(PRINCIPAL, DEVICE_CODE)
    fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    fixture.billing.processWalletEntry(walletEntry())
    const first = fixture.entitlements.getOrIssue(PRINCIPAL.characterId, DEVICE_CODE)

    const topUp = fixture.billing.createCreditInvoice(PRINCIPAL, '100000000.00')
    fixture.billing.processWalletEntry(walletEntry({
      journalId: '990000000000000002',
      reason: topUp.paymentCode,
      amountIsk: '100000000.00'
    }))
    assert.equal(fixture.store.getCreditBalance(PRINCIPAL.characterId), PLAN.priceMinor)

    const original = fixture.store.getSubscriptionForCharacter(PRINCIPAL.characterId)
    assert.ok(original)
    fixture.setNow(original.paidThrough - 3_600)
    const renewed = fixture.billing.renewEligibleSubscriptions()
    assert.equal(renewed.length, 1)
    assert.equal(renewed[0]?.paidThrough, original.paidThrough + PLAN.durationSeconds)
    assert.equal(fixture.store.getCreditBalance(PRINCIPAL.characterId), 0n)

    const second = fixture.entitlements.getOrIssue(PRINCIPAL.characterId, DEVICE_CODE)
    assert.equal(second.id, first.id)
    assert.equal(second.revision, first.revision + 1)
    assert.notEqual(second.token, first.token)
    fixture.store.close()
  })

  it('requires one exact reason code and an identifiable cashier party', () => {
    const fixture = createFixture()
    fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    const ambiguous = fixture.billing.processWalletEntry(walletEntry({
      reason: 'FS-ABCDEFGH and FS-JKLMNPQR'
    }))
    assert.equal(ambiguous.reason, 'missing_or_ambiguous_payment_code')

    const noCashier = walletEntry({ journalId: '990000000000000003' })
    noCashier.secondPartyId = '90000088'
    const result = fixture.billing.processWalletEntry(noCashier)
    assert.equal(result.reason, 'cashier_party_not_identifiable')
    fixture.store.close()
  })

  it('matches a personal Give ISK entry without reason only to one exact payable invoice', () => {
    const fixture = createFixture()
    const invoice = fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    const entry = walletEntry({ reason: null })
    const result = fixture.billing.processWalletEntry(entry)
    assert.equal(result.status, 'matched')
    assert.equal(result.reason, 'invoice_paid')
    assert.equal(result.invoiceId, invoice.id)
    assert.equal(fixture.store.getInvoice(invoice.id)?.status, 'paid')

    const duplicate = fixture.billing.processWalletEntry(entry)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.status, 'matched')
    fixture.store.close()
  })

  it('rejects no-reason payments with wrong payer, wrong amount, or no invoice', () => {
    const fixture = createFixture()
    const invoice = fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)

    const wrongPayer = fixture.billing.processWalletEntry(walletEntry({
      journalId: '990000000000000010',
      reason: null,
      payerId: '90000002'
    }))
    assert.equal(wrongPayer.reason, 'invoice_not_found_without_reason')

    const wrongAmount = fixture.billing.processWalletEntry(walletEntry({
      journalId: '990000000000000011',
      reason: null,
      amountIsk: '99999999.00'
    }))
    assert.equal(wrongAmount.reason, 'invoice_not_found_without_reason')
    assert.equal(fixture.store.getInvoice(invoice.id)?.status, 'pending')

    const otherFixture = createFixture()
    const noInvoice = otherFixture.billing.processWalletEntry(walletEntry({
      journalId: '990000000000000012',
      reason: null
    }))
    assert.equal(noInvoice.reason, 'invoice_not_found_without_reason')
    fixture.store.close()
    otherFixture.store.close()
  })

  it('keeps a no-reason payment for manual review when exact invoices are ambiguous', () => {
    const fixture = createFixture(['FS-ABCDEFGH', 'FS-JKLMNPQR'])
    const first = fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    const second = fixture.billing.createSubscriptionInvoice(PRINCIPAL, PLAN.id)
    const result = fixture.billing.processWalletEntry(walletEntry({ reason: null }))
    assert.equal(result.status, 'ignored')
    assert.equal(result.reason, 'ambiguous_invoice_without_reason')
    assert.equal(fixture.store.getInvoice(first.id)?.status, 'pending')
    assert.equal(fixture.store.getInvoice(second.id)?.status, 'pending')
    assert.equal(fixture.store.getCreditBalance(PRINCIPAL.characterId), 0n)
    fixture.store.close()
  })
})
