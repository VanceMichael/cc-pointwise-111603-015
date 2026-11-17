import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeObservations, normalizeObservation } from '../src/observations.js';
import { buildDailyReport } from '../src/daily-report.js';

const population = {
  stations: ['S1', 'S2'],
  hours: ['2026-11-16T08:00:00Z'],
};

const observation = (overrides = {}) => normalizeObservation({
  observationId: 'S1-08',
  station: 'S1',
  hour: '2026-11-16T08:00:00Z',
  value: 35,
  unit: 'ug/m3',
  quality: 'provisional',
  revision: 1,
  ...overrides,
});

const stateWith = (items) => mergeObservations({ observations: [] }, items).state;
const cellOf = (report, station) => report.cells.find((cell) => cell.station === station);
const summaryOf = (report, station) => report.summaries.find((summary) => summary.station === station);

test('coverage comes from the expected population, not from returned records', () => {
  const report = buildDailyReport(population, stateWith([observation()]));
  assert.equal(report.coverage.expected, 2);
  assert.equal(report.coverage.received, 1);
  assert.equal(report.coverage.absent, 1);
  const absent = cellOf(report, 'S2');
  assert.equal(absent.status, 'absent');
  assert.equal(absent.value, null, '未收到不是零值');
  assert.equal(summaryOf(report, 'S2').status, 'undetermined');
  assert.deepEqual(summaryOf(report, 'S2').blockers, [{ station: 'S2', hour: '2026-11-16T08:00:00Z', status: 'absent', reason: null }]);
});

test('missing cells keep their reason and stay out of summaries without becoming zero', () => {
  const report = buildDailyReport(population, stateWith([
    observation({ quality: 'validated', value: 31, revision: 2 }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'missing', value: null, reason: 'maintenance' }),
  ]));
  const missing = cellOf(report, 'S2');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.reason, 'maintenance');
  assert.equal(missing.value, null);
  const summary = summaryOf(report, 'S2');
  assert.equal(summary.status, 'undetermined');
  assert.equal(summary.value, null, '缺测站点没有可被误读的零值汇总');
  assert.deepEqual(summary.blockers, [{ station: 'S2', hour: '2026-11-16T08:00:00Z', status: 'missing', reason: 'maintenance' }]);
});

test('provisional values are displayed but excluded from final summaries', () => {
  const report = buildDailyReport(population, stateWith([observation()]));
  assert.equal(cellOf(report, 'S1').value, 35);
  assert.equal(cellOf(report, 'S1').status, 'provisional');
  const summary = summaryOf(report, 'S1');
  assert.equal(summary.status, 'undetermined');
  assert.deepEqual(summary.blockers, [{ station: 'S1', hour: '2026-11-16T08:00:00Z', status: 'provisional', reason: null }]);
});

test('a fully validated station enters the summary with its current revision as basis', () => {
  const report = buildDailyReport(population, stateWith([
    observation({ quality: 'validated', value: 31, revision: 2 }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'validated', value: 41 }),
  ]));
  const summary = summaryOf(report, 'S1');
  assert.equal(summary.status, 'ok');
  assert.equal(summary.value, 31);
  assert.equal(summary.unit, 'ug/m3');
  assert.deepEqual(summary.basis, [{ observationId: 'S1-08', revision: 2, hour: '2026-11-16T08:00:00Z' }]);
  assert.equal(summaryOf(report, 'S2').status, 'ok');
});

test('a genuine zero validated value enters the summary as zero, distinct from missing', () => {
  const report = buildDailyReport(population, stateWith([
    observation({ quality: 'validated', value: 0, revision: 2 }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'validated', value: 40 }),
  ]));
  const summary = summaryOf(report, 'S1');
  assert.equal(summary.status, 'ok');
  assert.equal(summary.value, 0, '真实的零观测照常进入汇总');
});

test('when a correction arrives the report and its cited basis update together', () => {
  const before = buildDailyReport(population, stateWith([
    observation({ quality: 'validated', value: 31, revision: 2 }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'validated', value: 41 }),
  ]));
  assert.equal(summaryOf(before, 'S1').value, 31);
  assert.equal(summaryOf(before, 'S1').basis[0].revision, 2);

  const after = buildDailyReport(population, stateWith([
    observation(),
    observation({ quality: 'validated', value: 31, revision: 2 }),
    observation({ quality: 'validated', value: 28, revision: 3 }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'validated', value: 41 }),
  ]));
  const cell = cellOf(after, 'S1');
  assert.equal(cell.revision, 3);
  assert.deepEqual(cell.revisions, [1, 2, 3], '同一小时的前后版本都保留');
  assert.equal(cell.corrected, true);
  const summary = summaryOf(after, 'S1');
  assert.equal(summary.value, 28, '日报数值随当前版本更新');
  assert.equal(summary.basis[0].revision, 3, '引用依据与日报一致更新');
});

test('a missing cell later corrected to validated keeps its missing history', () => {
  const report = buildDailyReport(population, stateWith([
    observation({ quality: 'validated', value: 31, revision: 2 }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'missing', value: null, reason: 'maintenance' }),
    observation({ observationId: 'S2-08', station: 'S2', quality: 'validated', value: 41, revision: 2 }),
  ]));
  const cell = cellOf(report, 'S2');
  assert.equal(cell.status, 'validated');
  assert.deepEqual(cell.revisions, [1, 2], '缺测版本保留在历史中，不被改写');
  assert.equal(summaryOf(report, 'S2').status, 'ok');
  assert.equal(summaryOf(report, 'S2').value, 41);
});

test('daily mean requires every expected hour to be validated', () => {
  const twoHours = { stations: ['S1'], hours: ['2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z'] };
  const report = buildDailyReport(twoHours, stateWith([
    observation({ quality: 'validated', value: 30, revision: 2 }),
    observation({ observationId: 'S1-09', hour: '2026-11-16T09:00:00Z', quality: 'validated', value: 40 }),
  ]));
  assert.equal(report.day, '2026-11-16');
  assert.equal(summaryOf(report, 'S1').value, 35);
  const partial = buildDailyReport(twoHours, stateWith([
    observation({ quality: 'validated', value: 30, revision: 2 }),
  ]));
  assert.equal(summaryOf(partial, 'S1').status, 'undetermined', '覆盖不完整时不给日均值');
});
