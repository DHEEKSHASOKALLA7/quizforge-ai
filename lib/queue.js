// Question generation runs through a BullMQ queue (retries + exponential backoff, optional separate worker process)
// when REDIS_URL is set; otherwise it runs inline with one retry. Callers just `await queue.generate(opts)`.
const ai = require('./ai');
if (process.env.REDIS_URL) {
  const { Queue, Worker, QueueEvents } = require('bullmq'), IORedis = require('ioredis');
  const conn = () => new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const q = new Queue('quiz-generation', { connection: conn(), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 } });
  const events = new QueueEvents('quiz-generation', { connection: conn() });
  if (process.env.RUN_WORKER !== '0') new Worker('quiz-generation', job => ai.generate(job.data), { connection: conn(), concurrency: 2 });
  exports.generate = async data => (await q.add('generate', data)).waitUntilFinished(events, +process.env.GEN_WAIT_MS || 300000);
} else {
  exports.generate = async data => { try { return await ai.generate(data); } catch (e) { return ai.generate(data); } };
}
