// 把 .out/results.json 打印成 Markdown 表格（贴进 research/search-index.md）
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './common.mjs';

const r = JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8'));
const es = Object.keys(r).filter(k => !k.startsWith('_'));
const row = (cells) => '| ' + cells.join(' | ') + ' |';
console.log(row(['引擎', '读库 ms', '全量建索引 ms', '持久化 ms', '索引体积 MB', '建索引峰值 RSS MB', '加载 ms', '加载后 RSS MB', '单篇更新 ms', '更新后整份落盘 ms']));
console.log(row(Array(10).fill('---')));
for (const e of es) {
  const x = r[e];
  console.log(row([e, x.readMs, x.buildMs, x.persistMs, x.sizeMB, x.heapMB, x.loadMs, x.rssMB, x.updateMs, x.updatePersistMs ?? '—（事务内即持久）']));
}
console.log('\n查询（top-50 中位数 ms ／ 召回率 recall ／ 精确率 precision，真值 = 小写后字面子串）\n');
const qs = r[es[0]].queries;
console.log(row(['查询', '真值篇数', ...es]));
console.log(row(['---', '---', ...es.map(() => '---')]));
qs.forEach((q, i) => console.log(row([`${q.name} \`${q.q}\``, q.truth, ...es.map(e => {
  const y = r[e].queries[i]; return `${y.ms} ／ ${y.recall} ／ ${y.precision}`;
})])));
console.log('\n', JSON.stringify(r._env));
