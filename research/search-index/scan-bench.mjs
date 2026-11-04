// "实时扫描"方案：全部正文小写后常驻内存，每次查询逐篇 includes
import { readNotes, QUERIES, now, ms, median } from './common.mjs';

let t = now();
const notes = readNotes();
const lower = notes.map(n => n.text.toLowerCase());
const loadMs = ms(t);
const rss = Math.round(process.memoryUsage().rss / 2 ** 20);
const out = QUERIES.map(({ name, q, kind }) => {
  const terms = kind === 'and' ? q.toLowerCase().split(/\s+/) : [q.toLowerCase()];
  const times = [];
  for (let r = 0; r < 10; r++) {
    const t0 = now(); let hits = 0;
    for (const s of lower) if (terms.every(x => s.includes(x))) hits++;
    times.push(ms(t0));
  }
  return `${name}=${median(times)}ms`;
});
console.log(JSON.stringify({ loadMs, rssMB: rss, queries: out }));
