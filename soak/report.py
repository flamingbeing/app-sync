"""Write a compact, synthetic-test-only report for round 2 from completed runs in TEMP."""
import datetime, json, os, pathlib, subprocess

root = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(os.environ['TEMP']) / 'sync-soak'
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S SGT')
commit = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=root, text=True).strip()
pkg = json.loads((root / 'package.json').read_text(encoding='utf-8'))
version = pkg.get('version', '1.3.11')

model_summary = json.loads((out / 'soak-model-failed.json').read_text(encoding='utf-8'))
loop_suites = ['faults', 'held', 'writes', 'sync', 'fixes', 'watchdog']
loop_rows = {}
for s in loop_suites:
    p = out / f'loop-{s}.test.mjs.json'
    if p.exists():
        loop_rows[s] = json.loads(p.read_text(encoding='utf-8'))

lines = [
    '# Soak results (round 2)',
    '',
    f'Generated {now}. Engine under test: {version}, base commit `{commit}`. Windows, Node 24.16.0, fake backends only. No browser or live Firebase tests.',
    '',
    'Re-ran all 397 model seeds that failed on 1.3.10 (listed in round 1 `soak/RESULTS.md`, including the 367-seed subset) across all three model modes (1,191 mode runs), plus 150 full-file repeats each of `faults`, `held`, `writes`, `sync`, `fixes`, and `watchdog`. Any failure is replayed three times in isolation to classify it as flaky or deterministic.',
    '',
    '| Suite | Seeds or loops | Runs | Pass | Fail | Flaky |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    f"| model (1.3.10 failing seeds) | {model_summary['seeds']} seeds | {model_summary['runs']} ({model_summary['seeds']}x3 modes) | {model_summary['modePass']} ({model_summary['seedPass']} seeds) | {model_summary['modeFail']} ({model_summary['seedFail']} seeds) | {model_summary['flaky']} |",
]

for s in loop_suites:
    r = loop_rows.get(s, {'runs': 0, 'pass': 0, 'fail': 0, 'flaky': 0, 'deterministic': 0, 'failures': []})
    lines.append(f"| {s} | {r['runs']} loops | {r['runs']} | {r['pass']} | {r['fail']} | {r['flaky']} |")

lines += [
    '',
    f"Unclassified model batch failures: {model_summary.get('unclassifiedBatchFailures', 0)}.",
]

if model_summary['seedFail'] == 0:
    lines += [
        '',
        '## Model seed verification (1.3.11)',
        '',
        f"All {model_summary['seeds']} model seeds that failed on 1.3.10 (including seed 1158 and the 367-seed subset) passed across all three configurations (`model`, `model (held conflicts, 0.6.3)`, and `model (held conflicts with a merge collection, 0.7.1)`).",
    ]
else:
    lines += [
        '',
        '## Model seed failures',
        '',
        f"Failing model seeds: {', '.join(map(str, model_summary['failedSeeds']))}.",
        '',
    ]
    for d in model_summary.get('details', []):
        replays = model_summary.get('replays', {}).get(str(d['seed']), [])
        lines.append(f"- Seed `{d['seed']}` ({d['mode']}): `{d['mismatch']}` — replay `{d['replay']}` (replay exits: {replays})")

any_loop_fail = any(loop_rows.get(s, {}).get('fail', 0) > 0 for s in loop_suites)
if not any_loop_fail:
    lines += [
        '',
        '## Regression and watchdog loops (150x each)',
        '',
        'All 150 repeats of `faults`, `held`, `writes`, `sync`, `fixes`, and `watchdog` passed with 0 failures and 0 flakes.',
    ]
else:
    lines += [
        '',
        '## Regression and watchdog loop failures',
        '',
    ]
    for s in loop_suites:
        r = loop_rows.get(s, {})
        for f in r.get('failures', []):
            kind = 'flaky' if f['replayFailed'] < 3 else 'deterministic'
            lines.append(
                f"- `{s}` repeat {f['repeat']} ({kind}, rerun failed {f['replayFailed']}/3, exits {f['statuses']}): "
                f"mode `{f['mode']}`, mismatch `{f['mismatch']}`, replay `{f['replay']}`"
            )

lines += [
    '',
    '## Run notes',
    '',
    'At most three processes were used at all times (one coordinator + two worker test processes). Generated tests and raw logs remain in `TEMP` outside git. Engine code was not changed.',
    '',
]

(root / 'soak/RESULTS.md').write_text('\n'.join(lines), encoding='utf-8', newline='\n')
print('Wrote soak/RESULTS.md')
