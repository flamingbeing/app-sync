// The Vite check (c) locally (npm run vite): pack this checkout as npm would publish it (package.json "files"), install
// the tarball into test/vite/.package/, and build the page there against the installed exports (build.mjs package).
// CI does the same from the git ref (github: install). Needs vite (dev dependency only).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../..'), DIR = path.join(HERE, '.package');
const npm = (args, cwd) => execFileSync('npm', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR);
const tgz = npm(['pack', '--silent', '--pack-destination', DIR], ROOT).split('\n').pop();
for (const f of ['index.html', 'main.js', 'build.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(DIR, f));
fs.writeFileSync(path.join(DIR, 'package.json'), '{ "private": true, "type": "module" }\n');
npm(['install', '--no-package-lock', '--no-audit', '--no-fund', '--offline', './' + tgz], DIR);
execFileSync(process.execPath, ['build.mjs', 'package'], { cwd: DIR, stdio: 'inherit' });   // (vite resolves from the repo's node_modules)
