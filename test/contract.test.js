import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('station population is independent of returned observations and quality revisions', async () => {
  const population = await fixture('population');
  const initial = (await observe()).records;
  const changed = (await observe('updated')).records.map((row) => row.attributes);
  assert.equal(initial.length, 1);
  assert.equal(population.stations.length, 2);
  assert.equal(changed[0].revision, 2);
  assert.equal(changed[1].value, null);
  assert.equal(changed[1].reason, 'maintenance');
});
