/** Print demo requests from the website. */
import { db } from './db.js';
const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
if (!rows.length) console.log('No demo requests yet.');
for (const r of rows) {
  console.log(`${new Date(r.created_at).toISOString().slice(0, 16)}  ${r.name} <${r.contact}>  ${r.clinic || ''} ${r.island ? '· ' + r.island : ''} ${r.doctors ? '· ' + r.doctors + ' doctors' : ''}\n    ${r.message || ''}`);
}
db.close();
