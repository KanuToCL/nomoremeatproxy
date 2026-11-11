import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeHost } from '../src/doctor.mjs';

const DOCTOR = fileURLToPath(new URL('../tools/doctor.mjs', import.meta.url));
const tail = `(${os.release()}), ${os.arch()}`;

test('the host line names the distribution and version from os-release', () => {
  const ubuntu = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\nID=ubuntu\n';
  assert.equal(describeHost(ubuntu), `Ubuntu 24.04.5 LTS ${tail}`);
  // Without PRETTY_NAME, the name and version id; unquoted values are read too.
  assert.equal(describeHost('NAME=Alpine\nVERSION_ID=3.20.1\n'), `Alpine 3.20.1 ${tail}`);
});

test('without os-release the host line is what the system reports', () => {
  assert.equal(describeHost(null), `${os.version()} ${tail}`);
});

// Runs the real command line, so every probe runs read-only on this machine; the state folder
// is placed under a regular file, which makes that required row missing on any machine.
test('doctor exits 1 when a required row is missing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomeat-doctor-exit-'));
  writeFileSync(path.join(dir, 'a-file'), '');
  const env = { ...process.env, NOMEAT_STATE_DIR: path.join(dir, 'a-file', 'state'), CODEX_HOME: dir, CLAUDE_CONFIG_DIR: dir };
  const run = spawnSync(process.execPath, [DOCTOR, '--json'], { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(run.status, 1);
  const { rows } = JSON.parse(run.stdout);
  assert.equal(rows.find((row) => row.id === 'state-folder').status, 'missing');
});
