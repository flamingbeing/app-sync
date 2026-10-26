// Three isolated model-test realms per Node host. Logs remain in the supplied TEMP directory.
import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [file, baseText, countText] = process.argv.slice(2);
const base=Number(baseText), count=Number(countText), source=readFileSync(file,'utf8');
const counts=Array.from({length:3},(_,i)=>Math.floor(count/3)+(i<count%3?1:0));
let start=base;
const results=await Promise.all(counts.filter(n=>n>0).map((n,index)=>{
  const target=file.replace(/\.mjs$/,`-thread-${index}.mjs`);
  const old=`(_, i) => ${base} + i`;
  if (!source.includes(old)) throw new Error('model seed selector not found');
  writeFileSync(target,source.replace(old,`(_, i) => ${start} + i`));
  start+=n;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(pathToFileURL(target),{stdout:true,stderr:true,env:{...process.env,MODEL_SEEDS:String(n)}});
    worker.stdout.pipe(process.stdout); worker.stderr.pipe(process.stderr);
    worker.on('error',reject); worker.on('exit',resolve);
  });
}));
process.exitCode=results.some(code=>code!==0)?1:0;
