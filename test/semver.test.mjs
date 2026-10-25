import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION_RE, byVersion, listing } from '../tools/semver.mjs';

test('VERSION_RE takes semver pre-release identifiers, hyphens included, and rejects empty ones', () => {
  for (const v of ['1.0.0', '1.0.0-rc.1', '1.0.0-rc-hotfix.1', '1.0.0--x']) assert.ok(VERSION_RE.test(v), v);
  for (const v of ['1.0', '1.0.0-', '1.0.0-rc..1', '1.0.0-.rc', '1.0.0-rc.', 'v1.0.0']) assert.ok(!VERSION_RE.test(v), v);
});

test('pre-releases sort before their release; latest is the last stable', () => {
  const vs = ['1.0.0', '0.8.3', '1.0.0-rc.10', '1.0.0-rc.2', '1.0.0-rc-hotfix.1'];
  assert.deepEqual([...vs].sort(byVersion), ['0.8.3', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-rc-hotfix.1', '1.0.0']);
  assert.equal(listing(vs).latest, '1.0.0');
  assert.equal(listing(['1.0.0-rc.1']).latest, '1.0.0-rc.1');
});
