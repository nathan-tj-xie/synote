// 查询各候选包的当前版本与发布日期（npm registry），以及 Electron 稳定版对应的 Node 版本
const pkgs = ['minisearch', 'flexsearch', 'better-sqlite3', '@parcel/watcher', 'chokidar', 'micromark',
  'mdast-util-from-markdown', '@lezer/markdown', 'electron', 'electron-builder', '@electron/rebuild',
  '@node-rs/jieba', 'nodejieba', '@orama/orama'];
for (const p of pkgs) {
  const r = await (await fetch('https://registry.npmjs.org/' + p.replace('/', '%2f'))).json();
  const v = r['dist-tags'].latest;
  console.log(p, v, r.time[v].slice(0, 10), JSON.stringify(r.versions[v].engines ?? {}));
}
const rel = await (await fetch('https://releases.electronjs.org/releases.json')).json();
for (const x of rel.filter(x => !x.version.includes('-')).slice(0, 4))
  console.log('electron', x.version, x.date, 'node', x.node, 'chrome', x.chrome, 'modules', x.modules);
