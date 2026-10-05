// Multi-instance test: two server processes share one Redis. Host on A, players on A and B. Run: REDIS_URL=... npm run test:redis
const test = require('node:test'), assert = require('node:assert'), { spawn } = require('child_process'), { io } = require('socket.io-client');
const skip = !process.env.REDIS_URL && 'REDIS_URL not set';
const start = (port, id, extra = {}) => new Promise((res, rej) => {
  const p = spawn('node', ['server.js'], { env: { ...process.env, PORT: port, INSTANCE_ID: id, DB_FILE: `/tmp/qf-${id}-${Date.now()}.json`, ...extra } });
  p.stdout.on('data', d => String(d).includes('on :') && res(p)); p.on('error', rej); setTimeout(() => rej(new Error('start timeout')), 8000);
});
test('two instances share a live room via Redis (adapter, sorted-set leaderboard, idempotency, BullMQ)', { skip }, async () => {
  const [A, B] = await Promise.all([start(3201, 'A'), start(3202, 'B', { RUN_WORKER: '0' })]);   // B has no worker: A's worker serves the queue
  try {
    const a = 'http://localhost:3201', b = 'http://localhost:3202';
    const post = async (u, body, tok) => (await fetch(a + u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (tok || '') }, body: JSON.stringify(body) })).json();
    const t = await post('/api/register', { name: 'Tea', email: `t${Date.now()}@x.com`, password: 'secret1', role: 'teacher' });
    const quiz = await post('/api/quizzes', { topic: 'networks', count: 2, seconds: 8 }, t.token);   // goes through BullMQ
    assert.equal(quiz.questions.length, 2);
    const host = io(a), pa = io(a), pb = io(b);
    const { code } = await new Promise(r => host.emit('host:start', { quizId: quiz.id, token: t.token }, r));
    const ja = await new Promise(r => pa.emit('player:join', { code, name: 'OnA' }, r));
    const jb = await new Promise(r => pb.emit('player:join', { code, name: 'OnB' }, r));
    assert.ok(ja.id && jb.id);
    assert.equal((await new Promise(r => pb.emit('player:join', { code, name: 'ona' }, r))).err, 'Name already taken');   // atomic across instances
    const seen = []; const ack = [];
    pb.on('question', d => { seen.push(d.i); pb.emit('answer', 0, r => ack.push(r)); pb.emit('answer', 0, r => ack.push(r)); });   // 2nd is a duplicate
    pa.on('question', d => pa.emit('answer', d.i === 0 ? 1 : 0));
    const hostEnd = new Promise(r => host.on('end', r)), bEnd = new Promise(r => pb.on('end', r));
    host.emit('host:next');
    const [fin, pubFin] = await Promise.all([hostEnd, bEnd]);
    assert.deepEqual(seen, [0, 1]);                                       // B received A's broadcasts through the adapter
    assert.ok(ack.some(r => r.dup));                                      // HSETNX idempotency on B
    assert.equal(fin.board[0].name, 'OnA'); assert.ok(fin.board[0].score >= 500);   // sorted-set leaderboard merges both instances
    assert.equal(fin.board.length, 2); assert.deepEqual(Object.keys(pubFin), ['board']);
    [host, pa, pb].forEach(x => x.close());
  } finally { A.kill(); B.kill(); }
});
