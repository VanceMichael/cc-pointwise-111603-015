import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository, ObservationRepository } from './repository.js';
import { CollectionService, ObservationService } from './service.js';
import { readOperations, readDailyReport } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const client = new SourceClient(source.url);
  const population = JSON.parse(await readFile(new URL('../fixtures/population.json', import.meta.url), 'utf8'));

  // 通用记录集合：首批导入、重启回读、重放与业务查询保持一致
  const firstPage = parsePage(await client.read(entryPath));
  assert.ok(firstPage.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(firstPage.records);
  assert.equal(first.accepted, firstPage.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(firstPage.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // 小时观测版本化接入与日报
  const observationPath = join(directory, 'observations.json');
  const observations = new ObservationService(new ObservationRepository(observationPath));
  const cellOf = (report, station) => report.cells.find((cell) => cell.station === station);
  const summaryOf = (report, station) => report.summaries.find((summary) => summary.station === station);

  const opening = await observations.ingest(firstPage.records);
  assert.equal(opening.added, 1);
  const openingReport = await readDailyReport(observations.repository, population);
  assert.equal(openingReport.coverage.expected, 2, '日报覆盖范围来自应报站点清单而非本次返回');
  assert.equal(cellOf(openingReport, 'S1').status, 'provisional');
  assert.equal(summaryOf(openingReport, 'S1').status, 'undetermined', '暂定值不进入最终汇总');
  assert.equal(cellOf(openingReport, 'S2').status, 'absent', '未收到的站点仍须出现');
  assert.equal(cellOf(openingReport, 'S2').value, null);
  assert.equal(summaryOf(openingReport, 'S2').status, 'undetermined');

  source.publish('updated');
  const updatedPage = parsePage(await client.read(entryPath));
  await new CollectionService(reopened).ingest(updatedPage.records);
  const updated = await observations.ingest(updatedPage.records);
  assert.equal(updated.added, 2, '质控更正与缺测各自追加为新版本');
  const updatedReport = await readDailyReport(observations.repository, population);
  assert.equal(cellOf(updatedReport, 'S1').status, 'validated');
  assert.equal(cellOf(updatedReport, 'S1').value, 31);
  assert.deepEqual(cellOf(updatedReport, 'S1').revisions, [1, 2], '同一小时的前后版本都保留');
  assert.deepEqual(summaryOf(updatedReport, 'S1').basis, [{ observationId: 'S1-08', revision: 2, hour: '2026-11-16T08:00:00Z' }]);
  const missingCell = cellOf(updatedReport, 'S2');
  assert.equal(missingCell.status, 'missing');
  assert.equal(missingCell.reason, 'maintenance', '缺测原因须明确表达');
  assert.equal(missingCell.value, null, '缺测不是零值');
  const missingSummary = summaryOf(updatedReport, 'S2');
  assert.equal(missingSummary.status, 'undetermined', '缺测站点的汇总不能判定');
  assert.equal(missingSummary.value, null);
  assert.deepEqual(missingSummary.blockers, [{ station: 'S2', hour: '2026-11-16T08:00:00Z', status: 'missing', reason: 'maintenance' }]);

  const replay = await observations.ingest(updatedPage.records);
  assert.equal(replay.added, 0, '重复批次不追加版本');
  assert.equal(replay.stored, updated.stored, '重复批次不会多算一个站点');
  assert.deepEqual(await readDailyReport(observations.repository, population), updatedReport, '重放后日报不变');

  const restarted = new ObservationService(new ObservationRepository(observationPath));
  assert.deepEqual(await readDailyReport(restarted.repository, population), updatedReport, '重启后观测状态与日报一致');

  source.publish('corrected');
  const correctedPage = parsePage(await client.read(entryPath));
  await observations.ingest(correctedPage.records);
  const correctedReport = await readDailyReport(restarted.repository, population);
  assert.equal(cellOf(correctedReport, 'S1').revision, 3);
  assert.deepEqual(cellOf(correctedReport, 'S1').revisions, [1, 2, 3]);
  assert.equal(summaryOf(correctedReport, 'S1').value, 28, '质控修正后日报随当前版本更新');
  assert.deepEqual(summaryOf(correctedReport, 'S1').basis, [{ observationId: 'S1-08', revision: 3, hour: '2026-11-16T08:00:00Z' }], '引用依据与日报一致更新');
  assert.equal(cellOf(correctedReport, 'S2').status, 'validated');
  assert.deepEqual(cellOf(correctedReport, 'S2').revisions, [1, 2], '缺测历史版本保留，不被改写为有效观测');
  assert.equal(summaryOf(correctedReport, 'S2').status, 'ok');
  assert.equal(summaryOf(correctedReport, 'S2').value, 41);
  assert.equal(correctedReport.coverage.validated, 2);

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    operationRows: operations.rows.length,
    observations: updated.stored,
    reportCells: correctedReport.cells.length,
    summaries: correctedReport.summaries.map((summary) => summary.status),
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
