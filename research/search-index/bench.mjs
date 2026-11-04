// 依次对每个引擎跑 build 与 load（各自独立子进程），结果写入 .out/results.json
// 用法：node bench.mjs [engine ...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './common.mjs';

const all = ['minisearch-bigram', 'minisearch-segmenter', 'minisearch-jieba', 'flexsearch-bigram',
  'sqlite-trigram-better', 'sqlite-trigram-node', 'sqlite-trigram-detail-none', 'tantivy-bigram'];
const engines = process.argv.length > 2 ? process.argv.slice(2) : all;
const file = path.join(OUT, 'results.json');
const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const run = (e, phase) => JSON.parse(execFileSync(process.execPath,
  ['--max-old-space-size=8192', '--no-warnings', 'bench-engine.mjs', e, phase],
  { cwd: import.meta.dirname, encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop());
for (const e of engines) {
  results[e] = { ...run(e, 'build'), ...run(e, 'load') };
  delete results[e].phase;
  console.log(JSON.stringify(results[e]));
  results._env = { node: process.version, platform: `${process.platform}-${process.arch}` };
  fs.writeFileSync(file, JSON.stringify(results, null, 1)); // 每个引擎跑完即落盘，后续失败不丢前面的结果
}
