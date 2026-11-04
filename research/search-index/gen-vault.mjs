// 生成 10k 篇中英混合 Markdown 测试库（可复现：固定随机种子）
// 用法：node gen-vault.mjs [outDir=.vault] [notes=10000]
// 中文词表取 @node-rs/jieba 自带 dict.txt 的高频词 + 一组 jieba 词典外的产品术语（测 OOV）；
// 英文词表取 macOS /usr/share/dict/words。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const out = path.resolve(process.argv[2] ?? '.vault');
const N = Number(process.argv[3] ?? 10000);
const ATT = 3000; // 附件数；其中约 10% 不被任何笔记引用（孤儿）

let seed = 42;
const rnd = () => { // mulberry32
  let t = (seed = (seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
// Zipf 近似：rank = floor(n * u^3)，让少数词很常见、多数词稀有
const zipf = (arr) => arr[Math.floor(arr.length * rnd() ** 3)];

const require = createRequire(import.meta.url);
const dictTxt = fs.readFileSync(require.resolve('@node-rs/jieba/dict.txt'), 'utf8');
const zh = dictTxt.split('\n').map(l => l.split(' ')).filter(([w, f]) => /^[一-鿿]{2,4}$/.test(w) && +f > 50)
  .sort((a, b) => b[1] - a[1]).slice(0, 12000).map(([w]) => w);
const jargon = ['反链', '双链', '孤儿附件', '实时预览', '笔记库', '冲突解决', '增量索引', '内容哈希', '链接改写', '手动模式'];
const en = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter(w => /^[a-z]{3,10}$/.test(w));
const enV = []; for (let i = 0; i < 6000; i++) enV.push(en[Math.floor(rnd() * en.length)]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'attachments'), { recursive: true });

// 附件：内容随机的小文件，按内容 sha256 前 16 位命名
const atts = [];
for (let i = 0; i < ATT; i++) {
  const buf = crypto.randomBytes(64);
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + (i % 5 ? '.png' : '.pdf');
  fs.writeFileSync(path.join(out, 'attachments', name), buf);
  atts.push(name);
}
const usedAtts = atts.slice(0, Math.floor(ATT * 0.9));

// 笔记路径：20 area × 10 topic × 50；文件名中英混合，部分带空格
const notes = [];
for (let i = 0; i < N; i++) {
  const dir = `area-${String(i % 20).padStart(2, '0')}/topic-${Math.floor(i / 20) % 10}`;
  const base = rnd() < 0.6 ? `${zipf(zh)}${zipf(zh)}-${i}` : `${zipf(enV)} ${zipf(enV)} ${i}`;
  notes.push({ dir, name: base, rel: `${dir}/${base}.md` });
}

const relLink = (from, to) => {
  let r = path.posix.relative(path.posix.dirname(from), to);
  if (!r.startsWith('.')) r = './' + r;
  return r.replaceAll(' ', '%20'); // ADR 0001：空格编码为 %20，非 ASCII 原样
};
const sentence = () => {
  const parts = [];
  for (let k = ri(8, 30); k > 0; k--) {
    const r = rnd();
    if (r < 0.62) parts.push(zipf(zh));
    else if (r < 0.64) parts.push(jargon[ri(0, jargon.length - 1)]);
    else parts.push(' ' + zipf(enV) + ' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim() + (rnd() < 0.5 ? '。' : '. ');
};

let bytes = 0;
const truthLinks = { note: 0, wiki: 0, att: 0 };
for (const [i, n] of notes.entries()) {
  const lines = [`# ${n.name}`, ''];
  for (let p = ri(3, 7); p > 0; p--) {
    let para = '';
    for (let s = ri(2, 5); s > 0; s--) para += sentence();
    lines.push(para, '');
  }
  for (let k = ri(0, 6); k > 0; k--) {
    const t = notes[ri(0, N - 1)];
    lines.push(`- 参见 [${t.name}](${relLink(n.rel, t.rel)})`); truthLinks.note++;
  }
  if (rnd() < 0.3) { lines.push(`相关：[[${notes[ri(0, N - 1)].name}]]`, ''); truthLinks.wiki++; }
  for (let k = ri(0, 2); k > 0; k--) {
    const a = usedAtts[ri(0, usedAtts.length - 1)];
    lines.push(rnd() < 0.8 ? `![图](${relLink(n.rel, 'attachments/' + a)})` : `<img src="${relLink(n.rel, 'attachments/' + a)}" width="300">`, '');
    truthLinks.att++;
  }
  if (rnd() < 0.1) lines.push('```md', `[代码块里的链接不算](./not-a-link.md)`, '```', '');
  const text = lines.join('\n');
  fs.mkdirSync(path.join(out, n.dir), { recursive: true });
  fs.writeFileSync(path.join(out, n.rel), text);
  bytes += Buffer.byteLength(text);
  if (i === 0) fs.writeFileSync(path.join(out, '..', 'sample-note.md'), text);
}
// 确保每个 usedAtts 至少被引用一次（补到第 0 篇笔记末尾）
fs.appendFileSync(path.join(out, notes[0].rel), '\n' + usedAtts.map(a => `![](${relLink(notes[0].rel, 'attachments/' + a)})`).join('\n') + '\n');

console.log(JSON.stringify({ out, notes: N, attachments: ATT, orphans: ATT - usedAtts.length, mdBytes: bytes, avgBytes: Math.round(bytes / N), ...truthLinks }));
