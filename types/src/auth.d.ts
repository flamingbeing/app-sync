/** @param {AuthOptions} [options] @returns {import('./runner.js').Module} */
export function auth(options?: AuthOptions): import("./runner.js").Module;
/**
 * A sign-in method (1.3.0, src/signin/): signIn(sdk, request, anon) -> { credential } to sign in with (linked to anon,
 * the anonymous account signed in, if any), { token } a custom token to sign in with (1.3.6), { reason } when nobody
 * is signed in by it now, or {} once it signed in.
 */
export type AuthMethod = {
    name: string;
    signIn: (sdk: any, request: SignInRequest, anon: any) => Promise<{
        credential?: any;
        token?: string;
        reason?: string;
    }>;
};
/**
 * A sign-in method (1.3.0, src/signin/): signIn(sdk, request, anon) -> { credential } to sign in with (linked to anon,
 * the anonymous account signed in, if any), { token } a custom token to sign in with (1.3.6), { reason } when nobody
 * is signed in by it now, or {} once it signed in.
 */
export type SignInRequest = import("./types.js").SignInRequest & {
    popupOnly?: boolean;
    redirectFirst?: boolean;
};
/**
 * A sign-in method (1.3.0, src/signin/): signIn(sdk, request, anon) -> { credential } to sign in with (linked to anon,
 * the anonymous account signed in, if any), { token } a custom token to sign in with (1.3.6), { reason } when nobody
 * is signed in by it now, or {} once it signed in.
 */
export type AppUser = import("./user.js").AppUser;
/**
 * A sign-in method (1.3.0, src/signin/): signIn(sdk, request, anon) -> { credential } to sign in with (linked to anon,
 * the anonymous account signed in, if any), { token } a custom token to sign in with (1.3.6), { reason } when nobody
 * is signed in by it now, or {} once it signed in.
 */
export type Owner = {
    uid: string;
    email: string;
};
/**
 * A sign-in method (1.3.0, src/signin/): signIn(sdk, request, anon) -> { credential } to sign in with (linked to anon,
 * the anonymous account signed in, if any), { token } a custom token to sign in with (1.3.6), { reason } when nobody
 * is signed in by it now, or {} once it signed in.
 */
export type AuthOptions = {
    /**
     * the ways to sign in (1.3.0; default ['google'])
     */
    methods?: (string | AuthMethod)[] | undefined;
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
