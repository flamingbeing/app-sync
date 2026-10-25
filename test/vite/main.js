// A page that uses auth + sync only. `update` is imported but never used: a source build must shake it out.
import { createApp } from '@core/app';
import { auth } from '@core/auth';
import { sync, replaceRecord } from '@core/sync';   // replaceRecord unused on purpose (1.1.0)
import { update } from '@core/update';   // unused on purpose
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';

const sdk = async () => ({ initializeApp });
export const app = createApp({ config: { name: 'fixture', sdk }, modules: [auth(), sync({ colls: ['items'], path: coll => coll })] });
document.getElementById('out').textContent = 'ready';
