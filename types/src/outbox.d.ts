/**
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').Outbox} Outbox
 */
/** @param {{ name: string, realm?: string }} options @returns {Outbox} */
export function createOutbox({ name, realm }: {
    name: string;
    realm?: string;
}): Outbox;
export type Job = import("./types.js").Job;
export type Outbox = import("./types.js").Outbox;
