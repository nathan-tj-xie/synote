// 三种中文切分方式对全库的切分耗时与 token 数
import { readNotes, TOKENIZERS, now, ms } from './common.mjs';

const notes = readNotes();
for (const [name, tok] of Object.entries(TOKENIZERS)) {
  tok(notes[0].text); // 预热（jieba 加载词典）
  const t = now(); let n = 0;
  for (const x of notes) n += tok(x.text).length;
  console.log(JSON.stringify({ name, ms: ms(t), tokens: n }));
}
