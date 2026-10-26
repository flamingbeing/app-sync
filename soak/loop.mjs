// Loop one test file N times and count passes, failures and flakes (test only).
// usage: node soak/loop.mjs <test file, e.g. test/faults.test.mjs> [runs=200] [logDir]
// "flaky" = the file failed in the loop but passed on at least one of 3 isolated reruns; a file that fails all 3 reruns is deterministic.
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
  const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 0) { pass++; continue; }
  fail++;
  writeFileSync(join(logDir, `loop-${basename(file)}-${i}.log`), (r.stdout || '') + (r.stderr || ''));
  let again = 0;
  for (let k = 0; k < 3; k++) {
    const rr = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(logDir, `replay-${basename(file)}-${i}-${k+1}.log`), (rr.stdout || '') + (rr.stderr || ''));
    if (rr.status !== 0) again++;
  }
  if (again < 3) flaky++; else deterministic++;
  console.log(`  repeat ${i}: failed; rerun alone failed ${again}/3`);
}
console.log(`${file} runs=${runs} pass=${pass} fail=${fail} flaky=${flaky} deterministic=${deterministic}`);

writeFileSync(join(logDir, `loop-${basename(file)}.json`), JSON.stringify({file,runs,pass,fail,flaky,deterministic}));

process.exitCode = fail ? 1 : 0;
