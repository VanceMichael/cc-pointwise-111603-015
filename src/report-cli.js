import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { entryPath, readAllPages } from './adapter.js';
import { SourceClient } from './source-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  console.log(JSON.stringify({
    usage: 'npm run report -- [站点清单] [日期] [来源地址]',
    env: { COLLECTION_STATE: '状态文件路径', SOURCE_URL: '可选，报告前先采集' },
  }));
  process.exit(0);
}
// Accept both `npm run report -- population.json` and an explicit `report`
// action for symmetry with `npm start`.
if (args[0] === 'report') args.shift();

const statePath = process.env.COLLECTION_STATE ?? resolve(here, '../var/records.json');
const service = new CollectionService(new RecordRepository(statePath));
const population = JSON.parse(await readFile(args[0] ?? resolve(here, '../fixtures/population.json'), 'utf8'));
const date = args[1] || undefined;
const address = args[2] ?? process.env.SOURCE_URL;
let collection = null;
// A correction and the report that cites it come from the same ingest, so a
// stale report cannot keep pointing at an older revision.
if (address) {
  const { records, pages } = await readAllPages(new SourceClient(address), entryPath);
  collection = { pages, ...(await service.ingestBatch(records)) };
}
const view = await readOperations(service.repository, { population, date });
const { dailyReport } = view;
console.log(JSON.stringify({
  collection,
  status: dailyReport.status,
  coverage: dailyReport.coverage,
  missingStations: dailyReport.missingStations,
  notReceivedStations: dailyReport.notReceivedStations,
  incompleteStations: dailyReport.incompleteStations,
  undeterminedSummaries: dailyReport.undeterminedSummaries,
  dailyReport,
}, null, 2));
