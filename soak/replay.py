#!/usr/bin/env python3
"""Replay failing fake model seeds twice while a bounded campaign runs."""
import concurrent.futures, json, os, pathlib, subprocess, time
root = pathlib.Path(__file__).resolve().parent.parent
logs = pathlib.Path(os.environ['TEMP']) / 'soak'
source = logs / 'model' / 'results.json'
out = logs / 'replay'
out.mkdir(parents=True, exist_ok=True)
if (out / 'results.json').exists():
    raise SystemExit('use a fresh TEMP; replay evidence already exists')
end = time.monotonic() + 70 * 60
results = []
seen = set()
def replay(seed):
    rows = []
    for i in range(1, 3):
        if time.monotonic() >= end:
            break
        start = time.monotonic()
        with (out / f'{seed}-{i}.log').open('w') as f:
            try:
                code = subprocess.run(['node', 'test/model.test.mjs'], cwd=root,
                    env=dict(os.environ, MODEL_SEED=str(seed)), stdout=f, stderr=subprocess.STDOUT,
                    timeout=min(180, max(1, end-start))).returncode
            except subprocess.TimeoutExpired:
                code = 124
        rows.append(dict(seed=seed, repeat=i, code=code, seconds=round(time.monotonic()-start, 3)))
    return rows
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    while time.monotonic() < end:
        try:
            campaign = json.loads(source.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(2)
            continue
        todo = [r['index'] for r in campaign if r['code'] == 1 and r['index'] not in seen][:2]
        if not todo:
            # An unchanged result file for four minutes means the bounded campaign ended.
            if time.time() - source.stat().st_mtime > 240:
                break
            time.sleep(5)
            continue
        for rows in pool.map(replay, todo):
            results.extend(rows)
            if rows:
                seen.add(rows[0]['seed'])
        (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(dict(seeds=len(seen), runs=len(results), passed=sum(r['code']==0 for r in results), failed=sum(r['code']==1 for r in results), timeouts=sum(r['code']==124 for r in results))), flush=True)
