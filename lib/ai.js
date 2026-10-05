// Source-grounded quiz generation with lightweight retrieval, validation and AI teaching insights.
const FALLBACK = [
  { q:'Which data structure uses FIFO ordering?', options:['Stack','Queue','Tree','Graph'], answer:1, explanation:'A queue removes the oldest element first.', concept:'Data Structures' },
  { q:'What is the average time complexity of binary search?', options:['O(n)','O(1)','O(log n)','O(n log n)'], answer:2, explanation:'Binary search halves the search space at each step.', concept:'Algorithms' },
  { q:'Which OS component manages processes and memory?', options:['Kernel','Compiler','Browser','Linker'], answer:0, explanation:'The kernel manages core operating-system resources.', concept:'Operating Systems' },
  { q:'Which protocol provides reliable byte-stream delivery?', options:['UDP','TCP','IP','ARP'], answer:1, explanation:'TCP provides reliable, ordered byte-stream delivery.', concept:'Computer Networks' },
  { q:'Which normal form removes partial dependency on a composite key?', options:['1NF','2NF','3NF','BCNF'], answer:1, explanation:'Second normal form removes partial dependencies.', concept:'DBMS' },
  { q:'Which keyword creates a class in Python?', options:['class','struct','object','define'], answer:0, explanation:'Python uses the class keyword to define classes.', concept:'Python' },
  { q:'Which principle hides implementation details behind an interface?', options:['Inheritance','Encapsulation','Recursion','Overloading'], answer:1, explanation:'Encapsulation hides internal state and implementation details.', concept:'OOP' },
  { q:'Which HTTP status code means Not Found?', options:['200','301','404','500'], answer:2, explanation:'404 indicates that the requested resource was not found.', concept:'Web Development' },
  { q:'What does SQL stand for?', options:['Structured Query Language','Simple Query Logic','System Query Language','Sequential Query Link'], answer:0, explanation:'SQL stands for Structured Query Language.', concept:'DBMS' },
  { q:'Which algorithm finds shortest paths from one source with non-negative weights?', options:['Dijkstra','Kruskal','DFS','Boyer-Moore'], answer:0, explanation:'Dijkstra computes single-source shortest paths for non-negative weights.', concept:'Algorithms' },
  { q:'Which machine-learning task predicts a continuous value?', options:['Classification','Regression','Clustering','Association'], answer:1, explanation:'Regression predicts continuous numerical outputs.', concept:'Machine Learning' },
  { q:'Which metric is commonly used for binary classification balance?', options:['F1-score','MSE','MAE','R-squared'], answer:0, explanation:'F1 combines precision and recall and is useful for classification.', concept:'Machine Learning' },
  { q:'What does CIA stand for in cybersecurity?', options:['Confidentiality, Integrity, Availability','Control, Identity, Access','Cryptography, Integrity, Authentication','Confidentiality, Inspection, Authorization'], answer:0, explanation:'The CIA triad is confidentiality, integrity and availability.', concept:'Cybersecurity' },
  { q:'Which cloud model provides virtual machines and networking?', options:['SaaS','PaaS','IaaS','DBaaS'], answer:2, explanation:'Infrastructure as a Service provides virtualized infrastructure.', concept:'Cloud Computing' },
  { q:'Which Git command creates a local copy of a remote repository?', options:['git push','git clone','git merge','git stash'], answer:1, explanation:'git clone copies a remote repository into a local working directory.', concept:'Git' },
  { q:'Which testing checks a small unit of code in isolation?', options:['Unit testing','Load testing','System testing','Acceptance testing'], answer:0, explanation:'Unit tests validate individual units or components in isolation.', concept:'Software Engineering' },
  { q:'What does REST commonly use to identify resources?', options:['URLs','RAM addresses','MAC tables','CSS selectors'], answer:0, explanation:'REST APIs commonly identify resources with URLs.', concept:'Web Development' },
  { q:'Which scheduling algorithm uses the smallest remaining execution time?', options:['FCFS','SRTF','Round Robin','Priority FIFO'], answer:1, explanation:'Shortest Remaining Time First chooses the process with the least remaining time.', concept:'Operating Systems' },
  { q:'Which data structure is typically used for BFS?', options:['Stack','Queue','Heap','Hash table'], answer:1, explanation:'Breadth-first search explores nodes level by level using a queue.', concept:'Algorithms' },
  { q:'What does Docker primarily package?', options:['Containers','Only source code','BIOS firmware','SQL tables'], answer:0, explanation:'Docker packages applications and dependencies into containers.', concept:'DevOps' }
].map(q => ({ ...q, difficulty:'easy', source:'' }));

const valid = q => q && typeof q.q === 'string' && q.q.trim() && Array.isArray(q.options) && q.options.length === 4 &&
  q.options.every(o => typeof o === 'string' && o.trim()) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4 && new Set(q.options.map(String)).size === 4;
const norm = q => ({ q:q.q.trim(), options:q.options.map(x=>String(x).trim()), answer:q.answer, explanation:String(q.explanation||'').trim(),
  difficulty:['easy','medium','hard'].includes(q.difficulty) ? q.difficulty : 'medium', concept:String(q.concept||'General').slice(0,50), source:String(q.source||'').slice(0,60) });
const chunk = (text, size=1200) => {
  const parts = text.includes('\f') ? text.split('\f') : Array.from({length:Math.ceil(text.length/size)},(_,i)=>text.slice(i*size,(i+1)*size));
  return parts.map((t,i)=>({page:i+1,text:t.trim()})).filter(x=>x.text);
};
const retrieve = (chunks, topic, k=10) => {
  if (!chunks.length) return [];
  const words = String(topic || '').toLowerCase().split(/\W+/).filter(x=>x.length>2);
  const scored = chunks.map(c => ({c, score: words.reduce((n,w)=>n+(c.text.toLowerCase().split(w).length-1),0)}));
  const relevant = scored.filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,k).map(x=>x.c);
  if (words.length && relevant.length) {
    const seen = new Set(relevant.map(x=>x.page));
    for (let i=0; i<chunks.length && relevant.length<k; i++) {
      if (!seen.has(chunks[i].page) && i % Math.max(1, Math.floor(chunks.length/k)) === 0) { relevant.push(chunks[i]); seen.add(chunks[i].page); }
    }
    return relevant.sort((a,b)=>a.page-b.page).slice(0,k);
  }
  if (chunks.length <= k) return chunks;
  return Array.from({length:k},(_,i)=>chunks[Math.floor(i*(chunks.length-1)/(k-1))]);
};

// ---------- providers: Anthropic, or Ollama (auto-detected at 127.0.0.1:11434 unless OLLAMA_URL is set) ----------
let ollamaCache = null;
async function ollamaInfo() {
  if (ollamaCache && Date.now() - ollamaCache.t < 20000) return ollamaCache.v;
  const base = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''); let v = null;
  try {
    const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const models = ((await r.json()).models || []).map(m => m.name), want = process.env.OLLAMA_MODEL;
      const model = want ? (models.includes(want) ? want : models.find(m => m.split(':')[0] === want.split(':')[0]) || models[0]) : models[0];
      v = { base, models, model: model || null, wanted: want || null };
    }
  } catch {}
  ollamaCache = { t: Date.now(), v }; return v;
}
async function provider() {
  if (process.env.ANTHROPIC_API_KEY) return { name: 'anthropic', model: process.env.MODEL || 'claude-sonnet-4-5' };
  const o = await ollamaInfo(); return o && o.model ? { name: 'ollama', model: o.model, base: o.base } : null;
}
async function status() {
  const p = await provider(), o = await ollamaInfo();
  return { provider: p ? p.name : 'none (offline extractive generator will be used)', model: p ? p.model : null,
    ollama: o ? { reachable: true, installedModels: o.models, using: o.model, requested: o.wanted } : { reachable: false, hint: 'Start Ollama and run: ollama pull llama3.2:3b' } };
}
const SCHEMA = { type: 'object', required: ['questions'], properties: { questions: { type: 'array', items: { type: 'object', required: ['q', 'options', 'answer', 'explanation'],
  properties: { q: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 }, answer: { type: 'integer', minimum: 0, maximum: 3 },
    explanation: { type: 'string' }, difficulty: { type: 'string' }, concept: { type: 'string' } } } } } };

async function llm(prompt, { max = 1500, schema, plain } = {}) {
  const p = await provider(); if (!p) return null;
  const timeout = AbortSignal.timeout(+process.env.LLM_TIMEOUT_MS || 180000);
  if (p.name === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: timeout, headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: max, messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) throw new Error('Anthropic ' + r.status);
    return ((await r.json()).content || []).map(c => c.text || '').join('');
  }
  const call = format => fetch(p.base + '/api/chat', { method: 'POST', signal: timeout, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: p.model, stream: false, keep_alive: '30m', messages: [{ role: 'user', content: prompt }],
      ...(plain ? {} : { format }), options: { temperature: 0.2, num_ctx: 4096, num_predict: max } }) });
  let r = await call(schema || 'json');
  if (!r.ok && schema) r = await call('json');                   // older Ollama versions: no schema support
  if (!r.ok) throw new Error('Ollama ' + r.status + ' ' + (await r.text()).slice(0, 150));
  return ((await r.json()).message || {}).content || '';
}

// ---------- tolerant parsing: small local models often wrap, relabel or mis-index answers ----------
function coerce(x) {
  if (!x || typeof x !== 'object') return null;
  let opts = x.options || x.choices; if (opts && !Array.isArray(opts) && typeof opts === 'object') opts = Object.values(opts);
  if (!Array.isArray(opts)) return null;
  opts = opts.map(o => String(o).replace(/^\s*[A-Da-d][\).:]\s+/, '').trim()).slice(0, 4);
  let ans = x.answer ?? x.correct ?? x.correct_answer ?? x.answer_index;
  if (typeof ans === 'string') { const t = ans.trim(); ans = /^[A-Da-d]$/.test(t) ? 'ABCD'.indexOf(t.toUpperCase()) : /^\d+$/.test(t) ? +t : opts.findIndex(o => o.toLowerCase() === t.replace(/^[A-Da-d][\).:]\s+/, '').toLowerCase()); }
  return { ...x, q: x.q || x.question, options: opts, answer: ans };
}
function parseQuestions(txt) {
  if (!txt) return [];
  const t = String(txt).replace(/```json|```/g, '').trim(); let v;
  try { v = JSON.parse(t); } catch { const m = t.match(/\[[\s\S]*\]/) || t.match(/\{[\s\S]*\}/); try { v = m && JSON.parse(m[0]); } catch { return []; } }
  const arr = Array.isArray(v) ? v : Array.isArray(v && v.questions) ? v.questions : v && (v.q || v.question) ? [v] : [];
  return arr.map(coerce).filter(valid).map(norm);
}

// ---------- offline extractive generator: works for ANY text, no AI needed ----------
const STOP = new Set(('about above after again all also although always among and any are because been before being between both but can could did does done during each either else even every for from further had has have having her here him his how however into its itself just like many may might more most much must never not now off once only other our out over own same several she should since some such than that the their them then there these they this those through thus too under until upon very was were what when where whether which while who whom why will with within without would you your').split(' '));
const sig = s => (String(s).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter(w => !STOP.has(w));
const label = c => { const m = c.text.match(/^\[((?:Slide|Page|Section) \d+)\]/); return m ? m[1] : 'Page ' + c.page; };
const cap = w => w[0].toUpperCase() + w.slice(1);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function topOf(text) { const f = {}; sig(text).forEach(w => f[w] = (f[w] || 0) + 1); const t = Object.entries(f).sort((a, b) => b[1] - a[1])[0]; return t ? cap(t[0]) : 'General'; }
// Re-join lines that PDF layout wrapped mid-sentence; keep bullets / short headings on their own line.
const unwrap = text => text.split('\n').reduce((out, line) => {
  const prev = out[out.length - 1];
  if (prev !== undefined && prev.length >= 45 && !/[.!?:;]$/.test(prev) && line.trim() && !/^\s*([-•*▪]|\d+[.)])/.test(line)) out[out.length - 1] = prev + ' ' + line.trim(); else out.push(line);
  return out;
}, []).join('\n');
function extractive(chunks, n, have = []) {
  chunks = chunks.map(c => ({ ...c, text: unwrap(c.text) }));
  const df = new Map(), tf = new Map();
  chunks.forEach(c => { new Set(sig(c.text)).forEach(w => df.set(w, (df.get(w) || 0) + 1)); sig(c.text).forEach(w => tf.set(w, (tf.get(w) || 0) + 1)); });
  const okw = w => w.length >= 5 && w.length <= 18 && !/ly$/.test(w);
  let vocab = [...df.keys()].filter(w => okw(w) && tf.get(w) >= 2); if (vocab.length < 12) vocab = [...df.keys()].filter(okw);
  const seen = new Set(have.map(q => q.q));
  const per = chunks.map(c => ({ c, cand: c.text.split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= 35 && s.length <= 260 && (s.match(/[a-z]/gi) || []).length > s.length * 0.6 && !/https?:|www\.|@/.test(s))
    .map(s => { let best = null, bs = -1;
      for (const w of new Set(sig(s).filter(okw))) { const sc = Math.min(df.get(w) || 1, 5) + (s.slice(1).includes(cap(w)) ? 2 : 0) + (w.length >= 7 ? 1 : 0); if (sc > bs) { bs = sc; best = w; } }
      return best ? { s, w: best, sc: bs } : null; }).filter(Boolean).sort((x, y) => y.sc - x.sc) }));
  const out = [];
  for (let r = 0; out.length < n; r++) {
    let any = false;
    for (const { c, cand } of per) {
      if (out.length >= n) break; const x = cand[r]; if (!x) continue; any = true;
      const re = new RegExp('\\b' + x.w + '\\b', 'gi'), right = (x.s.match(re) || [x.w])[0], low = x.s.toLowerCase();
      const qtext = 'Fill in the blank: "' + x.s.replace(re, '_____') + '"'; if (seen.has(qtext)) continue;
      const here = new Set(sig(c.text)), pool = shuffle(vocab.filter(w => w !== x.w && !low.includes(w) && Math.abs(w.length - x.w.length) <= 4)).sort((p, q) => here.has(q) - here.has(p)).slice(0, 3);
      if (pool.length < 3) continue; seen.add(qtext);
      const opts = shuffle([right, ...pool.map(w => right[0] === right[0].toUpperCase() ? cap(w) : w)]);
      out.push({ q: qtext, options: opts, answer: opts.indexOf(right), explanation: 'From the source: "' + x.s + '"', difficulty: 'medium', concept: topOf(c.text), source: label(c), gen: 'extractive' });
    }
    if (!any) break;
  }
  return out;
}
// The correct option must be supported by the page the question was written from.
const grounded = (q, text) => { const t = text.toLowerCase(), ws = sig(q.options[q.answer]); return !ws.length || ws.filter(w => t.includes(w.slice(0, Math.max(4, w.length - 2)))).length / ws.length >= 0.5; };

async function askChunk(c, k, o) {
  const prompt = 'Write ' + k + ' multiple-choice question' + (k > 1 ? 's' : '') + ' (' + o.difficulty + ' difficulty) about "' + o.subject + '" using ONLY the text below. Do not use outside knowledge. ' +
    'Each question must be answerable from the text, with exactly 4 distinct options and one correct answer.' + (o.concepts && o.concepts.length ? ' Emphasize: ' + o.concepts.join(', ') + '.' : '') +
    '\n\nTEXT:\n"""\n' + c.text.slice(0, 2200) + '\n"""\n\nReply with JSON only: {"questions":[{"q":"...","options":["...","...","...","..."],"answer":0,"explanation":"...","difficulty":"easy|medium|hard","concept":"short topic"}]} where "answer" is the 0-based index of the correct option.';
  return parseQuestions(await llm(prompt, { max: 900, schema: SCHEMA })).filter(q => grounded(q, c.text)).slice(0, k).map(q => ({ ...q, source: label(c), gen: 'ai' }));
}
function bankFor(topic, n, have = []) {
  const t = String(topic).toLowerCase(); let bank = FALLBACK;
  if (/network|tcp|udp|http|dns|osi|routing/.test(t)) bank = FALLBACK.filter(x => ['Computer Networks', 'Web Development'].includes(x.concept));
  else if (/operating|process|thread|deadlock|memory|scheduling/.test(t)) bank = FALLBACK.filter(x => x.concept === 'Operating Systems');
  else if (/database|sql|dbms|normalization|transaction/.test(t)) bank = FALLBACK.filter(x => x.concept === 'DBMS');
  else if (/algorithm|data structure|tree|graph|search|sort|complexity/.test(t)) bank = FALLBACK.filter(x => ['Algorithms', 'Data Structures'].includes(x.concept));
  else if (/python/.test(t)) bank = FALLBACK.filter(x => x.concept === 'Python');
  else if (/machine learning|ml|ai|classification|regression/.test(t)) bank = FALLBACK.filter(x => x.concept === 'Machine Learning');
  else if (/security|cyber|attack|cryptography/.test(t)) bank = FALLBACK.filter(x => x.concept === 'Cybersecurity');
  const seen = new Set(have.map(q => q.q));
  return [...bank, ...FALLBACK].filter(q => !seen.has(q.q) && seen.add(q.q)).slice(0, n).map(q => ({ ...norm(q), gen: 'bank' }));
}

async function generate({ topic, n = 5, difficulty = 'mixed', material = '', concepts, sourceName = '' }) {
  const hasSource = Boolean(material && material.trim()), subject = String(topic || sourceName || 'the uploaded study material').trim();
  const p = await provider(); let out = [];
  if (hasSource) {
    const chunks = chunk(material, 1500).filter(c => c.text.replace(/\s/g, '').length > 30);
    if (!chunks.length) throw new Error('The document has too little readable text to make questions from.');
    if (p) {                                                       // one small, focused request per page: reliable even for 3B local models
      const picks = retrieve(chunks, topic || sourceName, Math.min(chunks.length, Math.max(Math.ceil(n / 2), 2))), per = Math.ceil(n / picks.length);
      const budget = Date.now() + (+process.env.GEN_BUDGET_MS || (p.name === 'ollama' ? 170000 : 60000)), conc = p.name === 'ollama' ? 1 : 3; let fails = 0;
      for (let i = 0; i < picks.length && out.length < n && Date.now() < budget && fails < 2; i += conc) {
        const res = await Promise.all(picks.slice(i, i + conc).map(c => askChunk(c, per, { subject, difficulty, concepts }).catch(e => { fails++; console.error('AI page failed:', e.message); return []; })));
        for (const q of res.flat()) if (out.length < n && !out.some(x => x.q === q.q)) out.push(q);
      }
    }
    if (out.length < n) out.push(...extractive(retrieve(chunks, topic || sourceName, chunks.length), n - out.length, out));   // top up so any file works
    if (!out.length) throw new Error('Could not build questions from this document: it has too few complete sentences.');
    return out.slice(0, n);
  }
  if (p) try {
    const txt = await llm('Create exactly ' + n + ' ' + difficulty + '-difficulty multiple-choice questions on "' + subject + '".' + (concepts && concepts.length ? ' Emphasize: ' + concepts.join(', ') + '.' : '') +
      ' Reply with JSON only: {"questions":[{"q":"...","options":["...","...","...","..."],"answer":0,"explanation":"...","difficulty":"easy|medium|hard","concept":"short topic"}]}; "answer" is the 0-based index of the correct option.', { max: 2500, schema: SCHEMA });
    out = parseQuestions(txt).map(q => ({ ...q, gen: 'ai' })).slice(0, n);
  } catch (e) { console.error('AI topic generation failed:', e.message); }
  return out.length >= n ? out : [...out, ...bankFor(subject, n - out.length, out)];
}

async function insight({topic,concepts,tips}){
  try{
    return await Promise.race([
      llm(`You are a teaching coach. Topic: ${topic}. Per-concept accuracy: ${JSON.stringify(concepts)}. Findings: ${tips.join(' | ')}. In at most 3 sentences identify the likely misconception and give one concrete 5-minute re-teach action.`,{max:400,plain:true}),
      new Promise(r=>setTimeout(()=>r(null),20000))
    ]);
  }catch{return null;}
}
module.exports={valid,norm,chunk,retrieve,generate,insight,FALLBACK,parseQuestions,extractive,status,_reset:()=>{ollamaCache=null}};
