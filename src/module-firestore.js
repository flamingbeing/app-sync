// app-sync 1.5.0: the Firestore adapter as its own entry (@core/sync/firestore, sync/firestore.js), for
// sync({ adapter: firestore(options) }). A page that passes its own adapter loads none of it.
export { firestore, createFirestoreBackend } from './firestore.js';
