import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = 'bin/nomeat.mjs';
const PNG = 'docs/assets/not-a-meat-proxy.png';
const SHEBANG = /^#!\/usr\/bin\/env node\n/;

function fixture(t) {
  const base = process.env.NOMEAT_PACKAGE_TEST_ROOT ?? os.tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'nomeat-line-endings-'));
  t.diagnostic(`Line-ending fixture retained at ${dir}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const config = path.join(dir, 'gitconfig');
  const template = path.join(dir, 'empty-template');
  writeFileSync(config, '');
  mkdirSync(template);
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config,
    NOMEAT_STATE_DIR: path.join(dir, 'uncreated-state'), CODEX_HOME: path.join(dir, 'uncreated-codex'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'uncreated-claude') });
  const run = (command, args, cwd = ROOT) => spawnSync(command, args, {
    cwd, env, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  const git = (args, cwd = ROOT) => run('git', ['-c', 'core.autocrlf=true', ...args], cwd);
  return { dir, env, template, run, git };
}

function requireGit(t, git) {
  const result = git(['--version']);
  if (result.error?.code === 'ENOENT') {
    t.skip('Git is unavailable; Git blob and checkout checks were not run');
    return false;
  }
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString());
  return true;
}

function output(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString());
  return result.stdout;
}

test('tracked Git text blobs and executable CLI retain LF', (t) => {
  const { git } = fixture(t);
  if (!requireGit(t, git)) return;
  if (!existsSync(path.join(ROOT, '.git'))) {
    t.skip('No source Git metadata; indexed-blob checks were not run');
    return;
  }
  // The index mirrors committed blobs on a clean checkout and also covers staged changes.
  const cr = git(['grep', '--cached', '-I', '-l', '\r', '--', '.']);
  assert.equal(cr.status, 1, cr.error?.message ?? cr.stdout.toString() + cr.stderr.toString());
  assert.match(output(git(['show', `:${BIN}`])).toString('utf8'), SHEBANG);
  assert.match(output(git(['ls-files', '--stage', '--', BIN])).toString('utf8'), /^100755 /);
});

test('attributes normalize Git blobs and autocrlf checkouts without changing PNG bytes', (t) => {
  const { dir, template, git } = fixture(t);
  if (!requireGit(t, git)) return;
  const source = path.join(dir, 'source');
  const checkout = path.join(dir, 'checkout');
  mkdirSync(source);
  mkdirSync(checkout);
  for (const name of ['.gitattributes', BIN, PNG]) {
    const target = path.join(source, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(ROOT, name)));
  }
  writeFileSync(path.join(source, 'probe.txt'), 'alpha\r\nβeta\r\n');
  output(git(['init', `--template=${template}`], source));
  output(git(['add', '--', '.gitattributes', BIN, PNG, 'probe.txt'], source));
  const expected = Buffer.from('alpha\nβeta\n');
  const bin = output(git(['show', `:${BIN}`], source));
  const png = readFileSync(path.join(ROOT, PNG));
  assert.deepEqual(output(git(['show', ':probe.txt'], source)), expected);
  assert.match(bin.toString('utf8'), SHEBANG);
  assert.deepEqual(output(git(['show', `:${PNG}`], source)), png);
  output(git(['checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`], source));
  assert.deepEqual(readFileSync(path.join(checkout, 'probe.txt')), expected);
  assert.deepEqual(readFileSync(path.join(checkout, BIN)), bin);
  assert.deepEqual(readFileSync(path.join(checkout, PNG)), png);
});

test('the CLI executes directly under an available POSIX runtime without creating state', (t) => {
  const { env, run } = fixture(t);
  const bash = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe');
  if (process.platform === 'win32' && !existsSync(bash)) {
    t.skip('No Git Bash; direct POSIX-style execution was not run on Windows');
    return;
  }
  env.PATH = path.dirname(process.execPath) + path.delimiter + env.PATH;
  const result = process.platform === 'win32'
    ? run(bash, ['--noprofile', '--norc', '-c', `exec ./${BIN} --help`])
    : run(path.join(ROOT, BIN), ['--help']);
  assert.match(output(result).toString('utf8'), /nomeat orient/);
  for (const key of ['NOMEAT_STATE_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) assert.equal(existsSync(env[key]), false);
  if (process.platform === 'win32') t.diagnostic('Git Bash on Windows is not native Linux/macOS validation');
});
