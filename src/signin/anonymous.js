// Sign-in method (1.3.0): an anonymous account. anonymous() -> a method for auth({ methods }) (src/auth.js). A real
// account signed in later links to it (the auth module), so its uid and the device's data stay.
/** @typedef {import('../auth.js').AuthMethod} AuthMethod */

/** @returns {AuthMethod} */
export function anonymous() {
  return {
    name: 'anonymous',
    async signIn({ A, auth }) {
      if (!auth.currentUser) await A.signInAnonymously(auth);   // (anyone signed in already: nothing to do)
      return {};
    },
  };
}
