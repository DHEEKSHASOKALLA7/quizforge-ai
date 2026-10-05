// Tiny document store: Postgres (JSONB) when DATABASE_URL is set, otherwise a JSON file.
const fs = require('fs'), path = require('path');
if (process.env.DATABASE_URL) {
  const pool = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });
  const init = pool.query('create table if not exists docs(coll text, id text, data jsonb, primary key(coll,id))');
  module.exports = {
    async put(c, id, d) { await init; await pool.query('insert into docs values($1,$2,$3) on conflict(coll,id) do update set data=$3', [c, id, d]); },
    async get(c, id) { await init; const r = await pool.query('select data from docs where coll=$1 and id=$2', [c, id]); return r.rows[0] ? r.rows[0].data : null; },
    async list(c) { await init; return (await pool.query('select data from docs where coll=$1', [c])).rows.map(r => r.data); },
  };
} else {
  const F = process.env.DB_FILE || 'data/db.json'; let m = {};
  try { m = JSON.parse(fs.readFileSync(F)); } catch {}
  const flush = () => { fs.mkdirSync(path.dirname(F), { recursive: true }); fs.writeFileSync(F, JSON.stringify(m)); };
  module.exports = {
    async put(c, id, d) { (m[c] = m[c] || {})[id] = d; flush(); },
    async get(c, id) { return (m[c] || {})[id] || null; },
    async list(c) { return Object.values(m[c] || {}); },
  };
}
