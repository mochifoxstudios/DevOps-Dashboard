const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compareVersions } = require('../agent/lib/dep-parsers');

test('parses package.json deps + devDeps with kind', () => {
  const rows = parse('package.json', JSON.stringify({
    dependencies: { express: '^4.19.2', chokidar: '5.0.0' },
    devDependencies: { jest: '^29.0.0' }
  }));
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.express.current, '4.19.2');   // caret stripped
  assert.equal(byName.express.kind, 'runtime');
  assert.equal(byName.jest.kind, 'dev');
  assert.equal(rows.length, 3);
});

test('parses requirements.txt, skipping comments', () => {
  const rows = parse('requirements.txt', '# comment\nflask==2.3.0\nrequests>=2.0\n\n');
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ['flask', 'requests']);
  assert.equal(rows[0].current, '2.3.0');
});

test('parses go.mod require block', () => {
  const rows = parse('go.mod', 'module x\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n');
  assert.equal(rows[0].name, 'github.com/foo/bar');
  assert.equal(rows[0].current, 'v1.2.3');
});

test('parses package-lock.json v3 packages map (deduped, dev flag)', () => {
  const rows = parse('package-lock.json', JSON.stringify({
    name: 'app', lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/express': { version: '4.19.2' },
      'node_modules/@types/node': { version: '20.1.0', dev: true },
      'node_modules/express/node_modules/debug': { version: '2.6.9' }
    }
  }));
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.express.current, '4.19.2');
  assert.equal(byName['@types/node'].current, '20.1.0');
  assert.equal(byName['@types/node'].kind, 'dev');
  assert.equal(byName.debug.current, '2.6.9'); // nested package picked up
  assert.equal(rows.length, 3);
});

test('parses yarn.lock v1 blocks (scoped + plain)', () => {
  const rows = parse('yarn.lock', '# yarn lockfile v1\n\nexpress@^4.19.2:\n  version "4.19.2"\n  resolved "x"\n\n"@types/node@^20.0.0":\n  version "20.1.0"\n');
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.express.current, '4.19.2');
  assert.equal(byName['@types/node'].current, '20.1.0');
});

test('parses pnpm-lock.yaml packages keys (scoped + plain)', () => {
  const rows = parse('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\npackages:\n\n  /express@4.19.2:\n    resolution: {integrity: sha512-x}\n\n  /@babel/core@7.24.0:\n    resolution: {integrity: sha512-y}\n");
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.express.current, '4.19.2');
  assert.equal(byName['@babel/core'].current, '7.24.0');
});

test('compareVersions orders semver correctly', () => {
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});
