import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { readAllPages } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const population = JSON.parse(await readFile(new URL('../fixtures/population.json', import.meta.url), 'utf8'));
const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const client = new SourceClient(source.url);
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const service = new CollectionService(repository);

  const opening = await readAllPages(client);
  assert.ok(opening.records.length > 0, '初始来源须有可接收的业务记录');
  const first = await service.ingestBatch(opening.records);
  assert.equal(first.accepted, opening.records.length);

  // Opening stage: provisional is visible but cannot enter a summary yet, and
  // the population station missing from the response is still reported.
  const openingReport = (await readOperations(repository, { population })).dailyReport;
  assert.equal(openingReport.status, 'incomplete');
  assert.equal(openingReport.stations.find((s) => s.station === 'S1').cells[0].status, 'provisional');
  assert.ok(openingReport.notReceivedStations.includes('S2'));
  assert.ok(openingReport.undeterminedSummaries.some((s) => s.summary === 'day'));

  // Restart from the same file and verify replay is a no-op.
  const reopened = new RecordRepository(path);
  const replay = await new CollectionService(reopened).ingestBatch(opening.records);
  assert.equal(replay.added, 0, '重放首批记录不重复保存');
  assert.equal(replay.duplicates, opening.records.length);
  assert.equal((await reopened.read()).length, first.stored);
  assert.equal((await reopened.readVersions()).length, first.versions);

  // A later quality correction arrives together with an explicit missing row.
  source.publish('updated');
  const updated = await readAllPages(client);
  const second = await new CollectionService(reopened).ingestBatch(updated.records);
  assert.equal(second.corrections, 1, '同一小时的新版本作为更正保存');
  const versions = await reopened.readVersions();
  assert.deepEqual(
    versions.filter((v) => v.sourceId === 'S1-08').map((v) => `${v.revision}:${v.value}`),
    ['1:35', '2:31'],
    '更正前的版本仍保留',
  );

  const operations = await readOperations(reopened, { population });
  const report = operations.dailyReport;
  const s1 = report.cells.find((cell) => cell.station === 'S1');
  assert.equal(s1.status, 'validated');
  assert.equal(s1.value, 31);
  assert.equal(s1.basis, 'S1-08@2', '当前日报引用最新版本');
  assert.equal(s1.citation.value, 31);
  const s2 = report.cells.find((cell) => cell.station === 'S2');
  assert.equal(s2.status, 'missing');
  assert.equal(s2.value, null, '缺测不写成零值');
  assert.equal(s2.reason, 'maintenance');
  assert.equal(s2.basis, 'S2-08@1');
  assert.equal(report.status, 'incomplete');
  assert.equal(report.summaries.find((s) => s.label === 'day').value, null);
  assert.ok(report.missingStations.includes('S2'));
  assert.ok(!report.notReceivedStations.includes('S2'), '明确缺测与未返回是两回事');

  const operationsAfterRestart = await readOperations(new RecordRepository(path), { population });
  assert.deepEqual(operationsAfterRestart.dailyReport, report, '重启后日报与引用一致');

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: (await reopened.read()).length,
    versions: versions.length,
    corrections: second.corrections,
    coverage: report.coverage,
    missingStations: report.missingStations,
    reportStatus: report.status,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
