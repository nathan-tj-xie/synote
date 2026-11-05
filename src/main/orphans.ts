// 清理孤儿附件（S11）：删除前在主进程逐个复核路径，再按 git 跟踪状态分流（已跟踪 git rm，其余移到回收站）
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Git } from './git'
import { realInVault, realParentInVault, within } from './vault'

// shortcut: 每条 git 命令最多带 100 个路径，避开 Windows 约 32K 的命令行上限；要一次处理上万个时改用 --pathspec-from-file
const CHUNK = 100

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK))
  return out
}

// 字面上是 attachments/ 下的规范相对路径：每段非空、不是 . 或 ..，不含反斜杠、冒号（盘符）和 NUL
export const isAttachmentPath = (rel: unknown): rel is string =>
  typeof rel === 'string' && rel.startsWith('attachments/') && !/[\\:\0]/.test(rel) && rel.split('/').every((s) => s && s !== '.' && s !== '..')

// 删除 / 恢复附件前的路径校验（S11、S15 共用）：字面合格，且真实父目录在库的真实 attachments/ 内。
// 返回「真实父目录 + 末级名」（末级是链接时就是链接本身），不合格为 null；att 是已取好的真实 attachments/
export async function attachmentTarget(root: string, rel: unknown, att?: string | null): Promise<string | null> {
  if (!isAttachmentPath(rel)) return null
  const real = att ?? (await realInVault(root, 'attachments').catch(() => null))
  if (!real) return null
  const abs = await realParentInVault(root, rel).catch(() => null)
  return abs && within(real, path.dirname(abs)) ? abs : null
}

// 只留下仍是孤儿（orphans 取自删除时刻的索引）且通过 attachmentTarget 校验的现存文件。
// 不合格的跳过，不报错；返回 [相对路径, 回收用的路径]，末级是链接时回收链接本身
export async function checkOrphans(root: string, paths: string[], orphans: Set<string>): Promise<[string, string][]> {
  const att = await realInVault(root, 'attachments').catch(() => null)
  if (!att) return []
  const out: [string, string][] = []
  for (const rel of new Set(paths)) {
    if (!orphans.has(rel)) continue
    const abs = await attachmentTarget(root, rel, att)
    const st = abs ? await fs.lstat(abs).catch(() => null) : null
    if (st && !st.isDirectory()) out.push([rel, abs!])
    else console.warn(`[orphans] skip ${rel}`)
  }
  return out
}

// git 为 null 表示非 git 目录（或没有可用的 git），什么都不算已跟踪
export async function trackedOf(git: Git | null, rels: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (git) for (const c of chunks(rels)) for (const p of await git.tracked(c)) out.add(p)
  return out
}

// 已跟踪的 git rm（进入下次提交，可从历史恢复），其余移到回收站。返回已删除的相对路径
export async function removeOrphans(targets: [string, string][], git: Git | null, trash: (abs: string) => Promise<void>): Promise<string[]> {
  const rels = targets.map(([rel]) => rel)
  const tracked = await trackedOf(git, rels)
  for (const c of chunks(rels.filter((r) => tracked.has(r)))) await git!.rm(c)
  for (const [rel, abs] of targets) if (!tracked.has(rel)) await trash(abs)
  return rels
}
