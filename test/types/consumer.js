// An app's page, type-checked against the generated types through the import-map names (README "Types"): tsc
// resolves @core/* with `paths` and the version's types/*.d.ts. Run: tsc -p test/types
import { createApp } from '@core/app';
import { auth } from '@core/auth';
import { sync } from '@core/sync';
import { update } from '@core/update';

/** @param {{ register: () => void }} register */
export function start(register) {
  return createApp({
    config: { name: 'fixture', sdk: async () => ({}) },
    modules: [auth({ popupOnly: true }), sync({ colls: ['items'], path: (/** @type {string} */ s) => s }), update({ register, app: 'fixture' })],
  });
}
// @ts-expect-error popupOnly is a boolean: the types are real, not any
auth({ popupOnly: 'yes' });
