require('./lib/env');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./lib/db');
const auth = require('./lib/auth');
const ai = require('./lib/ai');
const documentParser = require('./lib/document'), live = require('./lib/live'), store = require('./lib/store'), queue = require('./lib/queue');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv);
if (store.isRedis) io.adapter(require('@socket.io/redis-adapter').createAdapter(store, store.duplicate()));   // cross-instance pub/sub
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const rooms = new Map();
const rid = () => Math.random().toString(36).slice(2, 10);
const newCode = () => { let c; do c = String(Math.floor(1000 + Math.random() * 9000)); while (rooms.has(c)); return c; };
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const wrap = f => (req, res) => f(req, res).catch(e => res.status(e.status || 500).json({ err: e.err || e.message || 'Server error' }));
const need = (c, err = 'Bad request') => { if (!c) throw { status: 400, err }; };
const user = (req, res, next) => {
  const u = auth.verify((req.headers.authorization || '').slice(7));
  if (!u) return res.status(401).json({ err: 'Please log in' });
  req.user = u; next();
};
const teacher = (req, res, next) => req.user.role === 'teacher' ? next() : res.status(403).json({ err: 'Teachers only' });

const hits = new Map();
const limit = (req, res, next) => {   // 20 auth attempts / minute / IP
  const k = req.ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < 60000);
  if (h.length >= 20) return res.status(429).json({ err: 'Too many attempts, wait a minute' });
  h.push(now); hits.set(k, h); next();
};
setInterval(() => hits.clear(), 600e3).unref();
app.get('/api/qr/:code', async (req, res) => {
  if (!/^\d{4}$/.test(req.params.code)) return res.status(400).end();
  res.type('image/svg+xml').send(await require('qrcode').toString(req.protocol + '://' + req.get('host') + '/?join=' + req.params.code, { type: 'svg', margin: 1 }));
});
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size, redis: store.isRedis }));
app.post('/api/register', limit, wrap(async (req, res) => {
  const { name, email, password, role } = req.body;
  need(name && email && password && password.length >= 6 && ['teacher', 'student'].includes(role), 'Fill all fields (password min 6)');
  const id = String(email).toLowerCase().trim();
  need(!(await db.get('users', id)), 'Email already registered');
  const u = { id, name: String(name).trim().slice(0, 24), role, pw: auth.hash(password) };
  await db.put('users', id, u);
  res.json({ token: auth.sign(u), user: { id, name: u.name, role } });
}));
app.post('/api/login', limit, wrap(async (req, res) => {
  const u = await db.get('users', String(req.body.email || '').toLowerCase().trim());
  need(u && auth.check(String(req.body.password || ''), u.pw), 'Wrong email or password');
  res.json({ token: auth.sign(u), user: { id: u.id, name: u.name, role: u.role } });
}));
app.get('/api/ai/status', user, teacher, wrap(async (req, res) => res.json(await ai.status())));
app.get('/api/me', user, (req, res) => res.json(req.user));
app.get('/api/quizzes', user, teacher, wrap(async (req, res) => res.json(
  (await db.list('quizzes')).filter(q => q.owner === req.user.id).sort((a, b) => b.created - a.created).map(({ material, ...q }) => q)
)));
app.post('/api/quizzes', user, teacher, wrap(async (req, res) => {
  const b = req.body || {};
  let topic = String(b.topic || '').trim().slice(0, 120);
  let material = String(b.material || '').slice(0, 250000);
  let sourceName = '';
  if (b.fileBase64) {
    const parsed = await documentParser.extractAsync({ filename: b.fileName, base64: b.fileBase64 });
    material = parsed.text.slice(0, 250000);
    sourceName = parsed.filename || '';
  }
  need(topic || material, 'Enter a topic or upload a document');
  if (!topic) topic = (sourceName ? sourceName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : 'Uploaded material').slice(0, 120) || 'Uploaded material';
  const n = Math.min(Math.max(+b.count || 5, 1), 20);
  const difficulty = ['easy', 'medium', 'hard', 'mixed'].includes(b.difficulty) ? b.difficulty : 'mixed';
  const dur = Math.min(Math.max(+b.seconds || 20, 8), 60);
  const questions = await queue.generate({ topic, n, difficulty, material, sourceName });
  need(questions.length >= n, 'AI could not create the requested number of questions from the source. Try a richer document or fewer questions.');
  const quiz = { id: rid(), owner: req.user.id, topic, difficulty, dur, material, sourceName, sourceGrounded: Boolean(material), engine: questions.every(q => q.gen === 'ai') ? 'ai' : questions.some(q => q.gen === 'ai') ? 'mixed' : questions.some(q => q.gen === 'extractive') ? 'extractive' : 'bank', created: Date.now(), questions };
  await db.put('quizzes', quiz.id, quiz);
  res.json(quiz);
}));
app.get('/api/results', user, teacher, wrap(async (req, res) => res.json(
  (await db.list('results')).filter(r => r.owner === req.user.id).sort((a, b) => b.date - a.date)
)));
app.post('/api/results/:id/remedial', user, teacher, wrap(async (req, res) => {
  const r = await db.get('results', req.params.id);
  need(r && r.owner === req.user.id, 'Not found');
  const src = await db.get('quizzes', r.quizId);
  const weak = r.concepts.slice(0, 3).map(c => c.concept);
  const quiz = {
    id: rid(), owner: r.owner, topic: r.topic + ' — remedial', difficulty: 'mixed', dur: 20,
    material: src ? src.material : '', created: Date.now(),
    questions: await queue.generate({ topic: r.topic, n: 5, concepts: weak, material: src ? src.material : '' })
  };
  await db.put('quizzes', quiz.id, quiz); res.json(quiz);
}));
app.get('/api/history', user, wrap(async (req, res) => res.json(
  (await db.list('results')).filter(r => r.players.some(p => p.userId === req.user.id))
    .sort((a, b) => b.date - a.date)
    .map(r => ({ topic: r.topic, date: r.date, accuracy: r.accuracy, you: r.players.find(p => p.userId === req.user.id), of: r.players.length }))
)));

// ---------- Live game ----------
// Redis (or the in-memory stand-in) holds scores/answers/counters, so ANY instance can serve players. The instance that
// hosts a room ("owner", INSTANCE_ID) runs its timers; other instances signal it over pub/sub when everyone has answered.
const INSTANCE = process.env.INSTANCE_ID || 'default';
const all = c => io.to(c).to('h:' + c);                       // players + host
const lobbyPayload = async c => { const ps = await live.players(c); return { code: c, count: ps.length, names: ps.slice(0, 40).map(p => p.name) }; };
const lobbyTimers = new Map();
const pushLobby = c => { if (lobbyTimers.has(c)) return; lobbyTimers.set(c, setTimeout(async () => { lobbyTimers.delete(c); all(c).emit('lobby', await lobbyPayload(c)); }, 250)); };
const publicFinal = f => ({ board: f.board });                 // students see the leaderboard only

async function ask(room) {
  clearTimeout(room.timer); clearTimeout(room.advanceTimer);
  room.status = 'question'; room.qStart = Date.now();
  await live.meta(room.code, { status: 'question', qi: room.qi, qStart: room.qStart });
  const q = room.questions[room.qi];
  all(room.code).emit('question', { i: room.qi, total: room.questions.length, q: q.q, options: q.options, difficulty: q.difficulty, ms: room.dur * 1000, total_ms: room.dur * 1000, answered: false, lateJoin: false });
  room.timer = setTimeout(() => reveal(room), room.dur * 1000 + 250);
}
async function pushMe(c, p, qi, last) {
  const [a, score, rank] = await Promise.all([live.myAnswer(c, qi, p.pid), live.score(c, p.name), live.rank(c, p.name)]);
  const r = { choice: a ? a.choice : null, gained: a ? a.gained : 0, score, rank };
  const t = io.to(`p:${c}:${p.pid}`); t.emit('me', r); t.emit('player:roundEnd', { ...r, last });
}
async function reveal(room) {
  if (room.status !== 'question') return;
  clearTimeout(room.timer); room.status = 'reveal';
  await live.meta(room.code, { status: 'reveal' });
  const q = room.questions[room.qi], st = await live.stats(room.code, room.qi), ps = await live.players(room.code);
  room.lastReveal = { answer: q.answer, explanation: q.explanation, source: q.source, counts: st.counts, board: await live.board(room.code, 5), last: room.qi === room.questions.length - 1 };
  const hr = io.to('h:' + room.code); hr.emit('reveal', room.lastReveal); hr.emit('progress', { n: st.n, of: ps.length });
  await Promise.all(ps.map(p => pushMe(room.code, p, room.qi, room.lastReveal.last)));
  scheduleAdvance(room, 3500);                                 // automatic progression
}
function scheduleAdvance(room, ms) {
  clearTimeout(room.advanceTimer);
  room.advanceTimer = setTimeout(() => {
    if (room.status !== 'reveal') return;
    if (room.qi >= room.questions.length - 1) finish(room); else { room.qi++; ask(room); }
  }, ms);
}
async function finish(room) {
  if (room.status === 'done') return;
  clearTimeout(room.timer); clearTimeout(room.advanceTimer); room.status = 'done';
  const c = room.code, total = room.questions.length;
  const stats = await Promise.all(room.questions.map((_, i) => live.stats(c, i)));
  const qs = room.questions.map((q, i) => {
    const st = stats[i], wrong = st.counts.map((n, j) => j === q.answer ? -1 : n);
    const top = Math.max(...wrong) >= 0 ? wrong.indexOf(Math.max(...wrong)) : -1;
    return { q: q.q, concept: q.concept, pct: pct(st.right, st.n), right: q.options[q.answer], topWrong: top >= 0 ? q.options[top] : '', topWrongPct: top >= 0 ? pct(st.counts[top], st.n - st.right) : 0 };
  });
  const by = {}; qs.forEach(x => (by[x.concept] = by[x.concept] || []).push(x.pct));
  const concepts = Object.entries(by).map(([concept, a]) => ({ concept, pct: Math.round(a.reduce((x, y) => x + y, 0) / a.length) })).sort((a, b) => a.pct - b.pct);
  const accuracy = Math.round(qs.reduce((a, x) => a + x.pct, 0) / (qs.length || 1));
  const tips = [...qs].sort((a, b) => a.pct - b.pct).slice(0, 3).map(x => `"${x.q}" (${x.concept}): ${x.pct}% correct.` + (x.pct < 100 && x.topWrongPct ? ` ${x.topWrongPct}% of wrong answers chose "${x.topWrong}" instead of "${x.right}".` : ''));
  const aiText = await ai.insight({ topic: room.topic, concepts, tips });
  const ps = await live.players(c), uid = Object.fromEntries(ps.map(p => [p.name, p.userId || null]));
  const b = await live.board(c, 100000);
  const doc = { id: rid(), quizId: room.quizId, owner: room.owner, topic: room.topic, date: Date.now(), accuracy, concepts, tips, ai: aiText, questions: qs,
    players: b.map(x => ({ name: x.name, score: x.score, rank: x.rank, userId: uid[x.name] })) };
  await db.put('results', doc.id, doc).catch(console.error);
  room.final = { board: b.slice(0, 20), accuracy, concepts, tips, ai: aiText, resultId: doc.id };
  await live.setFinal(c, room.final); await live.meta(c, { status: 'done' });
  io.to('h:' + c).emit('end', room.final); io.to(c).emit('end', publicFinal(room.final));
  await Promise.all(ps.map(async p => {
    const mine = await Promise.all(Array.from({ length: total }, (_, i) => live.myAnswer(c, i, p.pid)));
    io.to(`p:${c}:${p.pid}`).emit('player:final', { score: await live.score(c, p.name), rank: await live.rank(c, p.name), totalPlayers: ps.length, accuracy: pct(mine.filter(a => a && a.gained > 0).length, total) });
  }));
  live.expireAll(c, total);
}
live.onSignal((c, type) => { const r = rooms.get(c); if (r && type === 'reveal') reveal(r); });   // owner reacts to "everyone answered"

async function sync(s, c) {                                      // restore exact state after reconnect / late join
  const info = await live.info(c), m = await live.meta(c), { role, pid } = s.data;
  if (!info || !m) return;
  if (m.status === 'lobby') return s.emit('lobby', await lobbyPayload(c));
  if (m.status === 'done') { const f = await live.final(c); return f && s.emit('end', role === 'host' ? f : publicFinal(f)); }
  const mk = (ms, answered) => ({ i: m.qi, total: info.total, ...info.pub[m.qi], ms, total_ms: info.dur * 1000, answered, lateJoin: false });
  const mine = pid ? await live.myAnswer(c, m.qi, pid) : null;
  if (m.status === 'question') return s.emit('question', mk(Math.max(0, m.qStart + info.dur * 1000 - Date.now()), !!mine));
  s.emit('question', mk(0, true));
  const r = rooms.get(c);
  if (role === 'host') { if (r && r.lastReveal) s.emit('reveal', r.lastReveal); }
  else { const p = await live.player(c, pid); if (p) await pushMe(c, p, m.qi, m.qi === info.total - 1); }
}

io.on('connection', s => {
  s.on('host:start', async (o, ack) => {
    const u = auth.verify(o.token), quiz = u && u.role === 'teacher' && await db.get('quizzes', String(o.quizId));
    if (!quiz || quiz.owner !== u.id) return ack({ err: 'Not allowed' });
    const room = { code: newCode(), token: rid(), quizId: quiz.id, owner: u.id, topic: quiz.topic, questions: quiz.questions, dur: quiz.dur, qi: -1, status: 'lobby', created: Date.now(), hostSid: s.id };
    rooms.set(room.code, room); s.data = { role: 'host', code: room.code }; s.join('h:' + room.code);
    await live.create(room.code, { token: room.token, quizId: quiz.id, ownerUser: u.id, topic: quiz.topic, dur: quiz.dur, total: quiz.questions.length, owner: INSTANCE,
      questions: quiz.questions, correct: quiz.questions.map(q => q.answer), pub: quiz.questions.map(q => ({ q: q.q, options: q.options, difficulty: q.difficulty })) });
    ack({ code: room.code, token: room.token }); s.emit('lobby', await lobbyPayload(room.code));
  });

  s.on('player:join', async (o, ack) => {
    const c = String(o.code), info = await live.info(c), m = info && await live.meta(c), u = auth.verify(o.token);
    if (!info) return ack({ err: 'Room not found' });
    if (m.status === 'done') return ack({ err: 'Quiz has ended' });
    const name = String((u && u.name) || o.name || '').trim().slice(0, 20);
    if (!name) return ack({ err: 'Enter a name' });
    const pid = rid(), lateJoin = m.status !== 'lobby';
    if (!(await live.join(c, pid, { name, userId: u ? u.id : null, lateJoin }))) return ack({ err: 'Name already taken' });
    s.data = { role: 'player', code: c, pid, name }; s.join(c); s.join(`p:${c}:${pid}`);
    ack({ id: pid, code: c, lateJoin, status: m.status }); pushLobby(c); await sync(s, c);
  });

  s.on('resume', async (o, ack) => {
    ack = ack || (() => {}); const c = String(o.code), info = await live.info(c);
    if (!info) return ack({ err: 1 });
    if (o.role === 'host') {
      const r = rooms.get(c); if (!r || o.token !== info.token) return ack({ err: 1 });   // host must reach the owning instance (sticky sessions)
      r.hostSid = s.id; s.data = { role: 'host', code: c }; s.join('h:' + c);
    } else {
      const p = await live.player(c, o.id); if (!p) return ack({ err: 1 });
      s.data = { role: 'player', code: c, pid: o.id, name: p.name }; s.join(c); s.join(`p:${c}:${o.id}`);
    }
    ack({ ok: 1 }); await sync(s, c);
  });

  s.on('host:next', () => {
    const room = s.data.role === 'host' && rooms.get(s.data.code); if (!room || !['lobby', 'reveal'].includes(room.status)) return;
    clearTimeout(room.advanceTimer);
    if (room.status === 'lobby') { room.qi = 0; ask(room); }
    else if (room.qi >= room.questions.length - 1) finish(room); else { room.qi++; ask(room); }
  });

  s.on('answer', async (choice, ack) => {                        // idempotent (HSETNX) and server-timed, on any instance
    ack = ack || (() => {}); const { code: c, pid, name } = s.data;
    if (!pid) return ack({ err: 'closed' });
    const [info, m] = await Promise.all([live.info(c), live.meta(c)]);
    if (!info || !m || m.status !== 'question') return ack({ err: 'closed' });
    const ms = Date.now() - m.qStart;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3 || ms > info.dur * 1000 + 500) return ack({ err: 'late' });
    const r = await live.answer(c, m.qi, pid, name, choice, ms, info.dur, choice === info.correct[m.qi]);
    if (r.dup) return ack({ locked: true, dup: true });
    ack({ locked: true });
    const total = await live.count(c);
    io.to('h:' + c).emit('progress', { n: r.n, of: total });
    if (r.n >= total) live.signal(c, 'reveal');
  });

  s.on('disconnect', () => { const r = rooms.get(s.data.code); if (r && s.data.role === 'host') r.hostSid = null; });
});

// After a restart, re-adopt rooms this instance owned and resume their game loop from Redis state.
(async () => { for (const k of await store.keys('room:*')) {
  const c = k.slice(5), info = await live.info(c), m = info && await live.meta(c);
  if (!info || !m || info.owner !== INSTANCE || m.status === 'done' || rooms.has(c)) continue;
  const r = { code: c, token: info.token, quizId: info.quizId, owner: info.ownerUser, topic: info.topic, questions: info.questions, dur: info.dur, status: m.status, qi: m.qi, qStart: m.qStart, created: Date.now(), hostSid: null };
  rooms.set(c, r); if (m.status === 'question') reveal(r); else if (m.status === 'reveal') scheduleAdvance(r, 2000);
} })().catch(console.error);

setInterval(() => {
  for (const [c, r] of rooms) if (Date.now() - r.created > 4 * 3600e3) { clearTimeout(r.timer); clearTimeout(r.advanceTimer); rooms.delete(c); }
}, 600e3).unref();

if (require.main === module) srv.listen(process.env.PORT || 3000, () => console.log('QuizForge AI on :' + (process.env.PORT || 3000)));
module.exports = { srv, io };
