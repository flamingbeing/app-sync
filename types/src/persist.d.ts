/** @param {{ storage?: { persisted?: () => Promise<boolean>, persist?: () => Promise<boolean> } } | undefined} [nav] @returns {Promise<{ supported: boolean, persisted: boolean }>} */
export function persistGuard(nav?: {
    storage?: {
        persisted?: () => Promise<boolean>;
        persist?: () => Promise<boolean>;
    };
} | undefined): Promise<{
    supported: boolean;
    persisted: boolean;
}>;
