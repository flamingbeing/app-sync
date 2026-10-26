"""Write a compact, synthetic-test-only report from completed runs in TEMP."""
import collections,datetime,json,os,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
out=pathlib.Path(os.environ['TEMP'])/'sync-soak'
rows=json.loads((out/'results.json').read_text())
now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S SGT')
lines=['# Soak results','',f'Generated {now}. Engine under test: 1.3.10, base commit `0cd4857`. Windows, Node 24.16.0, fake backends only. No browser or live Firebase tests.','',
       'Counts are distinct seeds (model: all three configurations per seed) or full-file repeats. Replay runs are additional. Flaky counts are included in the failure column.','',
       '| Suite | Seeds/repeats | Pass | Fail | Flaky |','| --- | ---: | ---: | ---: | ---: |']
failed_seeds=[]
for suite,target in [('model',20000),('auth.model',5000),('cache',5000),('faults',200),('held',200),('writes',200),('sync',200),('fixes',200)]:
    rr=[r for r in rows if r.get('suite')==suite]
    seeded=suite in ['model','auth.model','cache']
    runs=sum(r['count'] if seeded else 1 for r in rr)
    failures=sum(len(r['failedSeeds']) if seeded else int(bool(r['status'])) for r in rr)
    flaky=0
    for r in rr:
        if seeded:
            for seed in r['failedSeeds']:
                replay=[p for p in r.get('replays',[]) if p['base']==seed]
                assert len(replay)==3, (suite,seed,'missing replays')
                flaky+=any(p['status']==0 for p in replay)
                if suite=='model': failed_seeds.append(seed)
        elif r['status']:
            replay=r.get('replays',[])
            assert len(replay)==3
            flaky+=any(p['status']==0 for p in replay)
    assert not seeded or not any(r['status'] and not r['failedSeeds'] for r in rr), 'unclassified batch failure'
    lines.append(f'| {suite} | {runs}/{target} | {runs-failures} | {failures} | {flaky} |')
covered={seed for r in rows if r.get('suite')=='model' for seed in range(r['base'],r['base']+r['count'])}
missing=sorted(set(range(1000,21000))-covered)
ranges=[]
for seed in missing:
    if ranges and seed==ranges[-1][1]+1: ranges[-1][1]=seed
    else: ranges.append([seed,seed])
lines+=['','Unfinished model seed ranges: '+(', '.join(f'{a}-{b}' for a,b in ranges) if ranges else 'none')+'.']
errors=[r for r in rows if 'error' in r]
lines+=['',f'Infrastructure errors in recorded runs: {len(errors)}.','',
'## Restored task missing from another device','',
'Tests: `model (held conflicts, 0.6.3)` and `model (held conflicts with a merge collection, 0.7.1)`. Representative seed: 1158. Assertion: d1 shows tasks/t1 missing although the server holds the restored task after convergence polling. All three individual replays of 1158 failed.','',
'Hypothesis: restoring an edit after a delete may leave its stamp below a tombstone retained by another device. The listener then suppresses the restored record. This is a hypothesis, not a confirmed code-level diagnosis.','',
'```powershell',"$env:MODEL_SEED='1158'; node --test --test-isolation=none test/model.test.mjs",'```','',
'A read-only diagnostic of seed 1158 found that the missing device retained a tombstone about 66 seconds newer than the restored server record, in both held modes. Raw diagnostic output remains in TEMP.','',
'Failing model seeds: '+', '.join(map(str,sorted(failed_seeds)))+'.','',
'## Timeout/retry timing flake','',
'Test: `a backend call that never settles times out and the save is sent again` in `test/fixes.test.mjs`. Assertion: expected queue status `synced`, observed `pending` after the 40 ms wait following retry.','',
'Hypothesis: timer scheduling under concurrent load delays the timeout/retry path beyond the test window. A pending status at that instant does not by itself prove that the save is lost.','',
'Failed repeat indices and three replay exit statuses:']
for r in sorted([r for r in rows if r.get('suite')=='fixes' and r['status']],key=lambda r:r['repeat']):
    lines.append(f"- {r['repeat']}: "+', '.join(str(p['status']) for p in r['replays']))
lines+=['','Repeat with six workers (intermittent; a single invocation may pass):','','```powershell','python soak/run.py --suite fixes --fresh','```','',
'## Run notes','',
'`npm ci` failed at lifecycle-script spawning in the restricted Windows environment. `npm ci --ignore-scripts --cache "$env:TEMP\\npm-cache" --no-audit --no-fund` completed. These suites use fake backends and do not need the skipped install scripts.','',
'At most six Node host processes. Model batches use three isolated worker-thread realms per host; the fake SDK modifies Date.now, so model scenarios never share one realm concurrently. Individual failing-seed replays use fresh Node processes. Generated tests, raw logs and traces remain outside git in TEMP. Only soak tooling and this derived report are committed. Engine code was not changed.','']
(root/'soak/RESULTS.md').write_text('\n'.join(lines),encoding='utf-8')
print('Wrote soak/RESULTS.md')
