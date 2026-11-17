import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository, ObservationRepository } from './repository.js';
import { CollectionService, ObservationService } from './service.js';
import { readDailyReport } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const observations = new ObservationService(new ObservationRepository(resolve(here, '../var/observations.json')));
const commands = ['ingest', 'query', 'ingest-observations', 'report'];
const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | ingest-observations [文件] | report [站点清单]',
    commands,
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'ingest-observations') {
  const items = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await observations.ingest(items), null, 2));
} else if (action === 'report') {
  const population = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/population.json'), 'utf8'));
  console.log(JSON.stringify(await readDailyReport(observations.repository, population), null, 2));
} else {
  throw new Error(`action must be one of: ${commands.join(', ')}`);
}
