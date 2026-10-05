process.env.DB_FILE = require('os').tmpdir() + '/qf-' + Date.now() + '.json';
const test = require('node:test'), assert = require('node:assert');
const { srv, io: sio } = require('../server'), { io } = require('socket.io-client');
const ai = require('../lib/ai'), auth = require('../lib/auth');
test.after(() => sio.close());

test('chunking honours page breaks and retrieval ranks relevant pages', () => {
  const ch = ai.chunk('intro\fTCP congestion control uses windows\fDNS maps names');
  assert.equal(ch.length, 3);
  assert.equal(ai.retrieve(ch, 'TCP congestion', 1)[0].page, 2);
});
test('question validation rejects bad shapes and duplicate options', () => {
  assert.ok(ai.valid(ai.FALLBACK[0]));
  assert.ok(!ai.valid({ q: 'x', options: ['a', 'a', 'b', 'c'], answer: 0 }));
  assert.ok(!ai.valid({ q: 'x', options: ['a', 'b', 'c'], answer: 0 }));
});
test('passwords and tokens: roundtrip, wrong password, tampering', () => {
  const h = auth.hash('secret1'); assert.ok(auth.check('secret1', h)); assert.ok(!auth.check('nope', h));
  const t = auth.sign({ id: 'a', role: 'teacher', name: 'A' }); assert.equal(auth.verify(t).role, 'teacher');
  assert.equal(auth.verify(t.slice(0, -2) + 'xx'), null);
});
test('end-to-end: register, generate quiz, play live, persist results, student history', async () => {
  await new Promise(r => srv.listen(0, r)); const base = 'http://localhost:' + srv.address().port;
  const post = async (u, b, tok) => (await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (tok || '') }, body: JSON.stringify(b) })).json();
  const t = await post('/api/register', { name: 'Tea', email: 't@x.com', password: 'secret1', role: 'teacher' });
  const st = await post('/api/register', { name: 'Stu', email: 's@x.com', password: 'secret1', role: 'student' });
  assert.equal((await post('/api/register', { name: 'Tea', email: 't@x.com', password: 'secret1', role: 'teacher' })).err, 'Email already registered');
  assert.equal((await post('/api/quizzes', { topic: 'x' }, st.token)).err, 'Teachers only');
  const quiz = await post('/api/quizzes', { topic: 'CS basics', count: 2, seconds: 5 }, t.token);
  assert.equal(quiz.questions.length, 2);
  const host = io(base), stu = io(base);
  const { code } = await new Promise(r => host.emit('host:start', { quizId: quiz.id, token: t.token }, r));
  const j = await new Promise(r => stu.emit('player:join', { code, token: st.token }, r)); assert.ok(j.id);
  stu.on('question', d => stu.emit('answer', d.i === 0 ? 1 : 0));     // q0 right, q1 wrong
  host.on('reveal', () => host.emit('host:next'));
  const end = new Promise(r => stu.on('end', r)), hostEnd = new Promise(r => host.on('end', r)); host.emit('host:next');
  const fin = await end, hostFin = await hostEnd;
  assert.equal(fin.board[0].name, 'Stu'); assert.ok(fin.board[0].score >= 500); assert.equal(hostFin.accuracy, 50);
  const res = await (await fetch(base + '/api/results', { headers: { authorization: 'Bearer ' + t.token } })).json();
  assert.equal(res.length, 1); assert.ok(res[0].tips.length);
  const hist = await (await fetch(base + '/api/history', { headers: { authorization: 'Bearer ' + st.token } })).json();
  assert.equal(hist[0].you.rank, 1);
  const rem = await post(`/api/results/${res[0].id}/remedial`, {}, t.token); assert.ok(rem.questions.length);
  host.close(); stu.close();
});

// ---------- document -> questions: must work for any file, with or without an AI provider ----------
const fs = require('fs'), http = require('http'), docs = require('../lib/document');
const cloud = fs.readFileSync(__dirname + '/fixtures/cloud.pdf');

test('parser accepts the shapes small local models produce', () => {
  const wrapped = JSON.stringify({ questions: [{ question: 'Q1?', choices: ['a', 'b', 'c', 'd'], correct: 'B' }, { q: 'Q2?', options: { A: 'w', B: 'x', C: 'y', D: 'z' }, answer: 'z' }] });
  const qs = ai.parseQuestions('Here you go:\n```json\n' + wrapped + '\n```');
  assert.deepEqual(qs.map(q => q.answer), [1, 3]);
  assert.deepEqual(ai.parseQuestions('not json at all'), []);
});
test('PDF text is extracted page-accurately with pdf.js', async () => {
  const r = await docs.extractAsync({ filename: 'cloud.pdf', base64: cloud.toString('base64') });
  assert.match(r.text, /hypervisor/i); assert.equal(r.kind, 'PDF');
});
test('extractive generator builds valid cited questions from any text (no AI)', async () => {
  const r = await docs.extractAsync({ filename: 'cloud.pdf', base64: cloud.toString('base64') });
  const qs = ai.extractive(ai.chunk(r.text), 6);
  assert.ok(qs.length >= 5, 'got ' + qs.length);
  qs.forEach(q => { assert.ok(ai.valid(q)); assert.match(q.source, /Page \d+/); assert.ok(q.q.includes('_____')); assert.ok(q.explanation.includes('From the source')); });
});
test('upload a PDF with NO AI provider: still returns the requested number of questions', async () => {
  delete process.env.ANTHROPIC_API_KEY; process.env.OLLAMA_URL = 'http://127.0.0.1:9'; ai._reset();   // nothing listening
  if (!srv.listening) await new Promise(r => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port, post = async (u, b, t) => (await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (t || '') }, body: JSON.stringify(b) })).json();
  const t = await post('/api/register', { name: 'Doc', email: 'doc@x.com', password: 'secret1', role: 'teacher' });
  const quiz = await post('/api/quizzes', { count: 5, seconds: 8, fileName: 'UNIT2_CC_MERGE_2026 (1).pdf', fileBase64: cloud.toString('base64') }, t.token);
  assert.ok(quiz.questions, JSON.stringify(quiz).slice(0, 200)); assert.equal(quiz.questions.length, 5); assert.equal(quiz.engine, 'extractive'); assert.ok(quiz.questions.every(q => /Page \d+/.test(q.source)));
});
test('upload with a (fake) Ollama server: auto-detected, per-page prompts, grounded AI questions + top-up', async () => {
  let chatCalls = 0, sawSchema = false;
  const fake = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
      chatCalls++; const j = JSON.parse(body); sawSchema = sawSchema || typeof j.format === 'object';
      const text = j.messages[0].content, topic = /hypervisor/i.test(text) ? 'hypervisor' : 'elasticity';
      res.end(JSON.stringify({ message: { content: JSON.stringify({ questions: [{ q: 'What does the source say about ' + topic + '?', options: ['It manages virtual machines', 'It is a database', 'It encrypts disks', 'It prints pages'], answer: 'A', explanation: 'See text.' }] }) } }));
    });
  });
  await new Promise(r => fake.listen(0, r)); process.env.OLLAMA_URL = 'http://127.0.0.1:' + fake.address().port; ai._reset();
  const st = await ai.status(); assert.equal(st.provider, 'ollama'); assert.equal(st.model, 'llama3.2:3b');
  const r = await docs.extractAsync({ filename: 'cloud.pdf', base64: cloud.toString('base64') });
  const qs = await ai.generate({ topic: '', sourceName: 'cloud', material: r.text, n: 4 });
  assert.equal(qs.length, 4); assert.ok(chatCalls >= 1 && sawSchema); assert.ok(qs.some(q => q.gen === 'ai') || qs.every(q => q.gen === 'extractive'));
  fake.close(); delete process.env.OLLAMA_URL; ai._reset();
});

// runs last: it deliberately exhausts the per-IP auth rate limit
test('students never receive teacher analytics; QR route works; auth is rate limited', async () => {
  if (!srv.listening) await new Promise(r => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const post = async (u, b, tok) => (await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (tok || '') }, body: JSON.stringify(b) }));
  const t = await (await post('/api/register', { name: 'T2', email: 't2@x.com', password: 'secret1', role: 'teacher' })).json();
  const quiz = await (await post('/api/quizzes', { topic: 'x', count: 1, seconds: 8 }, t.token)).json();
  const host = io(base), stu = io(base);
  const { code } = await new Promise(r => host.emit('host:start', { quizId: quiz.id, token: t.token }, r));
  await new Promise(r => stu.emit('player:join', { code, name: 'Kid' }, r));
  stu.on('question', () => stu.emit('answer', 1));
  const [hEnd, sEnd] = [new Promise(r => host.on('end', r)), new Promise(r => stu.on('end', r))];
  host.emit('host:next');
  const [h, st] = await Promise.all([hEnd, sEnd]);
  assert.ok(h.tips && h.concepts); assert.deepEqual(Object.keys(st), ['board']);
  const svg = await fetch(`${base}/api/qr/${code}`); assert.match(await svg.text(), /<svg/);
  let last; for (let i = 0; i < 25; i++) last = await post('/api/login', { email: 'nobody@x.com', password: 'wrong' });
  assert.equal(last.status, 429);
  host.close(); stu.close();
});

