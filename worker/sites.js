// The Cloudflare Worker for this repo's addresses. It serves the repo's files (the static assets, bound as ASSETS)
// and decides which folder an address may see (routes.js). No data, no storage: just files.
// wrangler.jsonc: "run_worker_first" sends every request here.
import { resolve } from './routes.js';

const NOINDEX = 'noindex, nofollow';
// a released version's files never change: browsers and the CDN may keep them for a year. The list of versions can.
const VERSIONED = /^\/sync\/\d+\.\d+\.\d+\/.+\.(js|json)$|^\/sync\/\d+\.\d+\.\d+\/(LICENSE|NOTICE)$/;
const LISTING = '/sync/versions.json';
// public code, no cookies or credentials, so any app origin may import it
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const url = new URL(request.url);
    if (url.pathname !== LISTING && !VERSIONED.test(url.pathname)) return notFound();   // no folder listings, no other files
    const r = resolve(url.hostname, url.pathname);
    if (r.redirect) return redirect(url, r.redirect);
    if (r.notFound) return notFound();

    // a folder (address ending in "/") serves its index.html
    let file = r.file;
    if (file === '' || file.endsWith('/')) file += 'index.html';
    let res = await asset(env, url, file);
    if (res.status === 404 && !/\.[^/]+$/.test(file)) {
      // no such file, but a folder of that name: send the browser to the address with a "/" (as GitHub Pages does)
      const dir = await asset(env, url, file + '/index.html');
      if (dir.status === 200) return redirect(url, url.pathname + '/');
    }
    if (res.status === 404) return notFound();
    res = new Response(res.body, res);
    res.headers.set('X-Robots-Tag', NOINDEX);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    res.headers.set('Cache-Control', url.pathname === LISTING ? 'public, max-age=300' : 'public, max-age=31536000, immutable');
    if (url.pathname.endsWith('.js')) res.headers.set('Content-Type', 'text/javascript; charset=utf-8');
    else if (url.pathname.endsWith('.json')) res.headers.set('Content-Type', 'application/json; charset=utf-8');
    else res.headers.set('Content-Type', 'text/plain; charset=utf-8');
    return res;
  },
};

const asset = (env, url, file) => env.ASSETS.fetch(new Request(new URL('/' + file, url), { method: 'GET' }));
const redirect = (url, path) => Response.redirect(new URL(path + url.search, url).toString(), 301);
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NOINDEX } });
