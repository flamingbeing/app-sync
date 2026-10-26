"""Fake-backend soak: six Node processes maximum; generated tests and logs in TEMP.
Usage: python soak/run.py [--quick]
"""
import concurrent.futures as cf
import json, os, pathlib, re, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(os.environ['TEMP']) / ('sync-soak-' + time.strftime('%Y%m%d-%H%M%S') if '--fresh' in sys.argv else 'sync-soak')
OUT.mkdir(exist_ok=True)
DEADLINE = time.time() + 65 * 60
(OUT/'driver.pid').write_text(str(os.getpid()))
QUICK = '--quick' in sys.argv

def execute(suite, base, count, repeat=None, replay_index=None):
    key = f'{suite}-{base}-{count}' if repeat is None else f'{suite}-repeat-{repeat}'
    if replay_index is not None: key += f'-replay-{replay_index}'
    source = ROOT / 'test' / f'{suite}.test.mjs'
    if repeat is None:
        text = source.read_text()
        if suite == 'cache':
            old = 'for (let seed = 1; seed <= seeds; seed++)'
            new = f'for (let seed = {base}; seed < {base} + seeds; seed++)'
        else:
            old, new = '(_, i) => 1000 + i', f'(_, i) => {base} + i'
        assert old in text
        text = text.replace(old, new)
        text = re.sub(r'''(from\s+['"])(\.\.?/[^'"]+)(['"])''', lambda m: m[1] + (source.parent / m[2]).resolve().as_uri() + m[3], text)
        target = OUT / f'{key}.mjs'
        target.write_text(text)
    else:
        target = source
    env = dict(os.environ, MODEL_SEEDS=str(count))
    env.pop('MODEL_SEED', None)
    log = OUT / f'{key}.log'
    with log.open('w') as f:
        command = ['node', str(ROOT/'soak/threaded.mjs'),str(target),str(base),str(count)] if suite == 'model' and count > 1 else ['node', '--test', '--test-isolation=none', '--test-reporter=tap', str(target)]
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=f, stderr=subprocess.STDOUT, timeout=590)
    text = log.read_text()
    seeds = sorted(set(map(int, re.findall(r'^\s*#?\s*seed (\d+)(?: \(held\))? failed', text, re.M)))) if suite != 'cache' else sorted(set(map(int, re.findall(r'not ok \d+ - seed (\d+):', text))))
    row = dict(suite=suite,base=base,count=count,repeat=repeat,status=result.returncode,failedSeeds=seeds,threaded=suite=='model' and count>1)
    (OUT / f'{key}.json').write_text(json.dumps(row))
    return row

def task(suite, base, count, repeat=None):
    if time.time() > DEADLINE: return {'skipped':True}
    row = execute(suite,base,count,repeat)
    if row['status']:
        row['replays'] = [execute(suite,seed,1,repeat,k+1) for seed in row['failedSeeds'] for k in range(3)] if repeat is None else [execute(suite,base,count,repeat,k+1) for k in range(3)]
    return row

if __name__ == '__main__':
    start=time.time()
    jobs=[]
    for suite,total,base in [('auth.model',5000,1000),('cache',5000,1),('model',20000,1000)]:
        total = 10 if QUICK else total
        for offset in range(0,total,50): jobs.append((suite,base+offset,min(50,total-offset),None))
    for suite in ['faults','held','writes','sync','fixes']:
        for repeat in range(1,(1 if QUICK else 200)+1): jobs.append((suite,0,0,repeat))
    if '--suite' in sys.argv:
        selected = sys.argv[sys.argv.index('--suite')+1]
        jobs = [j for j in jobs if j[0] == selected]
        if not jobs: raise SystemExit('unknown suite')
    print('Logs:',OUT,flush=True)
    jobs.sort(key=lambda j: j[0] == 'model')
    prior = json.loads((OUT/'results.json').read_text()) if (OUT/'results.json').exists() and not QUICK else []
    done = {(r.get('suite'),r.get('base'),r.get('count'),r.get('repeat')) for r in prior}
    jobs = [j for j in jobs if j not in done]
    results=prior
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        pending={pool.submit(task,*job):job for job in jobs}
        for future in cf.as_completed(pending):
            try: row=future.result()
            except Exception as error: row=dict(job=pending[future],error=str(error))
            if row.get('skipped'): continue
            results.append(row)
            (OUT/'results.json').write_text(json.dumps(results,indent=2))
            if len(results)%10==0 or 'error' in row: print(f'{len(results)}/{len(jobs)} elapsed={time.time()-start:.1f}s last={row}',flush=True)
    print('COMPLETE',len(results),'elapsed',time.time()-start,flush=True)
