// The signed-in account as the engine hands it to apps, and the claims check; shared by createApp (app.js) and the
// auth module (auth.js).
/** @typedef {{ uid: string, email: string, name: string, photo: string, verified: boolean }} AppUser */
/** @param {any} s */
const lc = s => String(s || '').trim().toLowerCase();
/** @param {any} u @returns {AppUser | null} */
export const userOf = u => u ? { uid: u.uid, email: lc(u.email), name: u.displayName || u.email || '', photo: u.photoURL || '', verified: u.emailVerified === true } : null;
// the token is behind the role doc: its v is older, or the doc is gone and the token still has one
/** @param {{ v?: any } | null | undefined} entry @param {{ v?: any }} [tokenClaims] @returns {boolean} */
export const claimsBehind = (entry, tokenClaims = {}) => !entry ? tokenClaims.v != null : !(Number(tokenClaims.v) >= (Number.isInteger(entry.v) ? entry.v : 0));
