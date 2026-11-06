// 嵌入块的编辑（S4，#15）：Mermaid 图和块级公式在盖住编辑区的弹窗里改（左源码、右预览，保存才写回）；
// 行内公式在公式旁的浮层里改（上源码、下预览），输入即写回正文，Esc / Enter / 点外部关闭
import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { i18next } from '../../shared/i18n'
import { renderEmbed, type Embed } from './embed'
import s from './EmbedEditor.module.css'
import { writeEmbed } from './livePreview'
import o from './Orphans.module.css'
import { useUi } from './store'

type Req = NonNullable<ReturnType<typeof useUi.getState>['embed']>

export function EmbedEditor() {
  const req = useUi((st) => st.embed)
  if (!req) return null
  return req.at ? <Popover req={req} /> : <Editor req={req} />
}

// 关闭后焦点回到正文，光标放在嵌入块之后；块级的放到下一行开头，免得接着输入的字写进结尾的 `$$` / 围栏
function done(req: Req, e: Embed) {
  useUi.getState().setEmbed(null)
  const len = req.view.state.doc.length
  req.view.dispatch({ selection: { anchor: Math.min(e.kind === 'inline' || e.to >= len ? e.to : e.to + 1, len) } })
  req.view.focus()
}

// 写不进去（正文那段已经变了）：报错并关掉
function write(req: Req, e: Embed, src: string): Embed | null {
  const next = writeEmbed(req.view, e, src)
  if (!next) {
    useUi.getState().setError(i18next.t('embedChanged'))
    done(req, e)
  }
  return next
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
  const save = () => {
    const e = write(req, req.embed, src)
    if (e) done(req, e)
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && done(req, req.embed)}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.dialog}
          aria-describedby={undefined}
          // 卸载时 Radix 默认把焦点还给打开前的元素（常常是 body），盖掉 done 里的 view.focus()
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            req.view.focus()
          }}
        >
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
            <button onClick={() => done(req, req.embed)}>{t('cancel')}</button>
            <button className={o.primary} onClick={save}>
              {t('save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Popover({ req }: { req: Req }) {
  const { t } = useTranslation()
  const [src, setSrc] = useState(req.embed.src)
  const cur = useRef(req.embed) // 每次写回后嵌入块的范围随之变化
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && done(req, cur.current)
    document.addEventListener('mousedown', down, true)
    return () => document.removeEventListener('mousedown', down, true)
  }, [req])
  const { left, top, bottom } = req.at!
  // 下方放不下就放到公式上方
  const pos = bottom + 200 > window.innerHeight ? { bottom: window.innerHeight - top + 6 } : { top: bottom + 6 }
  return (
    <div ref={box} className={s.pop} style={{ left: Math.max(8, Math.min(left, window.innerWidth - 368)), ...pos }} role="dialog" aria-label={t('mathEdit')}>
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
          if (e.key !== 'Escape' && e.key !== 'Enter') return
          e.preventDefault()
          done(req, cur.current)
        }}
      />
      <Preview e={req.embed} src={src} className={s.popPreview} />
    </div>
  )
}
