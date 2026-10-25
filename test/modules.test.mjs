// Run with: node --test test/modules.test.mjs
// The createApp tests (app, held conflicts, model) again, on the modules: createApp({ config, modules: [auth(),
// sync()] }) behind the same api (test/factory.mjs). Each test that is about the one-object createApp only (its
// sign-out wipe, the reasons it gives) says so and is left out here; the modules' own: auth.test, runner.test.
process.env.APP_SYNC_MODULES = '1';
await import('./app.test.mjs');
await import('./held.test.mjs');
await import('./model.test.mjs');
