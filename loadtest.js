// Self-contained benchmark: node loadtest.js [players=200] [url=http://localhost:3000]
// Registers a teacher, builds a quiz, hosts it, joins N bot players, plays all questions, prints measured latency.
const { io } = require('socket.io-client');
const N = +process.argv[2] || 200, url = process.argv[3] || 'http://localhost:3000';
const post = async (u, b, t) => (await fetch(url + u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (t || '') }, body: JSON.stringify(b) })).json();
const pc = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
(async () => {
  const t = await post('/api/register', { name: 'Bench', email: `bench${Date.now()}@x.com`, password: 'secret1', role: 'teacher' });
  const quiz = await post('/api/quizzes', { topic: 'networks', count: 3, seconds: 8 }, t.token);
  const host = io(url, { transports: ['websocket'] });
  const { code } = await new Promise(r => host.emit('host:start', { quizId: quiz.id, token: t.token }, r));
  const ack = [], fan = []; let joined = 0, startAt = 0, ended = 0;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise(res => {
    const s = io(url, { transports: ['websocket'] });
    s.on('connect', () => s.emit('player:join', { code, name: 'bot' + i }, r => { if (!r.err) joined++; res(); }));
    s.on('question', d => {
      if (d.i === 0 && startAt) fan.push(Date.now() - startAt);       // host:next -> question received
      setTimeout(() => { const t0 = Date.now(); s.emit('answer', Math.floor(Math.random() * 4), () => ack.push(Date.now() - t0)); }, Math.random() * d.ms * 0.7);
    });
    s.on('end', () => { if (++ended === N) finish(); });
  })));
  console.log(`joined ${joined}/${N}, starting quiz...`); startAt = Date.now(); host.emit('host:next');
  function finish() {
    console.log(`players=${joined} answers=${ack.length}  answer-ack p50=${pc(ack, .5)}ms p95=${pc(ack, .95)}ms p99=${pc(ack, .99)}ms  question fan-out p50=${pc(fan, .5)}ms p95=${pc(fan, .95)}ms`);
    process.exit(0);
  }
  setTimeout(() => { console.log('timeout'); process.exit(1); }, 90000);
})();
