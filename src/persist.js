// Ask the browser to keep this site's storage (the outbox and the local copy) instead of clearing it under storage
// pressure, or after days without a visit (Safari in a browser tab). Without it a save still waiting to be sent can
// vanish with the site's data. Call at sign-in; the answer feeds the status rules (status.js: 'at-risk').
// -> { supported, persisted }
/** @param {{ storage?: { persisted?: () => Promise<boolean>, persist?: () => Promise<boolean> } } | undefined} [nav] @returns {Promise<{ supported: boolean, persisted: boolean }>} */
export async function persistGuard(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  const s = nav && nav.storage;
  if (!s || typeof s.persisted !== 'function') return { supported: false, persisted: false };
  try {
    if (await s.persisted()) return { supported: true, persisted: true };
    return { supported: true, persisted: typeof s.persist === 'function' ? !!(await s.persist()) : false };
  } catch { return { supported: true, persisted: false }; }
}
