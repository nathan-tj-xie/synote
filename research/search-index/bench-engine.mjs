// 单个引擎的基准。用法：node bench-engine.mjs <engine> <build|load>
// build：读库 → 建索引 → 持久化到 .out/<engine>，输出耗时与体积
// load ：新进程里从持久化索引加载 → 跑查询（耗时 + 与子串真值比对）→ 单文件增量更新
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readNotes, listNotes, TOKENIZERS, bigram, QUERIES, truth, score, now, ms, median, dirSize, OUT, touchNote } from './common.mjs';

const require = createRequire(import.meta.url);
const [engine, phase] = process.argv.slice(2);
const store = path.join(OUT, engine);
const TOP = 50;
const RUNS = 15;

// 把查询变成 token 列表；substr 查询整体切，and 查询逐词切
const qTokens = (tok, { q, kind }) => kind === 'and' ? q.split(/\s+/).flatMap(tok) : tok(q);

function minisearchEngine(tokName) {
  const MiniSearch = require('minisearch');
  const tokenize = TOKENIZERS[tokName];
  const opts = {
    fields: ['text'], idField: 'id', tokenize, processTerm: (t) => t,
    searchOptions: { combineWith: 'AND', prefix: (_t, i, terms) => i === terms.length - 1 },
  };
  let ix;
  return {
    build(notes) { ix = new MiniSearch(opts); ix.addAll(notes); },
    persist() { fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, 'index.json'), JSON.stringify(ix)); },
    load() { ix = MiniSearch.loadJSON(fs.readFileSync(path.join(store, 'index.json'), 'utf8'), opts); },
    // MiniSearch 自带排序（BM25+），返回全部命中
    search(qq) { return ix.search(qTokens(tokenize, qq).join(' ')).slice(0, TOP).map(r => r.id); },
    all(qq) { return ix.search(qTokens(tokenize, qq).join(' ')).map(r => r.id); },
    update(note) { ix.discard(note.id); ix.add(note); },
  };
}

function flexsearchEngine() {
  const { Index } = require('flexsearch');
  // 自定义 encode：直接用 bigram 分词结果，不让 FlexSearch 再拆
  const mk = () => new Index({ tokenize: 'forward', encode: bigram, resolution: 9, cache: false });
  let ix; let ids = [];
  const idOf = new Map();
  return {
    build(notes) { ix = mk(); ids = notes.map(n => n.id); notes.forEach((n, i) => { idOf.set(n.id, i); ix.add(i, n.text); }); },
    async persist() {
      fs.rmSync(store, { recursive: true, force: true }); fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, 'ids.json'), JSON.stringify(ids));
      await ix.export((key, data) => fs.writeFileSync(path.join(store, 'x.' + key), data ?? ''));
    },
    async load() {
      ix = mk(); ids = JSON.parse(fs.readFileSync(path.join(store, 'ids.json'), 'utf8'));
      ids.forEach((id, i) => idOf.set(id, i));
      for (const f of fs.readdirSync(store)) if (f.startsWith('x.')) await ix.import(f.slice(2), fs.readFileSync(path.join(store, f), 'utf8'));
    },
    search(qq) { return ix.search(qTokens(bigram, qq).join(' '), { limit: TOP }).map(i => ids[i]); },
    all(qq) { return ix.search(qTokens(bigram, qq).join(' '), { limit: 100000 }).map(i => ids[i]); },
    update(note) { ix.update(idOf.get(note.id), note.text); },
  };
}

// SQLite FTS5 trigram；driver = better-sqlite3 | node:sqlite（两者 prepare/run/get/all 接口基本一致）
function sqliteEngine(driver, detail = 'full') {
  const file = path.join(store, 'index.db');
  const open = () => driver === 'node' ? new (require('node:sqlite').DatabaseSync)(file) : new (require('better-sqlite3'))(file);
  let db; let q;
  // 字面子串：整体加双引号作为 FTS5 string；不足 3 字符的走 LIKE（trigram 索引无法加速，全表扫描）
  const fts = (s) => '"' + s.replaceAll('"', '""') + '"';
  const plan = ({ q: s, kind }) => {
    const terms = kind === 'and' ? s.split(/\s+/) : [s];
    // detail!=full 不支持 phrase MATCH，改走 LIKE（≥3 字符时 FTS5 仍用 trigram 索引加速）
    if (detail === 'full' && terms.every(t => [...t].length >= 3)) return { sql: 'match', arg: terms.map(fts).join(' ') };
    return { sql: 'like', args: terms };
  };
  const prep = () => {
    q = {
      match: db.prepare(`SELECT path FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ${TOP}`),
      matchAll: db.prepare(`SELECT path FROM fts WHERE fts MATCH ?`),
      del: db.prepare('DELETE FROM fts WHERE path = ?'),
      ins: db.prepare('INSERT INTO fts(path, body) VALUES (?, ?)'),
      meta: db.prepare('INSERT OR REPLACE INTO files(path, mtime, size) VALUES (?, ?, ?)'),
    };
  };
  const like = (terms, limit) => db.prepare(`SELECT path FROM fts WHERE ${terms.map(() => 'body LIKE ?').join(' AND ')}${limit ? ' LIMIT ' + limit : ''}`)
    .all(...terms.map(t => '%' + t + '%')).map(r => r.path);
  const run = (qq, limit) => {
    const p = plan(qq);
    if (p.sql === 'like') return like(p.args, limit);
    return (limit ? q.match : q.matchAll).all(p.arg).map(r => r.path);
  };
  return {
    build(notes) {
      fs.rmSync(store, { recursive: true, force: true }); fs.mkdirSync(store, { recursive: true });
      db = open();
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE files(path TEXT PRIMARY KEY, mtime REAL, size INTEGER) WITHOUT ROWID;
        CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, body, tokenize='trigram', detail=${detail});`);
      prep();
      db.exec('BEGIN');
      for (const n of notes) { q.ins.run(n.id, n.text); q.meta.run(n.id, n.mtimeMs, n.size); }
      db.exec('COMMIT');
    },
    persist() { db.exec("INSERT INTO fts(fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE);"); db.close(); },
    load() { db = open(); prep(); },
    search: (qq) => run(qq, TOP),
    all: (qq) => run(qq, 0),
    update(note) {
      db.exec('BEGIN'); q.del.run(note.id); q.ins.run(note.id, note.text); q.meta.run(note.id, note.mtimeMs ?? 0, note.size ?? 0); db.exec('COMMIT');
    },
  };
}

// tantivy（@oxdev03/node-tantivy-binding，napi-rs）；正文预先切成 bigram 后用 whitespace 分词，查询用 phrase 保证相邻
function tantivyEngine() {
  const T = require('@oxdev03/node-tantivy-binding');
  const schema = () => new T.SchemaBuilder().addTextField('id', { stored: true, tokenizerName: 'raw' })
    .addTextField('body', { stored: false, tokenizerName: 'ws' }).build();
  const reg = (ix) => ix.registerTokenizer('ws', new T.TextAnalyzerBuilder(T.TokenizerStatic.whitespace()).build());
  let ix; let writer;
  const doc = (n) => { const d = new T.Document(); d.addText('id', n.id); d.addText('body', bigram(n.text).join(' ')); return d; };
  const query = ({ q, kind }) => {
    const words = kind === 'and' ? q.split(/\s+/) : [q];
    return words.map(w => { const t = bigram(w); return '+' + (t.length > 1 ? `"${t.join(' ')}"` : t[0]); }).join(' ');
  };
  const run = (qq, limit) => {
    const s = ix.searcher();
    return s.search(ix.parseQuery(query(qq), ['body']), limit).hits.map(h => s.doc(h.docAddress).getFirst('id'));
  };
  return {
    build(notes) {
      fs.rmSync(store, { recursive: true, force: true }); fs.mkdirSync(store, { recursive: true });
      ix = new T.Index(schema(), store); reg(ix);
      writer = ix.writer(100_000_000);
      for (const n of notes) writer.addDocument(doc(n));
      writer.commit();
    },
    persist() { writer.waitMergingThreads(); },
    load() { ix = T.Index.open(store); reg(ix); ix.reload(); },
    search: (qq) => run(qq, TOP),
    all: (qq) => run(qq, 100000),
    update(n) {
      writer ??= ix.writer(50_000_000);
      writer.deleteDocumentsByTerm('id', n.id); writer.addDocument(doc(n)); writer.commit(); ix.reload();
    },
  };
}

const ENGINES = {
  'minisearch-bigram': () => minisearchEngine('bigram'),
  'minisearch-segmenter': () => minisearchEngine('segmenter'),
  'minisearch-jieba': () => minisearchEngine('jieba'),
  'flexsearch-bigram': flexsearchEngine,
  'sqlite-trigram-better': () => sqliteEngine('better'),
  'sqlite-trigram-node': () => sqliteEngine('node'),
  'sqlite-trigram-detail-none': () => sqliteEngine('better', 'none'),
  'tantivy-bigram': tantivyEngine,
};

const e = ENGINES[engine]();
const res = { engine, phase };
if (phase === 'build') {
  let t = now(); const notes = readNotes(); res.readMs = ms(t);
  t = now(); await e.build(notes); res.buildMs = ms(t);
  t = now(); await e.persist(); res.persistMs = ms(t);
  res.sizeMB = +(dirSize(store) / 2 ** 20).toFixed(1);
  res.heapMB = Math.round(process.memoryUsage().rss / 2 ** 20);
} else {
  let t = now(); await e.load(); res.loadMs = ms(t);
  res.rssMB = Math.round(process.memoryUsage().rss / 2 ** 20);
  const notes = readNotes();
  res.queries = QUERIES.map(qq => {
    const times = [];
    for (let i = 0; i < RUNS; i++) { const t0 = now(); e.search(qq); times.push(ms(t0)); }
    return { name: qq.name, q: qq.q, ms: median(times), ...score(e.all(qq), truth(notes, qq)) };
  });
  // 单文件增量：改一篇 → 引擎内更新 → 持久化（MiniSearch/FlexSearch 只能整份重写）
  const id = listNotes()[123];
  const ups = []; const pers = [];
  for (let i = 0; i < 5; i++) {
    const text = touchNote(id, i);
    let t0 = now(); await e.update({ id, text }); ups.push(ms(t0));
    if (!engine.startsWith('sqlite') && !engine.startsWith('tantivy')) { t0 = now(); await e.persist(); pers.push(ms(t0)); }
  }
  res.updateMs = median(ups);
  if (pers.length) res.updatePersistMs = median(pers);
}
console.log(JSON.stringify(res));
