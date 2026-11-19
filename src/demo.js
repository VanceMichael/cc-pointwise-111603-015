import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { readAllPages } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const population = {
  stations: ['S1', 'S2'],
  hours: ['2026-11-16T08:00:00Z'],
};
const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  const client = new SourceClient(source.url);

  const opening = await readAllPages(client);
  console.log(JSON.stringify({ stage: 'opening', ingest: await service.ingestBatch(opening.records) }, null, 2));
  console.log(JSON.stringify({
    stage: 'opening',
    report: (await readOperations(repository, { population })).dailyReport,
  }, null, 2));

  source.publish('updated');
  const updated = await readAllPages(client);
  console.log(JSON.stringify({ stage: 'updated', ingest: await service.ingestBatch(updated.records) }, null, 2));
  const view = await readOperations(repository, { population });
  console.log(JSON.stringify({ stage: 'updated', report: view.dailyReport }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
