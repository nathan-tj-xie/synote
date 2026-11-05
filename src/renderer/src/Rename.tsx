// "重命名 / 移动"对话框（S9）：编辑相对笔记库的新路径（改名、换目录都在这里），要改写链接时先列出文件数和清单再确认
import * as Dialog from '@radix-ui/react-dialog'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { renamePath } from './editor'
import s from './Orphans.module.css'
import { useUi } from './store'

export function Rename() {
  const req = useUi((st) => st.rename)
  const answer = useRef<((ok: boolean) => void) | null>(null)
  // 关掉对话框等于在确认这一步取消
  const close = () => {
    answer.current?.(false)
    answer.current = null
    useUi.getState().setRename(null)
  }
  return (
    <Dialog.Root open={req !== null} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          {req && <Body key={`${req.root}\0${req.from}`} req={req} answer={answer} close={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({ req, answer, close }: { req: { root: string; from: string }; answer: React.RefObject<((ok: boolean) => void) | null>; close: () => void }) {
  const { t } = useTranslation()
  const [to, setTo] = useState(req.from)
  const [files, setFiles] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const confirm = (list: string[]) =>
        new Promise<boolean>((resolve) => {
          if (useUi.getState().rename !== req) return resolve(false) // 算清单期间已关掉对话框
          answer.current = resolve
          setFiles(list)
          setBusy(false)
        })
      if (await renamePath(req.root, req.from, to.trim(), confirm)) close()
    } catch (e) {
      close()
      useUi.getState().setError(String(e))
    }
  }
  const decide = (ok: boolean) => {
    setBusy(true)
    answer.current?.(ok)
    answer.current = null
    if (!ok) close()
  }
  return (
    <>
      <Dialog.Title className={s.title}>{t('rename')}</Dialog.Title>
      {files === null ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && to.trim() && to.trim() !== req.from) submit()
          }}
        >
          <input
            className={s.input}
            aria-label={t('renamePath')}
            value={to}
            autoFocus
            disabled={busy}
            onChange={(e) => setTo(e.target.value)}
            // 默认选中文件名（不含 .md），改名最常见
            onFocus={(e) => e.target.setSelectionRange(req.from.lastIndexOf('/') + 1, req.from.endsWith('.md') ? req.from.length - 3 : req.from.length)}
          />
        </form>
      ) : (
        <>
          <p className={s.muted}>{t('renameConfirm', { n: files.length })}</p>
          <ul className={s.list}>
            {files.map((f) => (
              <li key={f}>
                <span className={s.path}>{f}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className={s.actions}>
        <button onClick={() => (files ? decide(false) : close())}>{t('cancel')}</button>
        <button
          className={s.primary}
          disabled={busy || !to.trim() || to.trim() === req.from}
          onClick={() => (files ? decide(true) : submit())}
        >
          {t(files ? 'renameApply' : 'renameOk')}
        </button>
      </div>
    </>
  )
}
