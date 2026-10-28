// app-sync 1.5.0: the Firestore adapter for the sync module (src/module-firestore.js): sync({ adapter: firestore(options) }),
// options as sync()'s backend. Without an adapter sync() still loads it itself (the 1.x default).
export { firestore, createFirestoreBackend } from '../src/module-firestore.js';
