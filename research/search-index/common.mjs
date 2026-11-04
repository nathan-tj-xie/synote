// 基准共用：读库、分词器、查询集与"子串真值"
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const VAULT = path.resolve(process.env.VAULT ?? new URL('.vault', import.meta.url).pathname);
export const OUT = path.resolve(new URL('.out', import.meta.url).pathname);
fs.mkdirSync(OUT, { recursive: true });

export const now = () => performance.now();
export const ms = (t) => Math.round((performance.now() - t) * 10) / 10;
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// 递归列出所有 .md（相对路径，posix 分隔）并读取内容；返回 [{id, text, mtimeMs, size}]
export function listNotes(root = VAULT) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .map(d => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}
export function readNotes(root = VAULT) {
  return listNotes(root).map(id => {
    const p = path.join(root, id);
    const st = fs.statSync(p);
    return { id, text: fs.readFileSync(p, 'utf8'), mtimeMs: st.mtimeMs, size: st.size };
  });
}

// —— 分词器 ——
const CJK = /[㐀-鿿豈-﫿]+|[\p{L}\p{N}_]+/gu;
const isCjk = (s) => s.charCodeAt(0) >= 0x3400 && s.charCodeAt(0) <= 0xfaff;
// CJK 连续段切成重叠 bigram（单字段保留 unigram），拉丁/数字按词
export function bigram(text) {
  const out = [];
  for (const [run] of text.toLowerCase().matchAll(CJK)) {
    if (!isCjk(run) || run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}
const seg = new Intl.Segmenter('zh', { granularity: 'word' });
export function segmenter(text) {
  const out = [];
  for (const s of seg.segment(text.toLowerCase())) if (s.isWordLike) out.push(s.segment);
  return out;
}
let _jieba;
export function jieba(text) {
  if (!_jieba) {
    const require = createRequire(import.meta.url);
    const { Jieba } = require('@node-rs/jieba');
    _jieba = Jieba.withDict(require('@node-rs/jieba/dict').dict);
  }
  return _jieba.cut(text.toLowerCase(), false).filter(t => /[\p{L}\p{N}]/u.test(t));
}
export const TOKENIZERS = { bigram, segmenter, jieba };

// —— 查询集 ——
// kind: substr = 单个字面子串（真值 = 小写后 includes）；and = 多词同时出现
export const QUERIES = [
  { name: 'en 高频词', q: 'thomasing' },
  { name: 'en 低频词', q: 'nipcheese' },
  { name: 'en 词内子串', q: 'homasin' },
  { name: 'en 前缀', q: 'thom' },
  { name: 'zh 2 字高频词', q: '一个' },
  { name: 'zh 2 字低频词', q: '喇嘛' },
  { name: 'zh 3 字人名', q: '章宗祥' },
  { name: 'zh 词内子串', q: '汉市' },
  { name: 'zh 跨词子串', q: '法权章' },
  { name: 'zh 单字', q: '链' },
  { name: 'zh 词典外 2 字术语', q: '反链' },
  { name: 'zh 词典外 4 字术语', q: '孤儿附件' },
  { name: '中英混合 2 词', q: '武汉 darning', kind: 'and' },
];

export function truth(notes, { q, kind }) {
  const terms = kind === 'and' ? q.toLowerCase().split(/\s+/) : [q.toLowerCase()];
  const set = new Set();
  for (const n of notes) { const t = n.text.toLowerCase(); if (terms.every(x => t.includes(x))) set.add(n.id); }
  return set;
}
export function score(hits, truthSet) {
  let tp = 0; for (const h of hits) if (truthSet.has(h)) tp++;
  return { hits: hits.length, truth: truthSet.size, recall: truthSet.size ? +(tp / truthSet.size).toFixed(3) : 1, precision: hits.length ? +(tp / hits.length).toFixed(3) : 1 };
}
export function dirSize(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  return fs.readdirSync(p).reduce((s, f) => s + dirSize(path.join(p, f)), 0);
}
// 单文件增量更新用：往笔记末尾追加一句，返回新内容
export function touchNote(id, i = 0) {
  const p = path.join(VAULT, id);
  fs.appendFileSync(p, `\n增量更新测试 ${i} incremental${i}\n`);
  return fs.readFileSync(p, 'utf8');
}
