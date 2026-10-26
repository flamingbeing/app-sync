// Soak runner for the seeded model tests (test only; engine code untouched).
// The tests always start at seed 1000 (model, auth.model) or 1 (cache), so this makes a patched copy of the
// test file in the external log directory whose seed list starts at SEED_BASE, then runs it with MODEL_SEEDS=SEED_COUNT.
// Also supports running the 1.3.10 failing seed list:
//   node soak/run-seeds.mjs model failed [all|offset:count] [logDir]
//
// usage: node soak/run-seeds.mjs <model|auth.model|cache> <base|failed> <count|all|offset:count> [logDir]
// A failing seed is replayed alone 3 times with MODEL_SEED (model, auth.model) to check it is deterministic.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FAILED_SEEDS_1_3_10 = [
  1069, 1076, 1111, 1120, 1158, 1227, 1237, 1252, 1287, 1315, 1325, 1408, 1475, 1491, 1510, 1524, 1577, 1650, 1690, 1708,
  1762, 1796, 1801, 1841, 1862, 1915, 1923, 1927, 1979, 2053, 2133, 2148, 2235, 2245, 2249, 2354, 2387, 2426, 2429, 2473,
  2496, 2683, 2737, 2776, 2816, 2882, 3031, 3184, 3201, 3342, 3395, 3465, 3534, 3682, 3690, 3712, 3746, 3768, 3822, 3827,
  3881, 3975, 3980, 4023, 4044, 4133, 4180, 4265, 4410, 4530, 4560, 4594, 4696, 4715, 4721, 4756, 4836, 4885, 4995, 5046,
  5213, 5241, 5328, 5373, 5389, 5397, 5478, 5528, 5603, 5614, 5742, 5814, 5912, 5932, 5950, 6070, 6128, 6130, 6228, 6260,
  6281, 6326, 6342, 6378, 6414, 6517, 6654, 6707, 6720, 6721, 6747, 6805, 6807, 6856, 6889, 6906, 6962, 6964, 6991, 7070,
  7093, 7098, 7175, 7416, 7469, 7471, 7498, 7582, 7671, 7697, 7751, 7849, 7858, 7903, 7907, 7984, 8009, 8044, 8077, 8172,
  8228, 8251, 8264, 8305, 8339, 8416, 8459, 8583, 8657, 8852, 8883, 8935, 8945, 8946, 8988, 8998, 9054, 9087, 9121, 9135,
  9162, 9344, 9397, 9412, 9540, 9651, 9792, 9817, 9822, 9830, 9959, 9969, 9978, 9994, 10036, 10072, 10106, 10177, 10201,
  10218, 10251, 10364, 10473, 10512, 10514, 10551, 10601, 10634, 10664, 10800, 10801, 10840, 10918, 11039, 11048, 11052,
  11067, 11085, 11097, 11102, 11133, 11148, 11170, 11216, 11237, 11388, 11434, 11489, 11519, 11532, 11640, 11658, 11712,
  11809, 11865, 11946, 11956, 11997, 12066, 12105, 12130, 12285, 12332, 12357, 12441, 12443, 12530, 12543, 12547, 12597,
  12627, 12671, 12681, 12713, 12750, 12804, 12805, 12827, 12927, 12998, 12999, 13037, 13080, 13084, 13169, 13324, 13332,
  13355, 13477, 13675, 13741, 13756, 13758, 13897, 13928, 13940, 13968, 13980, 14023, 14095, 14098, 14121, 14151, 14164,
  14181, 14221, 14233, 14269, 14288, 14321, 14452, 14498, 14530, 14531, 14556, 14608, 14653, 14690, 14777, 14957, 14963,
  14973, 15030, 15049, 15186, 15191, 15192, 15202, 15249, 15268, 15294, 15368, 15376, 15516, 15524, 15526, 15603, 15680,
  15703, 15767, 15798, 15801, 15898, 16159, 16263, 16316, 16351, 16424, 16535, 16544, 16566, 16799, 16871, 16875, 16911,
  17035, 17136, 17154, 17158, 17218, 17230, 17237, 17282, 17298, 17347, 17363, 17381, 17532, 17546, 17622, 17694, 17701,
  17718, 17729, 17792, 17818, 17994, 18003, 18032, 18057, 18162, 18176, 18190, 18248, 18276, 18468, 18480, 18486, 18512,
  18583, 18667, 18753, 18810, 18824, 18843, 18887, 19004, 19033, 19042, 19045, 19109, 19121, 19150, 19244, 19274, 19323,
  19401, 19439, 19443, 19444, 19470, 19648, 19806, 19809, 19831, 19857, 19965, 19974, 20044, 20114, 20154, 20228, 20257,
  20275, 20353, 20529, 20541, 20547, 20565, 20669, 20687, 20691, 20701, 20723, 20802, 20942, 20973
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseModelDetails(out) {
  const details = [];
  let mode = 'model';
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:not )?ok 1 - model:/.test(line)) mode = 'model (held conflicts, 0.6.3)';
    else if (/^(?:not )?ok 2 - model \(held conflicts, 0.6.3\):/.test(line)) mode = 'model (held conflicts with a merge collection, 0.7.1)';
    const m = line.match(/^\s*#?\s*seed (\d+)(?: \(held\))? failed/);
    if (m) {
      const seed = Number(m[1]);
      const mismatches = [];
      for (let j = i + 2; j < lines.length; j++) {
        const sub = lines[j];
        if (/^\s*#?\s*seed \d+/.test(sub) || /^(?:not )?ok \d+/.test(sub) || /^\s*---\s*$/.test(sub)) break;
        const clean = sub.replace(/^\s*#?\s*/, '').trim();
        if (clean && !clean.startsWith('steps:')) mismatches.push(clean);
      }
      details.push({
        seed,
        mode,
        mismatch: mismatches.join('; ') || 'assertion failed',
        replay: `$env:MODEL_SEED='${seed}'; node --test --test-isolation=none test/model.test.mjs`
      });
    }
  }
  return details;
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

async function runFailedList(spec, logDir, maxWorkers = 2) {
  mkdirSync(logDir, { recursive: true });
  let targetSeeds = FAILED_SEEDS_1_3_10;
  if (spec && spec !== 'all' && spec.includes(':')) {
    const [off, len] = spec.split(':').map(Number);
    targetSeeds = FAILED_SEEDS_1_3_10.slice(off, off + len);
  } else if (spec && spec !== 'all' && Number.isInteger(Number(spec))) {
    targetSeeds = FAILED_SEEDS_1_3_10.slice(0, Number(spec));
  }
  const src = readFileSync(join(root, 'test', 'model.test.mjs'), 'utf8');
  const relocatedBase = src.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, rel, b) => a + pathToFileURL(join(root, 'test', rel)).href + b);
  const seedLine = 'const seeds = one || [...new Set([...Array.from({ length: count }, (_, i) => 1000 + i), ...FIXED])];';
  if (!relocatedBase.includes(seedLine)) {
    console.error('seed line not found in test/model.test.mjs');
    process.exit(2);
  }
  const batchSize = 25;
  const batches = [];
  for (let i = 0; i < targetSeeds.length; i += batchSize) {
    batches.push({ index: Math.floor(i / batchSize), offset: i, seeds: targetSeeds.slice(i, i + batchSize) });
  }
  const batchResults = [];
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const b = batches[cursor++];
      const tag = `failed-${b.offset}-${b.seeds.length}`;
      const gen = join(logDir, `.soak-model-${tag}.test.mjs`);
      writeFileSync(gen, relocatedBase.replace(seedLine, `const seeds = one || [${b.seeds.join(', ')}];`));
      const env = { ...process.env, MODEL_SEEDS: String(b.seeds.length) };
      delete env.MODEL_SEED;
      const r = await runAsync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', gen], { env, cwd: root });
      const out = (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '');
      writeFileSync(join(logDir, `soak-model-${tag}.log`), out);
      const failedSeeds = [...new Set([...out.matchAll(/^\s*#?\s*seed (\d+)(?: \(held\))? failed/gm)].map(m => Number(m[1])))];
      const details = parseModelDetails(out);
      const replays = {};
      for (const seed of failedSeeds) {
        replays[seed] = [];
        let bad = 0;
        for (let k = 0; k < 3; k++) {
          const rr = await runAsync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', join(root, 'test', 'model.test.mjs')], {
            env: { ...process.env, MODEL_SEED: String(seed), MODEL_SEEDS: '1' },
            cwd: root
          });
          const rout = (rr.stdout || '') + (rr.stderr || '');
          writeFileSync(join(logDir, `replay-model-${seed}-${k + 1}.log`), rout);
          replays[seed].push(rr.status);
          if (rr.status !== 0) bad++;
        }
        console.log(`  replay seed ${seed}: ${bad}/3 failed (MODEL_SEED=${seed} node --test test/model.test.mjs)`);
      }
      const row = { suite: 'model', tag, offset: b.offset, count: b.seeds.length, seeds: b.seeds, status: r.status, failedSeeds, details, replays };
      writeFileSync(join(logDir, `soak-model-${tag}.json`), JSON.stringify(row, null, 2));
      batchResults.push(row);
      console.log(`model ${tag} count=${b.seeds.length} exit=${r.status} failedSeeds=${failedSeeds.join(',') || 'none'}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxWorkers, batches.length) }, () => worker()));
  batchResults.sort((a, b) => a.offset - b.offset);
  const allFailedSeeds = [...new Set(batchResults.flatMap(b => b.failedSeeds))];
  const allDetails = batchResults.flatMap(b => b.details);
  const allReplays = Object.assign({}, ...batchResults.map(b => b.replays));
  let flaky = 0, deterministic = 0;
  for (const seed of allFailedSeeds) {
    const statuses = allReplays[seed] || [];
    if (statuses.some(s => s === 0)) flaky++; else deterministic++;
  }
  const summary = {
    suite: 'model',
    mode: 'failed-1.3.10',
    seeds: targetSeeds.length,
    runs: targetSeeds.length * 3,
    seedPass: targetSeeds.length - allFailedSeeds.length,
    seedFail: allFailedSeeds.length,
    modePass: targetSeeds.length * 3 - allDetails.length,
    modeFail: allDetails.length,
    flaky,
    deterministic,
    unclassifiedBatchFailures: batchResults.filter(b => b.status !== 0 && b.failedSeeds.length === 0).length,
    failedSeeds: allFailedSeeds,
    details: allDetails,
    replays: allReplays
  };
  writeFileSync(join(logDir, 'soak-model-failed.json'), JSON.stringify(summary, null, 2));
  console.log(`model failed-1.3.10 total seeds=${summary.seeds} seedPass=${summary.seedPass} seedFail=${summary.seedFail} modeRuns=${summary.runs} modePass=${summary.modePass} modeFail=${summary.modeFail} flaky=${flaky} deterministic=${deterministic}`);
  process.exit(summary.seedFail || summary.unclassifiedBatchFailures ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [suite, baseArg, countArg = 'all', logDir = process.env.TEMP || '.'] = process.argv.slice(2);
  if (suite === 'model' && baseArg === 'failed') {
    await runFailedList(countArg, logDir, 2);
  } else {
    const base = Number(baseArg), count = Number(countArg);
    if (!['model', 'auth.model', 'cache'].includes(suite) || !Number.isInteger(base) || !Number.isInteger(count)) {
      console.error('usage: node soak/run-seeds.mjs <model|auth.model|cache> <base|failed> <count|all> [logDir]');
      process.exit(2);
    }
    const src = readFileSync(join(root, 'test', `${suite}.test.mjs`), 'utf8');
    const patched = suite === 'cache'
      ? src.replace('for (let seed = 1; seed <= seeds; seed++)', `for (let seed = ${base}; seed < ${base} + seeds; seed++)`)
      : src.replace('(_, i) => 1000 + i', `(_, i) => ${base} + i`);
    if (!(suite === 'cache' ? src.includes('for (let seed = 1; seed <= seeds; seed++)') : src.includes('(_, i) => 1000 + i'))) { console.error('seed line not found; test file changed?'); process.exit(2); }
    mkdirSync(logDir, { recursive: true });
    const gen = join(logDir, `.soak-${suite}-${base}.test.mjs`);
    const relocated = patched.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, rel, b) => a + pathToFileURL(join(root, 'test', rel)).href + b);
    writeFileSync(gen, relocated);
    const env = { ...process.env, MODEL_SEEDS: String(count) };
    delete env.MODEL_SEED;
    const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', gen], { env, cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
    const out = (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '');
    writeFileSync(join(logDir, `soak-${suite}-${base}.log`), out);
    const failedSeeds = suite === 'cache'
      ? [...out.matchAll(/not ok \d+ - seed (\d+):/g)].map(m => Number(m[1]))
      : [...out.matchAll(/^\s*#?\s*seed (\d+)(?: \(held\))? failed/gm)].map(m => Number(m[1]));
    console.log(`${suite} base=${base} count=${count} exit=${r.status} failedSeeds=${[...new Set(failedSeeds)].join(',') || 'none'}`);
    writeFileSync(join(logDir, `soak-${suite}-${base}.json`), JSON.stringify({ suite, base, count, status: r.status, failedSeeds: [...new Set(failedSeeds)] }));
    for (const seed of new Set(failedSeeds)) {
      let bad = 0;
      for (let i = 0; i < 3; i++) {
        if (suite === 'cache') writeFileSync(gen, relocated.replace(`for (let seed = ${base}; seed < ${base} + seeds; seed++)`, `for (let seed = ${seed}; seed < ${seed} + seeds; seed++)`));
        const replayFile = suite === 'cache' ? gen : join(root, 'test', `${suite}.test.mjs`);
        const rr = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', replayFile], { env: { ...process.env, MODEL_SEED: String(seed), MODEL_SEEDS: '1' }, cwd: root, encoding: 'utf8' });
        writeFileSync(join(logDir, `replay-${suite}-${seed}-${i + 1}.log`), (rr.stdout || '') + (rr.stderr || ''));
        if (rr.status !== 0) bad++;
      }
      console.log(`  replay seed ${seed}: ${bad}/3 failed (MODEL_SEED=${seed} node --test test/${suite}.test.mjs)`);
    }
    process.exit(r.status === 0 ? 0 : 1);
  }
}
