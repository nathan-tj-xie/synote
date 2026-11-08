// 生成 app-builder-lib 的 resolveSeededChecksums 认的 <缓存根目录>/SHASUMS256.txt-<version>
const fs = require('fs')
const os = require('os')
const path = require('path')
const dir = path.resolve('node_modules/electron')
const { version } = require(path.join(dir, 'package.json'))
const checksums = require(path.join(dir, 'checksums.json'))
// 与 @electron/get 默认缓存目录（env-paths）一致
const root =
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')
    : path.join(os.homedir(), 'Library', 'Caches', 'electron')
fs.mkdirSync(root, { recursive: true })
const file = path.join(root, `SHASUMS256.txt-${version}`)
fs.writeFileSync(file, Object.entries(checksums).map(([name, hash]) => `${hash} *${name}`).join('\n') + '\n')
console.log(`seeded ${file}`)
