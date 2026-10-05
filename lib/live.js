// Live quiz state. Redis (or the in-memory stand-in) is the source of truth, so any server instance can serve any player:
//   room:C  static room info (JSON)     meta:C   status/qi/qStart (hash)     pl:C    pid -> player JSON (hash)
//   names:C unique-name lock (hash)     lb:C     leaderboard (SORTED SET)    ans:C:Q pid -> answer (hash, HSETNX = idempotent)
//   cnt:C:Q per-option counters (hash, HINCRBY)                              final:C end-of-quiz payload
const store = require('./store');
const cache = new Map(), TTL = 6 * 3600;
const L = {
  async create(c, info) { cache.set(c, info); await store.set('room:' + c, JSON.stringify(info), 'EX', 86400); await L.meta(c, { status: 'lobby', qi: -1, qStart: 0 }); },
  async info(c) { if (cache.has(c)) return cache.get(c); const v = await store.get('room:' + c); if (!v) return null; const o = JSON.parse(v); cache.set(c, o); return o; },
  async meta(c, patch) {
    if (patch) { for (const [k, v] of Object.entries(patch)) await store.hset('meta:' + c, k, v); return; }
    const m = await store.hgetall('meta:' + c); return m && m.status ? { status: m.status, qi: +m.qi, qStart: +m.qStart } : null;
  },
  async join(c, pid, p) {                                   // atomic unique-name claim across instances
    if (!(await store.hsetnx('names:' + c, p.name.toLowerCase(), pid))) return false;
    await store.hset('pl:' + c, pid, JSON.stringify(p)); await store.zadd('lb:' + c, 0, p.name); return true;
  },
  async player(c, pid) { const v = await store.hget('pl:' + c, pid); return v ? { pid, ...JSON.parse(v) } : null; },
  async players(c) { return Object.entries(await store.hgetall('pl:' + c)).map(([pid, v]) => ({ pid, ...JSON.parse(v) })); },
  count: c => store.hlen('pl:' + c),
  async answer(c, qi, pid, name, choice, ms, dur, correct) {
    const gained = correct ? 500 + Math.round(500 * Math.max(0, 1 - ms / (dur * 1000))) : 0;
    if (!(await store.hsetnx(`ans:${c}:${qi}`, pid, JSON.stringify({ choice, gained, ms })))) return { dup: true };
    const k = `cnt:${c}:${qi}`;
    await store.zincrby('lb:' + c, gained, name); await store.hincrby(k, 'c' + choice, 1);
    if (correct) await store.hincrby(k, 'right', 1);
    return { gained, n: await store.hincrby(k, 'n', 1) };
  },
  async myAnswer(c, qi, pid) { const v = await store.hget(`ans:${c}:${qi}`, pid); return v ? JSON.parse(v) : null; },
  async stats(c, qi) { const h = await store.hgetall(`cnt:${c}:${qi}`); return { counts: [0, 1, 2, 3].map(i => +h['c' + i] || 0), right: +h.right || 0, n: +h.n || 0 }; },
  async board(c, n = 5) { const r = await store.zrevrange('lb:' + c, 0, n - 1, 'WITHSCORES'), o = []; for (let i = 0; i < r.length; i += 2) o.push({ name: r[i], score: +r[i + 1], rank: i / 2 + 1 }); return o; },
  async rank(c, name) { const r = await store.zrevrank('lb:' + c, name); return r === null ? null : r + 1; },
  async score(c, name) { return +(await store.zscore('lb:' + c, name)) || 0; },
  setFinal: (c, f) => store.set('final:' + c, JSON.stringify(f), 'EX', 86400),
  async final(c) { const v = await store.get('final:' + c); return v ? JSON.parse(v) : null; },
  signal: (c, type) => store.publish('ctl', JSON.stringify({ c, type })),
  onSignal: fn => store.subscribeTo('ctl', m => { try { const { c, type } = JSON.parse(m); fn(c, type); } catch {} }),
  async expireAll(c, total) {                                // finished rooms are garbage-collected by TTL
    const ks = ['meta', 'pl', 'names', 'lb'].map(p => p + ':' + c);
    for (let i = 0; i < total; i++) ks.push(`ans:${c}:${i}`, `cnt:${c}:${i}`);
    await Promise.all(ks.map(k => store.expire(k, TTL))); setTimeout(() => cache.delete(c), TTL * 1000).unref();
  },
};
module.exports = L;
