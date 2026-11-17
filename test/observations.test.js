import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeObservation, mergeObservations } from '../src/observations.js';
import { ObservationRepository } from '../src/repository.js';
import { ObservationService } from '../src/service.js';

const observation = (overrides = {}) => ({
  observationId: 'S1-08',
  station: 'S1',
  hour: '2026-11-16T08:00:00Z',
  value: 35,
  unit: 'ug/m3',
  quality: 'provisional',
  revision: 1,
  reason: null,
  ...overrides,
});

test('normalization keeps value, missing reason and revision as distinct facts', () => {
  const valid = normalizeObservation(observation());
  assert.equal(valid.value, 35);
  assert.equal(valid.quality, 'provisional');
  const missing = normalizeObservation(observation({ observationId: 'S2-08', station: 'S2', quality: 'missing', value: null, reason: 'maintenance' }));
  assert.equal(missing.value, null);
  assert.equal(missing.reason, 'maintenance');
});

test('a genuine zero is a valid observation, null is not', () => {
  const zero = normalizeObservation(observation({ value: 0, quality: 'validated', revision: 2 }));
  assert.equal(zero.value, 0);
  assert.throws(() => normalizeObservation(observation({ value: null, quality: 'validated' })), /numeric value/);
});

test('missing observations must carry null value and a reason, never a disguised zero', () => {
  assert.throws(() => normalizeObservation(observation({ quality: 'missing', value: 0, reason: 'maintenance' })), /must not carry a value/);
  assert.throws(() => normalizeObservation(observation({ quality: 'missing', value: null })), /requires a reason/);
});

test('normalization rejects unknown quality, bad revision and bad hour', () => {
  assert.throws(() => normalizeObservation(observation({ quality: 'unknown' })), /invalid quality/);
  assert.throws(() => normalizeObservation(observation({ revision: 0 })), /invalid revision/);
  assert.throws(() => normalizeObservation(observation({ hour: 'not-a-date' })), /invalid hour/);
});

test('merge keeps every revision of the same hour and the highest revision is current', () => {
  const first = normalizeObservation(observation());
  const correction = normalizeObservation(observation({ value: 31, quality: 'validated', revision: 2 }));
  const { state } = mergeObservations({ observations: [] }, [first, correction]);
  const entry = state.observations[0];
  assert.equal(state.observations.length, 1);
  assert.deepEqual(entry.versions.map((version) => version.revision), [1, 2]);
  assert.equal(entry.current.revision, 2);
  assert.equal(entry.current.value, 31);
  assert.equal(entry.versions[0].value, 35, '前一版本保留原值');
});

test('replaying the same batch adds nothing and never double-counts a station', () => {
  const batch = [normalizeObservation(observation())];
  const once = mergeObservations({ observations: [] }, batch);
  const twice = mergeObservations(once.state, batch.map((item) => ({ ...item })));
  assert.equal(twice.added, 0);
  assert.equal(twice.state.observations.length, 1);
  assert.equal(twice.state.observations[0].versions.length, 1);
});

test('a late older revision is retained in history without displacing current', () => {
  const newer = normalizeObservation(observation({ value: 31, quality: 'validated', revision: 2 }));
  const older = normalizeObservation(observation());
  const { state, added } = mergeObservations({ observations: [] }, [newer, older]);
  assert.equal(added, 2);
  assert.deepEqual(state.observations[0].versions.map((version) => version.revision), [1, 2]);
  assert.equal(state.observations[0].current.revision, 2);
});

test('conflicting content for the same revision and identity conflicts are rejected', () => {
  const base = normalizeObservation(observation());
  const { state } = mergeObservations({ observations: [] }, [base]);
  assert.throws(
    () => mergeObservations(state, [normalizeObservation(observation({ value: 99 }))]),
    /conflicting revision 1/,
  );
  assert.throws(
    () => mergeObservations(state, [normalizeObservation(observation({ hour: '2026-11-16T09:00:00Z', revision: 2 }))]),
    /identity conflict/,
  );
});

test('observation service persists versions and restarts from repository state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observations-'));
  try {
    const path = join(directory, 'state', 'observations.json');
    const service = new ObservationService(new ObservationRepository(path));
    const first = await service.ingest([observation()]);
    assert.deepEqual(first, { accepted: 1, stored: 1, added: 1 });
    const restarted = new ObservationService(new ObservationRepository(path));
    const replay = await restarted.ingest([observation()]);
    assert.equal(replay.added, 0);
    const correction = await restarted.ingest([observation({ value: 31, quality: 'validated', revision: 2 })]);
    assert.equal(correction.added, 1);
    const state = await restarted.state();
    assert.equal(state.observations[0].versions.length, 2);
    assert.equal(state.observations[0].current.value, 31);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('observation service accepts generic records via their attributes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observations-'));
  try {
    const service = new ObservationService(new ObservationRepository(join(directory, 'observations.json')));
    const record = { sourceId: 'S1-08', source: '站点观测接收器', observedAt: '2026-11-16T08:00:00Z', label: 'S1', attributes: observation() };
    const result = await service.ingest([record]);
    assert.equal(result.added, 1);
    assert.equal((await service.state()).observations[0].observationId, 'S1-08');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
