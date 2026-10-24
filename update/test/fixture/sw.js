const VERSION = 'demo-v1';
const SHELL = ['./', 'app.js', 'style.css', 'offline.html', '__CORE__/register.js'];
const MANIFEST = {};
importScripts('__CORE__/sw-core.js');
AppUpdate.init({ app: 'demo', version: VERSION, shell: SHELL, manifest: MANIFEST, offline: 'offline.html' });
