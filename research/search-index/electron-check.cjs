// 在 Electron 的 Node 运行时里检查：node:sqlite 是否可用、SQLite 版本、FTS5/trigram；
// better-sqlite3（N-API 预编译）与 @node-rs/jieba、@parcel/watcher 能否直接加载。
// 用法：ELECTRON_RUN_AS_NODE=1 <electron> electron-check.cjs  （模块从 NODE_PATH 或当前目录 node_modules 解析）
const out = { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules };
const fts = (db) => {
  db.exec("create virtual table t using fts5(x, tokenize='trigram')");
  db.exec("insert into t values ('全文搜索与反链索引')");
  return db.prepare("select count(*) n from t where t match '反链索'").get().n;
};
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  out.nodeSqlite = { version: db.prepare('select sqlite_version() v').get().v, trigramHit: fts(db) };
} catch (e) { out.nodeSqlite = 'ERR ' + e.message; }
try {
  const D = require('better-sqlite3');
  const db = new D(':memory:');
  out.betterSqlite3 = { version: db.prepare('select sqlite_version() v').get().v, trigramHit: fts(db) };
} catch (e) { out.betterSqlite3 = 'ERR ' + e.message; }
try { out.jieba = require('@node-rs/jieba').Jieba.withDict(require('@node-rs/jieba/dict').dict).cut('全文搜索与反链索引', false); } catch (e) { out.jieba = 'ERR ' + e.message; }
try { require('@parcel/watcher'); out.parcelWatcher = 'ok'; } catch (e) { out.parcelWatcher = 'ERR ' + e.message; }
console.log(JSON.stringify(out, null, 1));
