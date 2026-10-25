// Sign-in method (1.3.0): a passcode the app's server swaps for a sign-in token. passcode({ url, fetch }) -> a method
// for auth({ methods }) (src/auth.js). signIn({ method: 'passcode', code, email }) POSTs { code, email? } (JSON) to url;
// an answer { token } (a Firebase custom token) is what the auth module signs in with, any other answer is reason
// 'refused'.
//   fetch: the browser's, for tests.
/** @typedef {import('../auth.js').AuthMethod} AuthMethod */

/** @param {{ url: string, fetch?: typeof fetch }} [options] @returns {AuthMethod} */
export function passcode(options) {
  if (!options?.url) throw new Error('auth: passcode needs its url: methods: [passcode({ url })]');
  return {
    name: 'passcode',
    async signIn(_sdk, { code = '', email = '' }) {
      const r = await (options.fetch || fetch)(options.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(email ? { code, email } : { code }),
      });
      const token = r.ok ? (await r.json())?.token : '';
      return token ? { token } : { reason: 'refused' };
    },
  };
}
