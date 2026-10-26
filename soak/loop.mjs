// Loop one test file N times and count passes, failures and flakes (test only).
// usage: node soak/loop.mjs <test file, e.g. test/faults.test.mjs> [runs=200] [logDir]
// "flaky" = the file failed in the loop but passed when rerun alone 3 times; a file that fails all 3 reruns is deterministic.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const [file, runsArg = '200', logDir = process.env.TEMP || '.'] = process.argv.slice(2);
if (!file) { console.error('usage: node soak/loop.mjs <test file> [runs] [logDir]'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(logDir, { recursive: true });
const runs = Number(runsArg);
let pass = 0, fail = 0, flaky = 0, deterministic = 0;
for (let i = 1; i <= runs; i++) {
  const r = spawnSync(process.execPath, ['--test', file], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 0) { pass++; continue; }
  fail++;
  writeFileSync(join(logDir, `loop-${basename(file)}-${i}.log`), (r.stdout || '') + (r.stderr || ''));
  let again = 0;
  for (let k = 0; k < 3; k++) if (spawnSync(process.execPath, ['--test', file], { cwd: root }).status !== 0) again++;
  if (again === 0) flaky++; else deterministic++;
  console.log(`  repeat ${i}: failed; rerun alone failed ${again}/3`);
}
console.log(`${file} runs=${runs} pass=${pass} fail=${fail} flaky=${flaky} deterministic=${deterministic}`);
