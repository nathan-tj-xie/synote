// git 冲突标记（S16）：完成合并前的全库复查用（#9 决定 3）。冲突视图改为合并编辑器（#70）后不再解析冲突块

// 只要还有一行起止标记就算残留：手改到一半删掉部分标记时也拦得住。
// ======= 单独不算（Markdown 的 setext 标题）；长度 7 起（conflict-marker-size 可调长）
// shortcut: 设得比 7 短的 conflict-marker-size 认不出；有人这样配时改为按 check-attr 取每个文件的长度
export const hasConflictMarkers = (text: string) => /^(<{7,}|>{7,}|\|{7,})(?: |\r?$)/m.test(text)
