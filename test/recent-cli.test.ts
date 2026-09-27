import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('recent command advertises a bounded, read-only three-day snapshot', () => {
  const run = spawnSync(process.execPath, ['dist/cli.js', 'recent', '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.match(out.data.help, /--days/);
  assert.match(out.data.help, /--dm-threads/);
});
