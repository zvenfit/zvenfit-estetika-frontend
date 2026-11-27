const assert = require('node:assert/strict');
const test = require('node:test');
const { parseTable, report } = require('../telegram-delivery-report.cjs');

// Week 2026-11-16 (Mon) .. 2026-11-23 (Mon) 00:00 MSK = 2026-11-15T21:00Z .. 2026-11-22T21:00Z.
const WEEK = '2026-11-16';
const at = iso => Date.parse(iso);
const MIN = 60 * 1000;
let seq = 0;
function lead({ created, delivered = null, status = delivered ? 'sent' : 'pending', attempts = 1, snapshot, id }) {
  seq += 1;
  return {
    id: id ?? `synthetic-${seq}`, snapshot: at(snapshot), createdAt: at(created), outboxCreatedAt: at(created),
    status, attempts, deliveredAt: delivered ? at(delivered) : null, noLead: false, noOutbox: false,
  };
}
const sum = buckets => Object.values(buckets).reduce((a, b) => a + b, 0);

test('empty cohort gives no numeric shares', () => {
  const snapshot = '2026-11-23T09:00:00Z';
  const r = report([lead({ created: '2026-11-10T10:00:00Z', delivered: '2026-11-10T10:00:05Z', snapshot })], { week: WEEK });
  assert.equal(r.leads, 0);
  assert.equal(r.delivered_by_cutoff, null);
  assert.equal(r.delivered_within_threshold, null);
  assert.equal(r.delivery_seconds, null);
});

test('club example: one mature on-time delivery and one young pending lead → 1/2 by cutoff, 1/1 on time', () => {
  const snapshot = '2026-11-18T12:00:00Z';
  const r = report([
    lead({ created: '2026-11-18T11:00:00Z', delivered: '2026-11-18T11:00:30Z', snapshot }),
    lead({ created: '2026-11-18T11:55:00Z', snapshot }),
  ], { week: WEEK, thresholdMs: 10 * MIN });
  assert.deepEqual([r.delivered_by_cutoff.numerator, r.delivered_by_cutoff.denominator], [1, 2]);
  assert.deepEqual([r.delivered_within_threshold.numerator, r.delivered_within_threshold.denominator], [1, 1]);
  assert.equal(r.young, 1);
  assert.deepEqual(r.open, { n: 1, max_age_seconds: 300, overdue: 0 });
  assert.equal(sum(r.buckets), r.leads);
});

test('interim Wednesday cutoff ignores a Thursday lead; the full-week boundary also gives 1/1', () => {
  const monday = lead({ created: '2026-11-16T07:00:00Z', delivered: '2026-11-16T07:00:04Z', snapshot: '2026-11-20T12:00:00Z' });
  const thursday = lead({ created: '2026-11-19T07:00:00Z', snapshot: '2026-11-20T12:00:00Z' });
  const interim = report([monday, thursday], { week: WEEK, cutoff: at('2026-11-18T12:00:00Z') });
  assert.equal(interim.period, 'interim');
  assert.deepEqual([interim.delivered_by_cutoff.numerator, interim.delivered_by_cutoff.denominator], [1, 1]);

  const atWeekEnd = '2026-11-22T21:00:00Z';
  const nextWeek = lead({ created: atWeekEnd, snapshot: atWeekEnd });
  const full = report([{ ...monday, snapshot: at(atWeekEnd) }, nextWeek], { week: WEEK });
  assert.equal(full.period, 'full');
  assert.equal(full.cohort_exact, true);
  assert.deepEqual([full.delivered_by_cutoff.numerator, full.delivered_by_cutoff.denominator], [1, 1]);
});

test('a lead created on Sunday before midnight but saved after it is outside an exact midnight snapshot', () => {
  const midnight = '2026-11-22T21:00:00Z';
  const monday = lead({ created: '2026-11-16T07:00:00Z', delivered: '2026-11-16T07:00:04Z', snapshot: midnight });
  // Snapshot taken at the cutoff: the late-saved lead is not in it yet.
  const exact = report([monday], { week: WEEK });
  assert.equal(exact.leads, 1);
  assert.equal(exact.open.n, 0);
  // A later snapshot cannot tell when the row was saved: the report says the cohort is not exact.
  const later = '2026-11-23T09:00:00Z';
  const late = lead({ created: '2026-11-22T20:59:59Z', snapshot: later });
  const historical = report([{ ...monday, snapshot: at(later) }, late], { week: WEEK, cutoff: at(midnight) });
  assert.equal(historical.cohort_exact, false);
  assert.equal(historical.open, null);
  assert.equal(historical.buckets.unknown_at_cutoff, 1);
});

test('delivery after the cutoff does not count as delivered by the cutoff', () => {
  const r = report([
    lead({ created: '2026-11-22T20:30:00Z', delivered: '2026-11-22T21:30:00Z', snapshot: '2026-11-23T09:00:00Z' }),
  ], { week: WEEK, cutoff: at('2026-11-22T21:00:00Z') });
  assert.equal(r.buckets.delivered, 0);
  assert.equal(r.buckets.unknown_at_cutoff, 1);
  assert.deepEqual([r.delivered_by_cutoff.numerator, r.delivered_by_cutoff.denominator], [0, 1]);
  assert.deepEqual([r.delivered_within_threshold.numerator, r.delivered_within_threshold.denominator], [0, 1]);
});

test('long delivery, terminal failure and overdue open leads stay in the mature denominator', () => {
  const snapshot = '2026-11-20T12:00:00Z';
  const r = report([
    lead({ created: '2026-11-17T10:00:00Z', delivered: '2026-11-17T10:45:00Z', attempts: 4, snapshot }),
    lead({ created: '2026-11-17T11:00:00Z', status: 'failed', attempts: 5, snapshot }),
    lead({ created: '2026-11-20T10:00:00Z', attempts: 2, snapshot }),
  ], { week: WEEK, thresholdMs: 10 * MIN });
  assert.deepEqual(r.buckets, { delivered: 1, open: 1, failed: 1, no_outbox: 0, unknown_at_cutoff: 0 });
  assert.deepEqual([r.delivered_within_threshold.numerator, r.delivered_within_threshold.denominator], [0, 3]);
  assert.equal(r.delivery_seconds.max, 2700);
  assert.deepEqual(r.open, { n: 1, max_age_seconds: 7200, overdue: 1 });
  assert.equal(r.retried_leads, 3);
  assert.equal(r.recipient_messages, 'unknown');
});

test('a lead without an outbox row is counted and shown; an outbox row without a lead is kept out of the cohort', () => {
  const snapshot = '2026-11-20T12:00:00Z';
  const orphanLead = { ...lead({ created: '2026-11-17T10:00:00Z', snapshot }), status: '', attempts: null, outboxCreatedAt: null, noOutbox: true };
  const orphanOutbox = { ...lead({ created: '2026-11-17T11:00:00Z', delivered: '2026-11-17T11:00:03Z', snapshot }), createdAt: null, noLead: true };
  const r = report([orphanLead, orphanOutbox], { week: WEEK });
  assert.equal(r.leads, 1);
  assert.equal(r.buckets.no_outbox, 1);
  assert.equal(r.outbox_without_lead, 1);
  assert.deepEqual([r.delivered_by_cutoff.numerator, r.delivered_by_cutoff.denominator], [0, 1]);
});

test('a repeated ID does not grow the denominator; a conflicting repeat stops the report', () => {
  const snapshot = '2026-11-20T12:00:00Z';
  const one = lead({ id: 'same-id', created: '2026-11-17T10:00:00Z', delivered: '2026-11-17T10:00:02Z', snapshot });
  const r = report([one, { ...one }], { week: WEEK });
  assert.equal(r.leads, 1);
  assert.equal(r.duplicates_ignored, 1);
  assert.throws(() => report([one, { ...one, deliveredAt: null, status: 'pending' }], { week: WEEK }), /conflicting_duplicate_id/);
});

test('mixed snapshots, a cutoff after the snapshot and a non-Monday week are rejected', () => {
  const a = lead({ created: '2026-11-17T10:00:00Z', snapshot: '2026-11-20T12:00:00Z' });
  const b = lead({ created: '2026-11-17T11:00:00Z', snapshot: '2026-11-20T13:00:00Z' });
  assert.throws(() => report([a, b], { week: WEEK }), /expected_one_snapshot/);
  assert.throws(() => report([a], { week: WEEK, cutoff: at('2026-11-21T00:00:00Z') }), /cutoff_after_snapshot/);
  assert.throws(() => report([a], { week: '2026-11-17' }), /week_must_start_on_monday/);
  assert.throws(() => report([a], { week: '2026-02-30' }), /invalid_week/);
});

test('parses the YDB console copy (tab separated, NULL cells) and prints no IDs', () => {
  const header = 'snapshot_t\tid8\tlead_created_at\toutbox_created_at\tstatus\tattempts\tdelivered_at\tno_lead\tno_outbox';
  const text = [
    header,
    '2026-11-20T12:00:00.000000Z\tsynth001\t2026-11-17T10:00:00.000000Z\t2026-11-17T10:00:00.000000Z\tsent\t2\t2026-11-17T10:01:30.000000Z\tfalse\tfalse',
    '2026-11-20T12:00:00.000000Z\tsynth002\t2026-11-18T10:00:00.000000Z\tNULL\tNULL\tNULL\tNULL\tfalse\ttrue',
  ].join('\n');
  const r = report(parseTable(text), { week: WEEK });
  assert.equal(r.leads, 2);
  assert.equal(r.buckets.no_outbox, 1);
  assert.equal(r.delivery_seconds.median, 90);
  assert.doesNotMatch(JSON.stringify(r), /synth00/);
  assert.throws(() => parseTable('snapshot_t\tid8\n'), /missing_column_lead_created_at/);
  assert.throws(() => parseTable(`${header}\n2026-11-20T12:00:00Z\tsynth003\tfalse`), /column_count_mismatch/);
});
