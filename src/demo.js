import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository, ObservationRepository } from './repository.js';
import { CollectionService, ObservationService } from './service.js';
import { readDailyReport } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const client = new SourceClient(source.url);
  const collection = new CollectionService(new RecordRepository(join(directory, 'records.json')));
  const observations = new ObservationService(new ObservationRepository(join(directory, 'observations.json')));
  const population = JSON.parse(await readFile(new URL('../fixtures/population.json', import.meta.url), 'utf8'));

  const collect = async () => {
    const page = parsePage(await client.read(entryPath));
    await collection.ingest(page.records);
    return observations.ingest(page.records);
  };

  const reports = {};
  await collect();
  reports.opening = await readDailyReport(observations.repository, population);
  source.publish('updated');
  await collect();
  reports.updated = await readDailyReport(observations.repository, population);
  source.publish('corrected');
  await collect();
  reports.corrected = await readDailyReport(observations.repository, population);
  console.log(JSON.stringify(reports, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
