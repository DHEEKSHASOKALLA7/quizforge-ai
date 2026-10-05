// Redis client when REDIS_URL is set; otherwise an in-memory stand-in with the same command subset.
if (process.env.REDIS_URL) {
  const r = new (require('ioredis'))(process.env.REDIS_URL);
  r.on('error', e => console.error('redis:', e.message));
  r.isRedis = true;
  r.subscribeTo = (ch, fn) => { const s = r.duplicate(); s.subscribe(ch); s.on('message', (_, m) => fn(m)); return s; };
  module.exports = r;
} else {
  class Mem {
    constructor() { this.d = new Map(); this.subs = []; this.isRedis = false; }
    h(k) { let m = this.d.get(k); if (!m) this.d.set(k, m = new Map()); return m; }
    sorted(k) { return [...this.h(k)].map(([m, s]) => [m, +s]).sort((a, b) => b[1] - a[1] || (b[0] < a[0] ? -1 : 1)); }
    async set(k, v) { this.d.set(k, v); return 'OK'; }
    async get(k) { const v = this.d.get(k); return v === undefined ? null : v; }
    async keys(p) { const re = new RegExp('^' + p.replace('*', '.*')); return [...this.d.keys()].filter(k => re.test(k)); }
    async expire(k, s) { setTimeout(() => this.d.delete(k), s * 1000).unref(); return 1; }
    async hset(k, f, v) { this.h(k).set(f, String(v)); return 1; }
    async hsetnx(k, f, v) { const m = this.h(k); if (m.has(f)) return 0; m.set(f, String(v)); return 1; }
    async hget(k, f) { const v = this.h(k).get(f); return v === undefined ? null : v; }
    async hgetall(k) { return Object.fromEntries(this.h(k)); }
    async hincrby(k, f, n) { const m = this.h(k), v = +(m.get(f) || 0) + n; m.set(f, String(v)); return v; }
    async hlen(k) { return this.h(k).size; }
    async zadd(k, s, m) { this.h(k).set(m, String(s)); return 1; }
    async zincrby(k, n, m) { return this.hincrby(k, m, n); }
    async zscore(k, m) { return this.hget(k, m); }
    async zrevrange(k, a, b, w) { const r = this.sorted(k).slice(a, b < 0 ? undefined : b + 1); return w ? r.flat().map(String) : r.map(x => x[0]); }
    async zrevrank(k, m) { const i = this.sorted(k).findIndex(x => x[0] === m); return i < 0 ? null : i; }
    async publish(ch, msg) { this.subs.forEach(f => f(msg)); return 1; }
    subscribeTo(ch, fn) { this.subs.push(fn); }
  }
  module.exports = new Mem();
}
