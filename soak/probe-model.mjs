// Diagnostic wrapper around the existing fake-backend model; engine and tests stay unchanged.
// MODEL_SEED=1000022 node soak/probe-model.mjs > "$TEMP/probe.log" 2>&1
import fs from 'node:fs';
const sourceURL = new URL('../test/model.test.mjs', import.meta.url);
let source = fs.readFileSync(sourceURL, 'utf8');
source = source.replace(/from '((?:\.\.?\/)[^']+)'/g, (_, spec) => `from '${new URL(spec, sourceURL).href}'`);
const marker = '  const attention = d =>';
if (!source.includes(marker)) throw new Error('model diagnostic insertion point changed');
source = source.replace(marker, `
  for (const d of devs) for (const id of tasks) {
    const remote = shared.docs.get('spaces/' + S + '/tasks/' + id);
    const local = d.shown('tasks', id);
    if (remote && !local) console.log('PROBE ' + JSON.stringify({ seed, held, device: d.name, id,
      tomb: d.app.hub.tomb(S, 'tasks', id), remoteStamp: remote.updatedAt,
      queue: d.app.queue.entries().filter(e => e.record.id === id).map(e => ({ state: e.state, deleted: !!e.record._deleted })) }));
  }
` + marker);
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
