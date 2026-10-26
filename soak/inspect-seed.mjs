// Add read-only timestamp diagnostics to a single model seed. Redirect stdout to TEMP.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const seed=Number(process.argv[2]);
if (!Number.isSafeInteger(seed)) throw new Error('usage: node soak/inspect-seed.mjs <seed>');
process.env.MODEL_SEED=String(seed);
let source=readFileSync(join(root,'test/model.test.mjs'),'utf8');
const marker='  await until(agreed, 3000);';
if (!source.includes(marker)) throw new Error('model diagnostic insertion point changed');
source=source.replace(marker,marker+`\n  console.log('SOAK_DIAGNOSTIC '+JSON.stringify({seed,held,docs:[...shared.docs],devices:devs.map(d=>({name:d.name,tasks:d.views.tasks,tombs:Object.fromEntries(tasks.map(id=>[id,d.app.hub.tomb(S,'tasks',id)]))}))}));`);
source=source.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,(_,a,rel,b)=>a+pathToFileURL(join(root,'test',rel)).href+b);
const target=join(process.env.TEMP,`model-diagnostic-${seed}.mjs`);
writeFileSync(target,source);
await import(pathToFileURL(target).href);
