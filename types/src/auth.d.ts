/**
 * @typedef {import('./user.js').AppUser} AppUser
 * @typedef {{ uid: string, email: string }} Owner
 * @typedef {object} AuthOptions
 * @property {any} [claims] the claims check (url, entry, behind, when, watch, doc, onClaims; above)
 * @property {(r: { from: Owner, to: AppUser }) => any} [beforeSwitch] the app's step before another account's data replaces the last one's
 * @property {boolean} [popupOnly]
 * @property {() => boolean} [redirectFirst]
 * @property {typeof fetch} [fetch]
 * @property {any} [nav]
 * @property {any} [win]
 */
/** @param {AuthOptions} [options] @returns {import('./runner.js').Module} */
export function auth(options?: AuthOptions): import("./runner.js").Module;
export type AppUser = import("./user.js").AppUser;
export type Owner = {
    uid: string;
    email: string;
};
export type AuthOptions = {
    /**
     * the claims check (url, entry, behind, when, watch, doc, onClaims; above)
     */
    claims?: any;
    /**
     * the app's step before another account's data replaces the last one's
     */
    beforeSwitch?: ((r: {
        from: Owner;
        to: AppUser;
    }) => any) | undefined;
    popupOnly?: boolean | undefined;
    redirectFirst?: (() => boolean) | undefined;
    fetch?: typeof fetch | undefined;
    nav?: any;
    win?: any;
};
