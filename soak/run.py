#!/usr/bin/env python3
"""Bounded fake-backend soak; raw TAP and JSON results stay in TEMP."""
import argparse, concurrent.futures, json, os, pathlib, subprocess, time
p = argparse.ArgumentParser()
p.add_argument('suite', choices=['model', 'faults', 'watchdog'])
p.add_argument('--count', type=int, required=True)
p.add_argument('--base', type=int, default=1000000)
p.add_argument('--workers', type=int, default=1)
p.add_argument('--minutes', type=float, default=85)
a = p.parse_args()
if not 1 <= a.workers <= 4 or a.count < 1:
    p.error('use 1..4 workers and a positive count')
root = pathlib.Path(__file__).resolve().parent.parent
logs = pathlib.Path(os.environ['TEMP']) / 'soak' / a.suite
logs.mkdir(parents=True, exist_ok=True)
end = time.monotonic() + a.minutes * 60
results = []
def run(i):
    if time.monotonic() >= end:
        return None
    key = a.base + i if a.suite == 'model' else i + 1
    env = dict(os.environ)
    if a.suite == 'model':
        env['MODEL_SEED'] = str(key)
    log = logs / f'{key}.log'
    cmd = ['node', '--test', '--test-isolation=none', f'test/{a.suite}.test.mjs']
    start = time.monotonic()
    with log.open('w') as out:
        try:
            code = subprocess.run(cmd, cwd=root, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=min(180, max(1, end-start))).returncode
        except subprocess.TimeoutExpired:
            code = 124
    return dict(index=key, code=code, seconds=round(time.monotonic()-start, 3))
# Submit only a worker-sized batch, so reaching the deadline does not leave queued work.
with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
    for offset in range(0, a.count, a.workers):
        batch = list(pool.map(run, range(offset, min(offset+a.workers, a.count))))
        results.extend(r for r in batch if r is not None)
        (logs / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        if len(results) % 20 < a.workers or any(r and r['code'] for r in batch):
            print(json.dumps(dict(suite=a.suite, runs=len(results), failed=[r['index'] for r in results if r['code']])), flush=True)
        if time.monotonic() >= end:
            break
failed = sum(r['code'] != 0 for r in results)
print(json.dumps(dict(suite=a.suite, runs=len(results), passed=len(results)-failed, failed=failed, requested=a.count)), flush=True)
raise SystemExit(bool(failed))
