// 链接 / 附件引用抽取与反链、引用计数数据结构的基准
// 用法：node links-bench.mjs   （先 node gen-vault.mjs）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readNotes, VAULT, now, ms, median } from './common.mjs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parser } from '@lezer/markdown';

const require = createRequire(import.meta.url);
const notes = readNotes();
const res = { notes: notes.length };

const WIKI = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const HTML_SRC = /\b(?:src|href)\s*=\s*["']([^"']+)["']/g;
// 附件宽松识别：全文（含代码块、HTML、引用式定义）里出现 attachments/<文件名> 即算引用
const ATT = /attachments\/([\w.-]+\.\w+)/g;

// A：纯正则（会把代码块里的链接也算进去）
function viaRegex(text) {
  const links = [...text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
  for (const m of text.matchAll(HTML_SRC)) links.push(m[1]);
  return { links, wikis: [...text.matchAll(WIKI)].map(m => m[1]) };
}
// B：micromark → mdast（CommonMark 准确；wikilink 在 text 节点里再扫）
function viaMdast(text) {
  const links = []; const wikis = [];
  const walk = (n) => {
    if (n.type === 'link' || n.type === 'image' || n.type === 'definition') links.push(n.url);
    else if (n.type === 'html') for (const m of n.value.matchAll(HTML_SRC)) links.push(m[1]);
    else if (n.type === 'text') for (const m of n.value.matchAll(WIKI)) wikis.push(m[1]);
    if (n.children) n.children.forEach(walk);
  };
  walk(fromMarkdown(text));
  return { links, wikis };
}
// C：@lezer/markdown（与 CM6 同源）；只取语法树里的 URL 节点，wikilink 扫非代码区
function viaLezer(text) {
  const links = []; const code = [];
  parser.parse(text).iterate({
    enter(n) {
      if (n.name === 'URL') { const p = n.node.parent?.name; if (p === 'Link' || p === 'Image' || p === 'LinkReference') links.push(text.slice(n.from, n.to)); }
      else if (n.name === 'HTMLTag' || n.name === 'HTMLBlock') for (const m of text.slice(n.from, n.to).matchAll(HTML_SRC)) links.push(m[1]);
      else if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') { code.push([n.from, n.to]); return false; }
    },
  });
  const wikis = [...text.matchAll(WIKI)].filter(m => !code.some(([a, b]) => m.index >= a && m.index < b)).map(m => m[1]);
  return { links, wikis };
}

const METHODS = { regex: viaRegex, mdast: viaMdast, lezer: viaLezer };
const parsed = {};
for (const [k, fn] of Object.entries(METHODS)) {
  fn(notes[0].text); // 预热
  const t = now();
  parsed[k] = notes.map(n => fn(n.text));
  res[`parse_${k}_ms`] = ms(t);
  res[`parse_${k}_counts`] = { links: parsed[k].reduce((s, x) => s + x.links.length, 0), wikis: parsed[k].reduce((s, x) => s + x.wikis.length, 0) };
}
let t = now();
const attRaw = notes.map(n => [...n.text.matchAll(ATT)].map(m => m[1]));
res.att_regex_ms = ms(t);

// —— 图结构：正向 out、反向 back、附件引用 attRefs ——
const byName = new Map(); // 笔记名（无扩展名）→ 路径列表，用于解析 [[...]]
for (const n of notes) { const b = path.posix.basename(n.id, '.md'); (byName.get(b) ?? byName.set(b, []).get(b)).push(n.id); }
const resolve = (src, url) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // 外链
  let u = url.split('#')[0]; if (!u) return null;
  try { u = decodeURI(u); } catch { /* 非法编码按原样 */ }
  return path.posix.normalize(path.posix.join(path.posix.dirname(src), u));
};
const out = new Map(); const back = new Map(); const attRefs = new Map();
const add = (m, k, v) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(v);
function indexNote(id, { links, wikis }, atts) {
  const e = { notes: new Set(), atts: new Set(atts), unresolved: new Set() };
  for (const l of links) { const r = resolve(id, l); if (!r) continue; if (r.endsWith('.md')) e.notes.add(r); }
  for (const w of wikis) { const c = byName.get(w.trim()); c ? e.notes.add(c[0]) : e.unresolved.add(w); }
  for (const d of e.notes) add(back, d, id);
  for (const a of e.atts) add(attRefs, a, id);
  out.set(id, e);
}
function unindexNote(id) {
  const e = out.get(id); if (!e) return;
  for (const d of e.notes) back.get(d)?.delete(id);
  for (const a of e.atts) { const s = attRefs.get(a); s?.delete(id); if (s && !s.size) attRefs.delete(a); }
  out.delete(id);
}
t = now();
notes.forEach((n, i) => indexNote(n.id, parsed.lezer[i], attRaw[i]));
res.graph_build_ms = ms(t);
res.edges = [...out.values()].reduce((s, e) => s + e.notes.size, 0);
res.dangling = [...back.keys()].filter(k => !out.has(k)).length;

// 反链查询：1000 次取中位数（μs 级）
const ids = notes.map(n => n.id);
const times = []; for (let i = 0; i < 1000; i++) { const t0 = now(); back.get(ids[(i * 7919) % ids.length])?.size; times.push(performance.now() - t0); }
res.backlink_lookup_us = +(median(times) * 1000).toFixed(2);

// 孤儿附件：列 attachments/ 减去引用计数 > 0 的
t = now();
const attFiles = fs.readdirSync(path.join(VAULT, 'attachments'));
const orphans = attFiles.filter(a => !attRefs.get(a)?.size);
res.orphan_ms = ms(t); res.orphans = orphans.length; res.attachments = attFiles.length;

// 单篇增量：重新解析 + 撤旧边 + 加新边
const ups = [];
for (let i = 0; i < 20; i++) {
  const n = notes[(i * 997) % notes.length];
  const t0 = now(); unindexNote(n.id); indexNote(n.id, viaLezer(n.text), [...n.text.matchAll(ATT)].map(m => m[1])); ups.push(ms(t0));
}
res.incremental_note_ms = median(ups);

// 重命名改写：找出所有链接到某篇的笔记（改写本身是逐文件文本替换）
const hot = [...back.entries()].sort((a, b) => b[1].size - a[1].size)[0];
res.rename_max_backlinks = hot[1].size;

// 持久化到 SQLite（与 FTS 同库时的形态）：links(src,dst) + 按 dst 建索引
const Database = require('better-sqlite3');
const dbFile = path.join(import.meta.dirname, '.out', 'links.db'); fs.rmSync(dbFile, { force: true });
const db = new Database(dbFile);
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE links(src TEXT, dst TEXT, kind INTEGER); CREATE INDEX links_dst ON links(dst);`);
const ins = db.prepare('INSERT INTO links VALUES (?,?,?)');
t = now();
db.transaction(() => { for (const [src, e] of out) { for (const d of e.notes) ins.run(src, d, 0); for (const a of e.atts) ins.run(src, 'attachments/' + a, 1); } })();
res.sqlite_links_insert_ms = ms(t);
const q = db.prepare('SELECT src FROM links WHERE dst = ?');
const qt = []; for (let i = 0; i < 200; i++) { const t0 = now(); q.all(ids[(i * 31) % ids.length]); qt.push(performance.now() - t0); }
res.sqlite_backlink_query_us = +(median(qt) * 1000).toFixed(1);
t = now();
const orphanSql = db.prepare("SELECT count(*) c FROM links WHERE kind = 1 AND dst = ?");
let o2 = 0; for (const a of attFiles) if (!orphanSql.get('attachments/' + a).c) o2++;
res.sqlite_orphan_ms = ms(t); res.sqlite_orphans = o2;
db.close();
res.links_db_mb = +(fs.statSync(dbFile).size / 2 ** 20).toFixed(1);

console.log(JSON.stringify(res, null, 1));
