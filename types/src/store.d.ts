/** @param {StoresOptions} options */
export function createStores({ prefix, colls, metaOnly, realm, realms }: StoresOptions): {
    openStore: (scope: string, wait?: number) => Promise<Store>;
    wipeStores: (keep?: string | string[]) => Promise<void>;
    storeName: (scope: any) => string;
};
export const OPEN_WAIT: 4000;
export type Doc = import("./types.js").Doc;
export type CollMeta = import("./types.js").CollMeta;
export type Store = import("./types.js").Store;
export type StoresOptions = {
    prefix: string;
    colls: string[];
    metaOnly?: string[];
    realm?: string;
    realms?: string[];
};
export type StoreOp = {
    put?: Doc[];
    del?: string[];
    meta?: CollMeta;
    replace?: boolean;
};
