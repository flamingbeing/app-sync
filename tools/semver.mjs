// Version order for the build tools: x.y.z with an optional pre-release (1.0.0-rc.1 sorts before 1.0.0), as semver orders them.
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const part = s => /^\d+$/.test(s) ? Number(s) : s;
/** @param {string} a @param {string} b */
export function byVersion(a, b) {
  const [x, xp = ''] = a.split(/-(.*)/s), [y, yp = ''] = b.split(/-(.*)/s);
  const xs = x.split('.').map(Number), ys = y.split('.').map(Number);
  const core = xs[0] - ys[0] || xs[1] - ys[1] || xs[2] - ys[2];
  if (core || xp === yp) return core;
  if (!xp || !yp) return xp ? -1 : 1;   // a pre-release comes before its release
  const xi = xp.split('.').map(part), yi = yp.split('.').map(part);
  for (let i = 0; i < Math.max(xi.length, yi.length); i++) {
    if (xi[i] === undefined || yi[i] === undefined) return xi[i] === undefined ? -1 : 1;
    if (xi[i] === yi[i]) continue;
    if (typeof xi[i] === 'number' && typeof yi[i] === 'number') return /** @type {number} */ (xi[i]) - /** @type {number} */ (yi[i]);
    if (typeof xi[i] === 'number') return -1;
    if (typeof yi[i] === 'number') return 1;
    return String(xi[i]) < String(yi[i]) ? -1 : 1;
  }
  return 0;
}
// { latest, versions }: sorted; latest is the last stable version (a pre-release only when there is none)
/** @param {string[]} versions */
export function listing(versions) {
  const sorted = [...versions].sort(byVersion), stable = sorted.filter(v => !v.includes('-'));
  return { latest: (stable.length ? stable : sorted).at(-1), versions: sorted };
}
