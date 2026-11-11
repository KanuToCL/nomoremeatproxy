// Sections: expected inventory / manifest guards / offline artifact and installed CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const EXPECTED = [
  'LICENSE', 'README.md', 'package.json', 'bin/nomeat.mjs',
  'src/adapters/claude-attended.mjs', 'src/adapters/claude.mjs', 'src/adapters/codex-app.mjs',
  'src/adapters/codex-cli.mjs', 'src/adapters/codex-daemon.mjs', 'src/adapters/codex-transport.mjs',
  'src/adapters/codex.mjs', 'src/adapters/opener.mjs', 'src/call.mjs', 'src/check.mjs',
  'src/doctor-live.mjs', 'src/doctor.mjs', 'src/history/claude.mjs', 'src/history/codex.mjs',
  'src/history/compact.mjs', 'src/history/folder.mjs', 'src/history/index.mjs',
  'src/history/match.mjs', 'src/history/render.mjs', 'src/ledger.mjs', 'src/listen.mjs',
  'src/listener-lease.mjs', 'src/mailbox.mjs', 'src/orient.mjs', 'src/peers.mjs',
  'src/remote-control-store.mjs', 'src/remote-control.mjs', 'src/standing.mjs',
  'src/stats.mjs', 'src/usage.mjs', 'src/writable.mjs', 'tools/doctor.mjs',
  'docs/usage.md', 'docs/assets/not-a-meat-proxy.png', 'templates/peer-calls.md',
].sort();

test('the publishable manifest exposes only nomeat and explicit runtime/documentation files', () => {
  assert.equal(metadata.name, 'nomoremeatproxy');
  assert.equal(metadata.version, '0.1.0');
  assert.equal(metadata.license, 'MIT');
  assert.notEqual(metadata.private, true);
  assert.equal(metadata.engines.node, '>=22.15');
  assert.deepEqual(metadata.bin, { nomeat: 'bin/nomeat.mjs' });
  assert.deepEqual(metadata.publishConfig, { registry: 'https://registry.npmjs.org/' });
  assert.deepEqual([...metadata.files].sort(), EXPECTED.filter(name => !['LICENSE', 'README.md', 'package.json'].includes(name)));
  assert.match(readFileSync(new URL('../bin/nomeat.mjs', import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('the package has no dependencies, bundled dependencies or install/pack/publish hooks', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(Object.keys(metadata[field] ?? {}), [], field);
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) assert.deepEqual(metadata[field] ?? [], [], field);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare',
    'postprepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish']) {
    assert.equal(Object.hasOwn(metadata.scripts, hook), false, hook);
  }
});

test('offline npm artifact installs a working read-only executable without source-only files', async (t) => {
  const npmCli = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find(candidate => candidate?.endsWith('.js') && existsSync(candidate));
  assert.ok(npmCli, 'Run with npm test so npm_execpath identifies the matching npm CLI');
  const base = process.env.NOMEAT_PACKAGE_TEST_ROOT ?? os.tmpdir();
  mkdirSync(base, { recursive: true });
  const fixture = mkdtempSync(path.join(base, 'nomeat-package-'));
  // Retain artifact/config/output fixtures for inspection; set this base outside the checkout.
  t.diagnostic(`Offline package fixture retained at ${fixture}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|npm_token$|node_auth_token$)/i.test(key)));
  for (const key of ['userconfig', 'globalconfig']) {
    env[`NPM_CONFIG_${key.toUpperCase()}`] = path.join(fixture, `${key}.npmrc`);
    writeFileSync(env[`NPM_CONFIG_${key.toUpperCase()}`], '');
  }
  Object.assign(env, { NPM_CONFIG_CACHE: path.join(fixture, 'cache'), NPM_CONFIG_PREFIX: path.join(fixture, 'prefix'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    NOMEAT_STATE_DIR: path.join(fixture, 'uncreated-state'), CODEX_HOME: path.join(fixture, 'uncreated-codex'),
    CLAUDE_CONFIG_DIR: path.join(fixture, 'uncreated-claude') });
  const record = (name, executable, args, cwd, environment = env) => {
    const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8',
      windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(path.join(fixture, `${name}.log`), `status: ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`);
    assert.equal(result.status, 0, `${name}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  const npm = (name, args, cwd = ROOT) => record(name, process.execPath,
    [npmCli, '--offline', '--ignore-scripts', '--json', ...args], cwd);
  const [dry] = JSON.parse(npm('pack-dry-run', ['pack', '--dry-run']));
  const [packed] = JSON.parse(npm('pack-artifact', ['pack', '--pack-destination', fixture]));

  await t.test('dry-run and tarball inventories match the exact approved shipping list', () => {
    assert.deepEqual(dry.files.map(file => file.path).sort(), EXPECTED);
    assert.deepEqual(packed.files.map(file => file.path).sort(), EXPECTED);
    assert.equal(packed.integrity, dry.integrity);
    assert.equal(packed.size, dry.size);
    assert.equal(packed.unpackedSize, dry.unpackedSize);
    assert.equal(packed.bundled.length, 0);
    assert.equal(packed.entryCount, EXPECTED.length);
  });

  await t.test('all packaged documentation links and images resolve inside the inventory', () => {
    for (const name of ['README.md', 'docs/usage.md', 'templates/peer-calls.md']) {
      const doc = readFileSync(path.join(ROOT, name), 'utf8');
      const targets = [...doc.matchAll(/\]\(([^)]+)\)|<img\b[^>]*\bsrc="([^"]+)"/g)];
      for (const match of targets) {
        const target = match[1] ?? match[2];
        if (/^(#|[a-z][a-z\d+.-]*:)/i.test(target)) continue;
        const local = path.posix.normalize(path.posix.join(path.posix.dirname(name), target.split('#')[0]));
        assert.ok(EXPECTED.includes(local), `${name}: omitted local target ${target}`);
      }
    }
  });

  await t.test('offline one-off tarball execution runs nomeat without a global install', () => {
    const oneOff = path.join(fixture, 'one-off');
    mkdirSync(oneOff);
    assert.match(npm('exec-artifact', ['exec', '--yes', '--package', path.join(fixture, packed.filename), '--', 'nomeat', '--help'], oneOff), /nomeat orient/);
    assert.deepEqual(readdirSync(oneOff), []);
    for (const key of ['NOMEAT_STATE_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) assert.equal(existsSync(env[key]), false);
  });

  const install = path.join(fixture, 'consumer');
  mkdirSync(install);
  writeFileSync(path.join(install, 'package.json'), '{"private":true}\n');
  npm('install-artifact', ['install', '--no-save', '--package-lock=false', path.join(fixture, packed.filename)], install);
  const shim = path.join(install, 'node_modules', '.bin', process.platform === 'win32' ? 'nomeat.cmd' : 'nomeat');
  assert.ok(existsSync(shim));
  const state = env.NOMEAT_STATE_DIR;
  const cliEnv = { ...env, PATH: path.dirname(process.execPath) };
  const cli = (name, args) => process.platform === 'win32'
    ? record(name, path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '$cliArgs = ConvertFrom-Json -InputObject $env:NOMEAT_PACKAGE_ARGS; & $env:NOMEAT_PACKAGE_SHIM @cliArgs; exit $LASTEXITCODE'],
      install, { ...cliEnv, NOMEAT_PACKAGE_SHIM: shim, NOMEAT_PACKAGE_ARGS: JSON.stringify(args) })
    : record(name, shim, args, install, cliEnv);
  const before = readdirSync(fixture).sort();

  await t.test('the npm-installed executable serves help, peers and orientation with isolated state', () => {
    assert.match(cli('installed-help', ['--help']), /nomeat orient/);
    const peers = JSON.parse(cli('installed-peers', ['peers']));
    assert.deepEqual(Object.keys(peers).sort(), ['astra', 'fable', 'opus', 'sol']);
    const result = JSON.parse(cli('installed-orient', ['orient', '--from', 'astra', '--cwd', install]));
    assert.equal(result.project, install);
    assert.equal(result.state.location, state);
    assert.equal(result.state.access.exists, false);
    assert.equal(result.routes.length, 6);
    assert.ok(result.listeners.every(listener => listener.registration === null));
    assert.match(result.listenerNote, /not tested/);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(cliEnv.CODEX_HOME), false);
    assert.equal(existsSync(cliEnv.CLAUDE_CONFIG_DIR), false);
    assert.deepEqual(readdirSync(fixture).filter(name => !name.startsWith('installed-')).sort(), before);
  });
});
