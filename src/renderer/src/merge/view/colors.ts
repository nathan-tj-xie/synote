// 合并编辑器的颜色（对应上游 view/colors.ts 注册的主题色）：standalone 没有主题色注册表，取设计 token（ADR 0003）。
// 其余颜色在 mergeEditor.css 里用 CSS 变量
import { tokens } from '../../../../shared/tokens'

export const handledConflictMinimapOverViewRulerColor = tokens.fgMuted
export const unhandledConflictMinimapOverViewRulerColor = tokens.merging
