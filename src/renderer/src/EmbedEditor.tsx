// 嵌入块的编辑（S4，#15）：Mermaid 图和 `$$` 公式在盖住编辑区的弹窗里改（左源码、右预览，保存才写回）；
// `$x$` 在公式旁的浮层里改（上源码、下预览），输入即写回正文，Esc / Enter / 点外部关闭
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { i18next } from '../../shared/i18n'
import { canWrite, renderEmbed, type Embed } from './embed'
import s from './EmbedEditor.module.css'
import { besideBlock, sameNote, writeEmbed } from './livePreview'
import o from './Orphans.module.css'
import { useUi } from './store'

type Req = NonNullable<ReturnType<typeof useUi.getState>['embed']>

export function EmbedEditor() {
  const req = useUi((st) => st.embed)
  if (!req) return null
  // 按请求重建：从一个公式的浮层直接点另一个时，关闭和打开在同一批更新里，不能沿用前一个的输入和范围
  return req.at ? <Inline key={req.id} req={req} /> : <Editor key={req.id} req={req} />
}

// 关闭后（保存或取消）焦点回到正文，光标放在嵌入块之后：块级的放到下一行开头（文末时补一个换行，besideBlock），
// 免得接着输入的字写进结尾的 `$$` / 围栏。已打开了下一个（同一批更新里）就不关它；视图已换成别的笔记时不动光标
function done(req: Req, e: Embed) {
  if (useUi.getState().embed?.id === req.id) useUi.getState().setEmbed(null)
  if (!sameNote(req.view, req.note)) return
  const { view } = req
  const there = e.text !== '' && view.state.sliceDoc(e.from, e.to) === e.text // 新建后取消的还没写进正文
  if (e.block && there) besideBlock(view, e, true)
  else view.dispatch({ selection: { anchor: Math.min(e.to, view.state.doc.length) } })
  view.focus()
}

// 写不进去（换了笔记、正文那段已经变了）：报错并关掉
function write(req: Req, e: Embed, src: string): Embed | null {
  const next = writeEmbed(req.view, req.note, e, src)
  if (!next) {
    useUi.getState().setError(i18next.t('embedChanged'))
    done(req, e)
  }
  return next
}

// 卸载时 Radix 默认把焦点还给打开前的元素（常常是 body），盖掉 done 里的 view.focus()。
// 已经打开了下一个（从一个公式直接点另一个）就不抢焦点，否则新浮层失焦即关
const keepFocus = (req: Req) => (e: Event) => {
  e.preventDefault()
  if (!useUi.getState().embed && sameNote(req.view, req.note)) req.view.focus()
}

function Preview({ e, src, className }: { e: Embed; src: string; className: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => renderEmbed(ref.current!, e.kind, src, e.display, src, t(e.kind === 'mermaid' ? 'mermaidEmpty' : 'mathEmpty')), [e, src, t])
  return <div ref={ref} className={className} aria-label={t('embedPreview')} />
}

function Editor({ req }: { req: Req }) {
  const { t } = useTranslation()
  const [src, setSrc] = useState(req.embed.src)
  const ok = canWrite(req.embed, src)
  const save = () => {
    if (!ok) return
    const e = write(req, req.embed, src)
    if (e) done(req, e)
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && done(req, req.embed)}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.dialog} aria-describedby={undefined} onCloseAutoFocus={keepFocus(req)}>
          <Dialog.Title className={o.title}>{t(req.embed.kind === 'mermaid' ? 'mermaidEdit' : 'mathEdit')}</Dialog.Title>
          <div className={s.panes}>
            <textarea
              className={s.source}
              aria-label={t('embedSource')}
              value={src}
              autoFocus
              spellCheck={false}
              onChange={(e) => setSrc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  save()
                }
              }}
            />
            <Preview e={req.embed} src={src} className={s.preview} />
          </div>
          <div className={o.actions}>
            {!ok && (
              <p className={s.hint} role="status">
                {t('inlineMathNewline')}
              </p>
            )}
            <button onClick={() => done(req, req.embed)}>{t('cancel')}</button>
            <button className={o.primary} disabled={!ok} onClick={save}>
              {t('save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Inline({ req }: { req: Req }) {
  const { t } = useTranslation()
  const [src, setSrc] = useState(req.embed.src)
  const cur = useRef(req.embed) // 每次写回后嵌入块的范围随之变化
  const at = req.at!
  return (
    <Popover.Root open onOpenChange={(open) => !open && done(req, cur.current)}>
      {/* 锚在公式的框上：Radix 负责放在下方、放不下时翻到上方 */}
      <Popover.Anchor style={{ position: 'fixed', left: at.left, top: at.top, width: at.width, height: at.height, pointerEvents: 'none' }} />
      <Popover.Portal>
        <Popover.Content className={s.pop} side="bottom" align="start" sideOffset={6} collisionPadding={8} aria-label={t('mathEdit')} onCloseAutoFocus={keepFocus(req)}>
          <input
            className={s.inline}
            aria-label={t('embedSource')}
            value={src}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              const next = write(req, cur.current, e.target.value)
              if (!next) return
              cur.current = next
              setSrc(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              done(req, cur.current)
            }}
          />
          <Preview e={req.embed} src={src} className={s.popPreview} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
