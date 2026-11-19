import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { entryPath, parsePage, readAllPages } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const population = { stations: ['S1', 'S2'], hours: ['2026-11-16T08:00:00Z'] };

async function withSource(stage, run) {
  const source = await startSource(scenarioPath);
  try {
    source.publish(stage);
    await run(source);
  } finally { await source.close(); }
}

async function withRepository(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hourly-report-'));
  try {
    await run(new RecordRepository(join(directory, 'records.json')), directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('paged source rows are collected together and a returned zero for a missing hour stays missing', async () => {
  await withSource('paged', async (source) => {
    const { records, pages } = await readAllPages(new SourceClient(source.url), entryPath);
    assert.equal(pages.length, 2);
    assert.deepEqual(records.map((record) => record.sourceId), ['S1-08', 'S2-08']);
    await withRepository(async (repository) => {
      await new CollectionService(repository).ingestBatch(records);
      const { dailyReport } = await readOperations(repository, { population });
      const s2 = dailyReport.cells.find((cell) => cell.station === 'S2');
      assert.equal(s2.status, 'missing');
      assert.equal(s2.value, null);
      assert.equal(s2.reason, 'maintenance');
      assert.equal(dailyReport.status, 'incomplete');
      assert.equal(dailyReport.summaries.find((summary) => summary.label === 'day').value, null);
    });
  });
});

test('a correction published later updates the current report and its citation but keeps the prior revision', async () => {
  const source = await startSource(scenarioPath);
  try {
    const client = new SourceClient(source.url);
    await withRepository(async (repository) => {
      const service = new CollectionService(repository);
      const opening = parsePage(await client.read(entryPath));
      const first = await service.ingestBatch(opening.records);
      assert.equal(first.added, 1);

      const before = await readOperations(repository, { population });
      const beforeS1 = before.dailyReport.cells.find((cell) => cell.station === 'S1');
      assert.equal(beforeS1.status, 'provisional');
      assert.equal(beforeS1.basis, 'S1-08@1');
      assert.equal(before.dailyReport.status, 'incomplete');
      assert.equal(before.dailyReport.missingStations.includes('S2'), true);

      source.publish('updated');
      const update = parsePage(await client.read(entryPath));
      const second = await service.ingestBatch(update.records);
      assert.equal(second.corrections, 1);
      assert.equal(second.added, 2);

      const after = await readOperations(repository, { population });
      const afterS1 = after.dailyReport.cells.find((cell) => cell.station === 'S1');
      assert.equal(afterS1.status, 'validated');
      assert.equal(afterS1.value, 31);
      assert.equal(afterS1.basis, 'S1-08@2');
      assert.equal(afterS1.citation.revision, 2);
      // The correction is what the current report cites; the earlier version
      // is still retained in history for audit.
      assert.deepEqual(
        after.versions.filter((row) => row.sourceId === 'S1-08').map((row) => `${row.basis}:${row.value}`),
        ['S1-08@1:35', 'S1-08@2:31'],
      );

      const s2 = after.dailyReport.cells.find((cell) => cell.station === 'S2');
      assert.equal(s2.status, 'missing');
      assert.equal(s2.value, null);
      assert.equal(s2.reason, 'maintenance');
      assert.equal(after.dailyReport.summaries.find((summary) => summary.label === 'station:S1').status, 'determined');
      assert.equal(after.dailyReport.summaries.find((summary) => summary.label === 'station:S1').value, 31);
      assert.equal(after.dailyReport.summaries.find((summary) => summary.label === 'day').value, null);
    });
  } finally { await source.close(); }
});

test('replays and repeated rows within a batch do not add a station to coverage', async () => {
  await withSource('updated', async (source) => {
    const page = parsePage(await new SourceClient(source.url).read(entryPath));
    await withRepository(async (repository) => {
      const service = new CollectionService(repository);
      await service.ingestBatch(page.records);
      const replay = await service.ingestBatch([...page.records, ...page.records]);
      assert.equal(replay.duplicates, 4);
      assert.equal(replay.added, 0);
      const { dailyReport } = await readOperations(repository, { population });
      assert.equal(dailyReport.coverage.expected, 2);
      assert.equal(dailyReport.coverage.missing, 1);
      assert.equal(dailyReport.coverage.validated, 1);
      assert.equal((await repository.readVersions()).length, 2);
    });
  });
});
