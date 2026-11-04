// 文件监听与对账基准：fs.watch(recursive) / @parcel/watcher / chokidar 的启动耗时，
// 模拟 "git checkout" 式批量改动后各自收到的路径覆盖率，以及 @parcel/watcher 离线快照与 stat 对账耗时。
// 用法：node gen-vault.mjs .vault-w && VAULT=.vault-w node watch-bench.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { watch as chokidarWatch } from 'chokidar';
import { VAULT, listNotes, now, ms, OUT } from './common.mjs';

const require = createRequire(import.meta.url);
const parcel = require('@parcel/watcher');
const res = { platform: `${process.platform}-${process.arch}`, node: process.version };
const sleep = (t) => new Promise(r => setTimeout(r, t));
const ids = listNotes();

// 模拟切分支：改 2000 篇、删 100、新建 100、重命名 100（目录内）
let round = 0;
function burst() {
  const changed = new Set(); round++;
  for (let i = 0; i < 2000; i++) { const id = ids[(i * 5 + round) % ids.length]; fs.appendFileSync(path.join(VAULT, id), `\nburst ${round}\n`); changed.add(id); }
  for (let i = 0; i < 100; i++) {
    const nid = `area-00/new-${round}-${i}.md`; fs.writeFileSync(path.join(VAULT, nid), '# new\n'); changed.add(nid);
  }
  for (let i = 0; i < 100; i++) {
    const id = ids[(i * 97 + 3 + round * 11) % ids.length];
    if (!fs.existsSync(path.join(VAULT, id))) continue;
    const to = id.replace(/\.md$/, `-r${round}.md`); fs.renameSync(path.join(VAULT, id), path.join(VAULT, to)); changed.add(id); changed.add(to);
  }
  return changed;
}
const coverage = (got, want) => { let n = 0; for (const p of want) if (got.has(p)) n++; return +(n / want.size).toFixed(3); };
const rel = (p) => path.relative(VAULT, p).split(path.sep).join('/');

async function trial(name, start) {
  const got = new Set(); let events = 0;
  let t = now(); const stop = await start((p) => { events++; got.add(rel(p)); }); const startMs = ms(t);
  await sleep(500);
  const want = burst();
  t = now(); let last = -1;
  while (got.size !== last) { last = got.size; await sleep(1500); } // 1.5 s 无新事件视为结束
  await stop();
  res[name] = { startMs, events, uniquePaths: got.size, changedPaths: want.size, coverage: coverage(got, want), settleMs: ms(t) - 1500 };
}

await trial('fs.watch_recursive', (cb) => {
  const w = fs.watch(VAULT, { recursive: true }, (_e, f) => f && cb(path.join(VAULT, f)));
  return () => w.close();
});
await trial('parcel_watcher', async (cb) => {
  const s = await parcel.subscribe(VAULT, (err, evs) => { if (!err) for (const e of evs) cb(e.path); });
  return () => s.unsubscribe();
});
await trial('chokidar', (cb) => new Promise(r => {
  const w = chokidarWatch(VAULT, { ignoreInitial: true });
  w.on('all', (_e, p) => cb(p)).on('ready', () => r(() => w.close()));
}));
res.chokidar_rss_note = 'chokidar 启动时会遍历并 stat 全部文件，startMs 即这一成本';

// 离线变更：写快照 → （应用关闭期间）批量改动 → getEventsSince
const snap = path.join(OUT, 'parcel.snapshot');
let t = now(); await parcel.writeSnapshot(VAULT, snap); res.parcel_writeSnapshotMs = ms(t);
const want = burst();
t = now(); const evs = await parcel.getEventsSince(VAULT, snap); res.parcel_getEventsSinceMs = ms(t);
res.parcel_offline = { events: evs.length, coverage: coverage(new Set(evs.map(e => rel(e.path))), want) };

// stat 对账：遍历 + stat 全部 .md，与上次的 mtime/size 表比较
t = now();
const table = new Map(listNotes().map(id => { const s = fs.statSync(path.join(VAULT, id)); return [id, [s.mtimeMs, s.size]]; }));
res.stat_walk_ms = ms(t); res.stat_files = table.size;
console.log(JSON.stringify(res, null, 1));
