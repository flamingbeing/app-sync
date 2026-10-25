/**
 * @param {{ storage?: Pick<Storage, 'getItem' | 'setItem'>, open?: (name: string, realm?: string) => import('./types.js').Outbox, key?: string, timeout?: number }} [options]
 * @returns {Registry}
 */
export function createOutboxRegistry({ storage, open, key, timeout }?: {
    storage?: Pick<Storage, "getItem" | "setItem">;
    open?: (name: string, realm?: string) => import("./types.js").Outbox;
    key?: string;
    timeout?: number;
}): Registry;
export const REGISTRY_KEY: "app-sync:outboxes";
export const REGISTRY_TIMEOUT: 3000;
export type OutboxId = import("./types.js").OutboxId;
export type Registry = import("./types.js").Registry;
