// An app's page, type-checked against the generated types through the import-map names (README "Types"): tsc
// resolves @core/* with `paths` and the version's types/*.d.ts. Run: tsc -p test/types
import { createApp, VERSION } from '@core/app';
import { auth } from '@core/auth';
import { sync, leaveEntry } from '@core/sync';
import { update } from '@core/update';
import { firestore } from '@core/sync/firestore';

/** @param {{ register: () => void }} register */
export function start(register) {
  return createApp({
    config: { name: 'fixture', sdk: async () => ({}) },
    modules: [auth({ popupOnly: true }), sync({ colls: ['items'], path: (/** @type {string} */ s) => s }), update({ register, app: 'fixture' })],
  });
}
// @ts-expect-error popupOnly is a boolean: the types are real, not any
auth({ popupOnly: 'yes' });
// 0.9.3: the version and the delete-to-bin entry from the entries alone (no index.js)
/** @type {string} */ export const version = VERSION;
export const gone = leaveEntry('item', { id: 'r1', updatedAt: 5 });
// 1.5.0: the Firestore adapter from its own entry, its options typed
export const withFirestore = sync({ colls: ['items'], path: (/** @type {string} */ s) => s, adapter: firestore({ field: 'modifiedAt' }) });
// @ts-expect-error time is 'ms' or 'iso'
firestore({ time: 'later' });
