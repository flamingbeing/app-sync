// Sign-in method (1.3.0): email and password. password() -> a method for auth({ methods }) (src/auth.js); it signs in
// with signIn({ method: 'password', email, password }). Making the account is the app's (Firebase's own call).
/** @typedef {import('../auth.js').AuthMethod} AuthMethod */

/** @returns {AuthMethod} */
export function password() {
  return {
    name: 'password',
    async signIn({ A }, { email = '', password: secret = '' }) {
      if (!email || !secret) throw new Error('signIn: password needs the email and the password');
      return { credential: A.EmailAuthProvider.credential(email, secret) };
    },
  };
}
