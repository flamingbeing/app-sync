// app-sync 0.9.0: the auth module for createApp({ config, modules }) (app.js): sign-in, the claims, and sign-out that
// keeps the device's data (src/auth.js). 1.3.0: the sign-in methods, each its own export (a page bundles those it uses).
export { auth } from './src/auth.js';
export { emailLink } from './src/signin/email-link.js';
export { password } from './src/signin/password.js';
export { passcode } from './src/signin/passcode.js';
export { anonymous } from './src/signin/anonymous.js';
