// PROTOTYPE：生成 10k 篇假笔记到 .vault-10k（wipe me），用于测首屏
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.vault-10k');
const N = Number(process.argv[3] ?? 10000);
rmSync(root, { recursive: true, force: true });
const para = '这是一段用于填充的正文，包含 **粗体**、*斜体* 和 `代码`。The quick brown fox jumps over the lazy dog. ';
for (let i = 0; i < N; i++) {
  const dir = path.join(root, `area-${i % 20}`, `topic-${i % 200}`);
  mkdirSync(dir, { recursive: true });
  const link = `[笔记 ${(i * 7) % N}](../../area-${((i * 7) % N) % 20}/topic-${((i * 7) % N) % 200}/笔记-${(i * 7) % N}.md)`;
  writeFileSync(path.join(dir, `笔记-${i}.md`), `# 笔记 ${i}\n\n参见 ${link}。\n\n${para.repeat(1 + (i % 30))}\n`);
}
console.log(`wrote ${N} notes to ${root}`);
