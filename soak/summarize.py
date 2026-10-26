"""Summarize the completed soak runs; all output stays in TEMP."""
import collections,json,os,pathlib,re
out=pathlib.Path(os.environ['TEMP'])/'sync-soak'
rows=json.loads((out/'results.json').read_text())
summary={}
failure_groups=collections.defaultdict(list)
for suite in ['model','auth.model','cache','faults','held','writes','sync','fixes']:
    records=[r for r in rows if r.get('suite')==suite]
    seeded=suite in ['model','auth.model','cache']
    runs=sum(r['count'] if seeded else 1 for r in records)
    failures=sum(len(r['failedSeeds']) if seeded else int(bool(r['status'])) for r in records)
    unknown=sum(bool(r['status']) and not r['failedSeeds'] for r in records) if seeded else 0
    flaky=0
    for r in records:
        replays=r.get('replays',[])
        if seeded:
            for seed in r['failedSeeds']:
                checks=[p for p in replays if p['base']==seed]
                if checks and any(p['status']==0 for p in checks): flaky+=1
            key=f"{suite}-{r['base']}-{r['count']}"
            text=(out/f'{key}.log').read_text()
            current=None
            for line in text.splitlines():
                match=re.match(r'\s*#?\s*seed (\d+)(?: \(held\))? failed',line)
                if match: current=int(match[1])
                line=line.strip()
                if current is not None and (re.match(r'd\d+ (shows|save|chose|still|note|answer)',line) or "lost (server" in line):
                    group=re.sub(r'd\d+', 'DEVICE',line)
                    group=re.sub(r'([nt])\d+',r'\1ID',group)
                    group=re.sub(r'server .*','server …',group)
                    failure_groups[group].append(current)
        elif r['status'] and replays and any(p['status']==0 for p in replays): flaky+=1
    summary[suite]=dict(runs=runs,passed=runs-failures,failed=failures,flaky=flaky,unclassifiedBatches=unknown)
print(json.dumps(summary,indent=2))
print('Errors:',[r for r in rows if 'error' in r])
print('Failure classes:',json.dumps({k:sorted(set(v)) for k,v in failure_groups.items()},indent=2))
(out/'summary.json').write_text(json.dumps(summary,indent=2))
