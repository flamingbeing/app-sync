// Sign-in method (1.3.0): a link sent by email. emailLink({ url, win }) -> a method for auth({ methods })
// (src/auth.js). signIn({ method: 'emailLink', email }) sends the link (-> reason 'sent'); on the page the link opens,
// the same call signs in with it. The engine keeps no email: the app keeps it, or asks again.
//   url: where the link leads (default: this page, without its query). win: the browser's, for tests.
/** @typedef {import('../auth.js').AuthMethod} AuthMethod */

/** @param {{ url?: string, win?: any }} [options] @returns {AuthMethod} */
export function emailLink(options = {}) {
  return {
    name: 'emailLink',
    async signIn({ A, auth }, { email = '' }) {
      if (!email) throw new Error('signIn: emailLink needs the email');
      const { location } = options.win || window;
      if (A.isSignInWithEmailLink(auth, location.href)) return { credential: A.EmailAuthProvider.credentialWithLink(email, location.href) };
      await A.sendSignInLinkToEmail(auth, email, { url: options.url || location.origin + location.pathname, handleCodeInApp: true });
      return { reason: 'sent' };
    },
  };
}
