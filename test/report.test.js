import test from 'node:test';
import assert from 'node:assert/strict';

import { describeObservation, normalizeRecord, stationOf } from '../src/records.js';
import { CollectionService } from '../src/service.js';
import { RecordRepository } from '../src/repository.js';
import { readOperations } from '../src/operations.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const population = { stations: ['S1', 'S2', 'S3'], hours: ['2026-11-16T08:00:00Z'] };

const row = (overrides) => ({
  sourceId: overrides.observationId ?? overrides.sourceId,
  source: '站点观测接收器',
  observedAt: overrides.hour ?? '2026-11-16T08:00:00Z',
  label: overrides.station,
  attributes: {
    observationId: overrides.observationId ?? overrides.sourceId,
    station: overrides.station,
    hour: overrides.hour ?? '2026-11-16T08:00:00Z',
    value: overrides.value ?? null,
    unit: 'ug/m3',
    quality: overrides.quality ?? 'validated',
    revision: overrides.revision ?? 1,
    ...(overrides.reason ? { reason: overrides.reason } : {}),
  },
});

async function serviceWith(records) {
  const directory = await mkdtemp(join(tmpdir(), 'report-test-'));
  const path = join(directory, 'records.json');
  const service = new CollectionService(new RecordRepository(path));
  await service.ingestBatch(records);
  return { directory, service, path, repository: new RecordRepository(path) };
}

test('missing observation is never converted into a zero value', async () => {
  const record = normalizeRecord(row({ sourceId: 'S2-08', station: 'S2', value: 0, quality: 'missing', reason: 'maintenance' }));
  assert.equal(record.value, null);
  assert.equal(record.reason, 'maintenance');
  assert.equal(record.attributes.value, null);
  assert.equal(record.attributes.reportedValue, 0);
  assert.equal(describeObservation(record).status, 'missing');
  assert.notEqual(describeObservation(record).status, 'validated');
});

test('a validated zero remains a real observation', async () => {
  const record = normalizeRecord(row({ sourceId: 'S1-08', station: 'S1', value: 0, quality: 'validated' }));
  const detail = describeObservation(record);
  assert.equal(detail.status, 'validated');
  assert.equal(detail.value, 0);
});

test('revisions accumulate so the earlier version is retained alongside the correction', async () => {
  const initial = row({ sourceId: 'S1-08', station: 'S1', value: 35, quality: 'provisional', revision: 1 });
  const corrected = row({ sourceId: 'S1-08', station: 'S1', value: 31, quality: 'validated', revision: 2 });
  const { directory, service, repository } = await serviceWith([initial, corrected]);
  try {
    const versions = await repository.readVersions();
    assert.deepEqual(versions.map((v) => v.revision), [1, 2]);
    assert.deepEqual(versions.map((v) => v.value), [35, 31]);
    assert.equal((await repository.read())[0].revision, 2);
    const view = await readOperations(repository, { population });
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].value, 31);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('replaying the same batch does not duplicate a station or a version', async () => {
  const batch = [
    row({ sourceId: 'S1-08', station: 'S1', value: 35 }),
    row({ sourceId: 'S2-08', station: 'S2', value: null, quality: 'missing', reason: 'maintenance' }),
  ];
  const { directory, repository } = await serviceWith(batch);
  try {
    const service = new CollectionService(repository);
    const first = await service.ingestBatch(batch);
    const replay = await service.ingestBatch(batch);
    assert.equal(replay.duplicates, 2);
    assert.equal(replay.added, 0);
    assert.equal((await repository.read()).length, 2);
    assert.equal((await repository.readVersions()).length, 2);
    const view = await readOperations(repository, { population });
    assert.equal(view.rows.length, 2);
    assert.equal(view.dailyReport.coverage.expected, population.stations.length * population.hours.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('report coverage comes from the population, not from returned records', async () => {
  const { directory, repository } = await serviceWith([
    row({ sourceId: 'S1-08', station: 'S1', value: 12, quality: 'validated' }),
  ]);
  try {
    const { dailyReport } = await readOperations(repository, { population });
    assert.deepEqual(dailyReport.stations.map((s) => s.station), ['S1', 'S2', 'S3']);
    assert.deepEqual(dailyReport.missingStations, ['S2', 'S3']);
    assert.deepEqual(dailyReport.notReceivedStations, ['S2', 'S3']);
    assert.deepEqual(dailyReport.incompleteStations, ['S2', 'S3']);
    const absent = dailyReport.cells.filter((cell) => cell.status === 'absent');
    assert.equal(absent.length, 2);
    assert.ok(absent.every((cell) => cell.value === null && cell.reason === 'not-received'));

    const hourSummary = dailyReport.summaries.find((summary) => summary.label === 'hour:2026-11-16T08:00:00Z');
    assert.equal(hourSummary.status, 'undetermined');
    assert.equal(hourSummary.value, null);
    const undetermined = dailyReport.undeterminedSummaries.map((s) => s.summary);
    assert.ok(undetermined.includes('day'));
    assert.ok(undetermined.includes('station:S2'));
    assert.ok(undetermined.includes('station:S3'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only complete, validated coverage feeds a summary; missing stays excluded', async () => {
  const { directory, repository } = await serviceWith([
    row({ sourceId: 'S1-08', station: 'S1', value: 10, quality: 'validated' }),
    row({ sourceId: 'S2-08', station: 'S2', value: 20, quality: 'validated' }),
    row({ sourceId: 'S3-08', station: 'S3', value: 0, quality: 'missing', reason: 'instrument-fault' }),
  ]);
  try {
    const { dailyReport } = await readOperations(repository, { population });
    assert.equal(dailyReport.status, 'incomplete');
    const day = dailyReport.summaries.find((summary) => summary.label === 'day');
    assert.equal(day.status, 'undetermined');
    assert.equal(day.value, null);
    const stationS3 = dailyReport.summaries.find((summary) => summary.label === 'station:S3');
    assert.equal(stationS3.status, 'undetermined');
    assert.equal(stationS3.value, null);
    assert.match(stationS3.undeterminedReasons.join(' '), /instrument-fault/);
    assert.ok(dailyReport.missingStations.includes('S3'));
    assert.ok(!dailyReport.notReceivedStations.includes('S3'), 'explicit missing is not the same as not received');
    // A station missing entirely is still listed and marked, never silently 0.
    assert.equal(dailyReport.stations.find((s) => s.station === 'S3').cells[0].value, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a later quality correction updates both the report and the cited basis', async () => {
  const provisional = row({ sourceId: 'S1-08', station: 'S1', value: 35, quality: 'provisional', revision: 1 });
  const { directory, repository } = await serviceWith([provisional]);
  try {
    const before = await readOperations(repository, {
      population: { stations: ['S1'], hours: ['2026-11-16T08:00:00Z'] },
    });
    const beforeCell = before.dailyReport.cells[0];
    assert.equal(beforeCell.status, 'provisional');
    assert.equal(beforeCell.basis, 'S1-08@1');
    assert.equal(before.dailyReport.summaries[0].status, 'undetermined');

    await new CollectionService(repository).ingestBatch([
      row({ sourceId: 'S1-08', station: 'S1', value: 31, quality: 'validated', revision: 2 }),
    ]);
    const after = await readOperations(repository, {
      population: { stations: ['S1'], hours: ['2026-11-16T08:00:00Z'] },
    });
    const afterCell = after.dailyReport.cells[0];
    assert.equal(afterCell.status, 'validated');
    assert.equal(afterCell.value, 31);
    assert.equal(afterCell.basis, 'S1-08@2');
    assert.equal(afterCell.citation.value, 31);
    const day = after.dailyReport.summaries.find((summary) => summary.label === 'day');
    assert.equal(day.status, 'determined');
    assert.equal(day.value, 31);
    assert.deepEqual(day.citations.map((citation) => citation.basis), ['S1-08@2']);

    // History still contains the earlier revision.
    const versions = await repository.readVersions();
    assert.deepEqual(versions.map((v) => `${v.sourceId}@${v.revision}`), ['S1-08@1', 'S1-08@2']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a later missing correction does not masquerade as a valid zero observation', async () => {
  const { directory, repository } = await serviceWith([
    row({ sourceId: 'S1-08', station: 'S1', value: 20, quality: 'validated', revision: 1 }),
  ]);
  try {
    await new CollectionService(repository).ingestBatch([
      row({ sourceId: 'S1-08', station: 'S1', value: 0, quality: 'missing', revision: 2, reason: 'calibration-failed' }),
    ]);
    const { dailyReport, rows } = await readOperations(repository, {
      population: { stations: ['S1'], hours: ['2026-11-16T08:00:00Z'] },
    });
    const cell = dailyReport.cells[0];
    assert.equal(cell.status, 'missing');
    assert.equal(cell.value, null);
    assert.equal(cell.reason, 'calibration-failed');
    assert.equal(cell.basis, 'S1-08@2');
    assert.equal(dailyReport.summaries.find((summary) => summary.label === 'day').value, null);
    assert.equal(rows[0].value, null);
    assert.equal(rows[0].status, 'missing');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conflicting content for the same revision is flagged instead of silently picking a value', async () => {
  const original = row({ sourceId: 'S1-08', station: 'S1', value: 10, quality: 'validated', revision: 1 });
  const { directory, repository } = await serviceWith([original]);
  try {
    const conflicting = row({ sourceId: 'S1-08', station: 'S1', value: 99, quality: 'validated', revision: 1 });
    const service = new CollectionService(repository);
    const result = await service.ingestBatch([conflicting]);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.versions, 1, 'the conflicting payload does not create a new version');
    const { dailyReport } = await readOperations(repository, {
      population: { stations: ['S1'], hours: ['2026-11-16T08:00:00Z'] },
    });
    const cell = dailyReport.cells[0];
    assert.equal(cell.status, 'conflict');
    assert.equal(cell.value, null);
    assert.equal(dailyReport.summaries.find((summary) => summary.label === 'day').value, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a row with an unusable value is invalid rather than silently dropped', async () => {
  const broken = {
    ...row({ sourceId: 'S1-08', station: 'S1', quality: 'validated' }),
    attributes: {
      observationId: 'S1-08', station: 'S1', hour: '2026-11-16T08:00:00Z',
      value: 'not-a-number', unit: 'ug/m3', quality: 'validated', revision: 1,
    },
    value: 'not-a-number',
  };
  // Legacy/broken state can exist on disk even though ingest would reject it.
  const directory = await mkdtemp(join(tmpdir(), 'invalid-cell-'));
  try {
    const path = join(directory, 'records.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ records: [broken], versions: [broken] }));
    const { dailyReport } = await readOperations(new RecordRepository(path), {
      population: { stations: ['S1'], hours: ['2026-11-16T08:00:00Z'] },
    });
    assert.equal(dailyReport.cells[0].status, 'invalid');
    assert.equal(dailyReport.cells[0].value, null);
    assert.equal(dailyReport.summaries.find((summary) => summary.label === 'day').value, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('state written by the legacy repository is still readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-'));
  try {
    const path = join(directory, 'records.json');
    const legacy = [{ ...row({ sourceId: 'S1-08', station: 'S1', value: 7 }), sourceAttributes: undefined }];
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify({ records: legacy }));
    const repository = new RecordRepository(path);
    const records = await repository.read();
    assert.equal(records.length, 1);
    assert.equal(stationOf(records[0]), 'S1');
    const view = await readOperations(repository, { population });
    assert.equal(view.dailyReport.cells.find((cell) => cell.station === 'S1').status, 'validated');
    await new CollectionService(repository).ingestBatch([
      row({ sourceId: 'S1-08', station: 'S1', value: 9, quality: 'validated', revision: 2 }),
    ]);
    const migrated = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(migrated.versions));
    assert.deepEqual(migrated.records.map((record) => record.revision), [2]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
