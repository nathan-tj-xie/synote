// 反链面板（S8）：列出指向当前笔记的笔记和链接所在行，索引变化（index:changed，只认当前库）后重新查询
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Backlink } from '../../shared/api'
import s from './Backlinks.module.css'
import { reveal } from './editor'
import { useVault } from './store'
import { baseName } from './tree'

export function Backlinks({ path }: { path: string }) {
  const { t } = useTranslation()
  const root = useVault((st) => st.vault!.root)
  const [links, setLinks] = useState<Backlink[]>([])
  const [stamp, setStamp] = useState(0)

  useEffect(() => window.synote.onIndexChanged((e) => e.root === useVault.getState().vault?.root && setStamp((n) => n + 1)), [])
  useEffect(() => {
    let stale = false // 只保留当前笔记最后一次查询的结果
    window.synote.backlinks(root, path).then(
      (r) => !stale && setLinks(r),
      () => !stale && setLinks([]), // 索引还没起来
    )
    return () => {
      stale = true
    }
  }, [root, path, stamp])

  return (
    <section className={s.panel} aria-label={t('backlinks')}>
      <h2 className={s.title}>
        {t('backlinks')} <span className={s.count}>{links.length}</span>
      </h2>
      {links.length === 0 && <div className={s.empty}>{t('noBacklinks')}</div>}
      <ul className={s.list}>
        {links.map((b) => (
          <li key={b.path}>
            <button className={s.item} title={b.path} onClick={() => reveal(b.path, b.line, 0, 0)}>
              <span className={s.name}>{baseName(b.path).replace(/\.md$/, '')}</span>
              <span className={s.text}>{b.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
