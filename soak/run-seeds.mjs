// Soak runner for the seeded model tests (test only; engine code untouched).
// The tests always start at seed 1000 (model, auth.model) or 1 (cache), so this makes a patched copy of the
// test file in soak/.gen/ whose seed list starts at SEED_BASE, then runs it with MODEL_SEEDS=SEED_COUNT.
//
// usage: node soak/run-seeds.mjs <model|auth.model|cache> <base> <count> [logDir]
// split example (6 procs x 3334 seeds): run with base 1000, 4334, 7668, ... in parallel.
// A failing seed is replayed alone 3 times with MODEL_SEED (model, auth.model) to check it is deterministic.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [suite, baseArg, countArg, logDir = process.env.TEMP || '.'] = process.argv.slice(2);
const base = Number(baseArg), count = Number(countArg);
if (!['model', 'auth.model', 'cache'].includes(suite) || !Number.isInteger(base) || !Number.isInteger(count)) {
  console.error('usage: node soak/run-seeds.mjs <model|auth.model|cache> <base> <count> [logDir]');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'test', `${suite}.test.mjs`), 'utf8');
const patched = suite === 'cache'
  ? src.replace('for (let seed = 1; seed <= seeds; seed++)', `for (let seed = ${base}; seed < ${base} + seeds; seed++)`)
  : src.replace('(_, i) => 1000 + i', `(_, i) => ${base} + i`);
if (patched === src) { console.error('seed line not found; test file changed?'); process.exit(2); }
// generated copy lives in test/ so its relative imports still resolve; it is untracked and not committed
mkdirSync(logDir, { recursive: true });
const gen = join(logDir, `.soak-${suite}-${base}.test.mjs`);
const relocated = patched.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, rel, b) => a + pathToFileURL(join(root, 'test', rel)).href + b);
writeFileSync(gen, relocated);
mkdirSync(logDir, { recursive: true });
const env = { ...process.env, MODEL_SEEDS: String(count) };
delete env.MODEL_SEED;
const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', gen], { env, cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
const out = (r.stdout || '') + (r.stderr || '');
writeFileSync(join(logDir, `soak-${suite}-${base}.log`), out);
const failedSeeds = suite === 'cache'
  ? [...out.matchAll(/not ok \d+ - seed (\d+):/g)].map(m => Number(m[1]))
  : [...out.matchAll(/^\s*seed (\d+)(?: \(held\))? failed/gm)].map(m => Number(m[1]));
console.log(`${suite} base=${base} count=${count} exit=${r.status} failedSeeds=${[...new Set(failedSeeds)].join(',') || 'none'}`);
writeFileSync(join(logDir, `soak-${suite}-${base}.json`), JSON.stringify({suite,base,count,status:r.status,failedSeeds:[...new Set(failedSeeds)]}));
if (true) {
  for (const seed of new Set(failedSeeds)) {
    let bad = 0;
    for (let i = 0; i < 3; i++) {
      const replayFile = suite === 'cache' ? gen : join(root, 'test', `${suite}.test.mjs`);
      const rr = spawnSync(process.execPath, ['--test', '--test-isolation=none', replayFile], { env: { ...process.env, MODEL_SEED: String(seed), MODEL_SEEDS: '1' }, cwd: root, encoding: 'utf8' });
      writeFileSync(join(logDir, `replay-${suite}-${seed}-${i+1}.log`), (rr.stdout || '') + (rr.stderr || ''));
      if (rr.status !== 0) bad++;
    }
    console.log(`  replay seed ${seed}: ${bad}/3 failed (MODEL_SEED=${seed} node --test test/${suite}.test.mjs)`);
  }
}
process.exit(r.status === 0 ? 0 : 1);
