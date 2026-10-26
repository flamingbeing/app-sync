// Loop one or more test files N times and count passes, failures and flakes (test only).
// usage: node soak/loop.mjs <test file(s), comma-separated, e.g. test/faults.test.mjs> [runs=200] [logDir]
// "flaky" = the file failed in the loop but passed on at least one of 3 isolated reruns; a file that fails all 3 reruns is deterministic.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const [fileArg, runsArg = '200', logDir = process.env.TEMP || '.'] = process.argv.slice(2);
if (!fileArg) { console.error('usage: node soak/loop.mjs <test file(s)> [runs] [logDir]'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(logDir, { recursive: true });
const runs = Number(runsArg);
const files = fileArg.split(',').map(s => s.trim()).filter(Boolean);

function parseTapFailure(out, file) {
  const lines = out.split(/\r?\n/);
  const notOk = lines.find(l => /^not ok \d+\s*-/.test(l)) || '';
  const testName = notOk.replace(/^not ok \d+\s*-\s*/, '').trim() || basename(file);
  const msgLine = lines.find(l => /^\s*(?:error|message|actual|expected|AssertionError):/i.test(l)) || lines.find(l => /Error/.test(l)) || '';
  return {
    mode: testName,
    mismatch: msgLine.trim() || 'non-zero exit',
    replay: `node --test --test-isolation=none ${file}`
  };
}

function runAsync(cmd, args, opts) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, opts);
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', error => resolve({ status: 1, stdout, stderr, error }));
    child.on('close', status => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

if (files.length === 1) {
  const file = files[0];
  let pass = 0, fail = 0, flaky = 0, deterministic = 0;
  const failures = [];
  for (let i = 1; i <= runs; i++) {
    const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status === 0) { pass++; continue; }
    fail++;
    const out = (r.stdout || '') + (r.stderr || '');
    writeFileSync(join(logDir, `loop-${basename(file)}-${i}.log`), out);
    let again = 0;
    const statuses = [];
    for (let k = 0; k < 3; k++) {
      const rr = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8' });
      writeFileSync(join(logDir, `replay-${basename(file)}-${i}-${k + 1}.log`), (rr.stdout || '') + (rr.stderr || ''));
      statuses.push(rr.status ?? 1);
      if (rr.status !== 0) again++;
    }
    if (again < 3) flaky++; else deterministic++;
    const info = parseTapFailure(out, file);
    failures.push({ repeat: i, replayFailed: again, statuses, ...info });
    console.log(`  ${file} repeat ${i}: failed; rerun alone failed ${again}/3 (${info.mode})`);
  }
  console.log(`${file} runs=${runs} pass=${pass} fail=${fail} flaky=${flaky} deterministic=${deterministic}`);
  writeFileSync(join(logDir, `loop-${basename(file)}.json`), JSON.stringify({ file, runs, pass, fail, flaky, deterministic, failures }, null, 2));
  process.exitCode = fail ? 1 : 0;
} else {
  // Multi-file mode with at most 2 concurrent child processes (total processes <= 3 including this coordinator).
  const maxWorkers = 2;
  const state = new Map(files.map(file => [file, { file, runs, pass: 0, fail: 0, flaky: 0, deterministic: 0, failures: [] }]));
  const tasks = [];
  for (const file of files) {
    for (let i = 1; i <= runs; i++) tasks.push({ file, repeat: i });
  }
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const { file, repeat: i } = tasks[cursor++];
      const st = state.get(file);
      const r = await runAsync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], { cwd: root });
      if (r.status === 0) {
        st.pass++;
      } else {
        st.fail++;
        const out = (r.stdout || '') + (r.stderr || '');
        writeFileSync(join(logDir, `loop-${basename(file)}-${i}.log`), out);
        let again = 0;
        const statuses = [];
        for (let k = 0; k < 3; k++) {
          const rr = await runAsync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], { cwd: root });
          writeFileSync(join(logDir, `replay-${basename(file)}-${i}-${k + 1}.log`), (rr.stdout || '') + (rr.stderr || ''));
          statuses.push(rr.status ?? 1);
          if (rr.status !== 0) again++;
        }
        if (again < 3) st.flaky++; else st.deterministic++;
        const info = parseTapFailure(out, file);
        st.failures.push({ repeat: i, replayFailed: again, statuses, ...info });
        console.log(`  ${file} repeat ${i}: failed; rerun alone failed ${again}/3 (${info.mode})`);
      }
      if (i % 50 === 0 || i === runs) {
        writeFileSync(join(logDir, `loop-${basename(file)}.json`), JSON.stringify(st, null, 2));
        if (i === runs) console.log(`${file} runs=${runs} pass=${st.pass} fail=${st.fail} flaky=${st.flaky} deterministic=${st.deterministic}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxWorkers, tasks.length) }, () => worker()));
  let anyFail = false;
  for (const st of state.values()) {
    st.failures.sort((a, b) => a.repeat - b.repeat);
    writeFileSync(join(logDir, `loop-${basename(st.file)}.json`), JSON.stringify(st, null, 2));
    if (st.fail > 0) anyFail = true;
  }
  process.exitCode = anyFail ? 1 : 0;
}
