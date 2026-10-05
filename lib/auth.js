// Password hashing (scrypt) + signed tokens (HMAC-SHA256), no external deps.
const crypto = require('crypto');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
const hmac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
exports.hash = hash;
exports.check = (pw, h) => same(hash(pw, h.split(':')[0]), h);
exports.sign = u => { const b = Buffer.from(JSON.stringify({ id: u.id, role: u.role, name: u.name, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return b + '.' + hmac(b); };
exports.verify = t => {
  try { const [b, sig] = String(t).split('.'); if (!same(sig, hmac(b))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
};
