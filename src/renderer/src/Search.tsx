// 侧栏搜索视图（S7）：输入即搜，结果按文件分组、虚拟化，点击命中打开文件并定位
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchHit, SearchMatch } from '../../shared/api'
import { reveal } from './editor'
import s from './Search.module.css'
import { useEditor, useUi, useVault } from './store'
import { baseName } from './tree'

const ROW = 22

type Row = { path: string; match?: SearchMatch; count: number }

export function Search() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [res, setRes] = useState<{ q: string; hits: SearchHit[] }>({ q: '', hits: [] })
  const [stamp, setStamp] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const root = useVault((st) => st.vault!.root)

  // 当前库的索引变化后重新查一次，结果不会停在旧内容上
  useEffect(() => window.synote.onIndexChanged((e) => e.root === useVault.getState().vault?.root && setStamp((n) => n + 1)), [])
  useEffect(() => {
    const q = query.trim()
    if (!q) return setRes({ q, hits: [] })
    let stale = false // 只保留最后一次输入的结果
    window.synote
      .search(root, q)
      .then((hits) => !stale && setRes({ q, hits }))
      .catch((e) => !stale && useUi.getState().setError(String(e)))
    return () => {
      stale = true
    }
  }, [query, stamp, root])

  const rows = useMemo(
    () => res.hits.flatMap((h): Row[] => [{ path: h.path, count: h.matches.length }, ...h.matches.map((match) => ({ path: h.path, match, count: 0 }))]),
    [res],
  )
  const total = rows.length - res.hits.length
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 20 })
  const len = res.q.length

  return (
    <div className={s.wrap}>
      <input
        id="search-input"
        className={s.input}
        value={query}
        placeholder={t('searchPlaceholder')}
        aria-label={t('search')}
        onChange={(e) => setQuery(e.target.value)}
      />
      {res.q && <div className={s.summary}>{res.hits.length ? t('searchCount', { files: res.hits.length, matches: total }) : t('noMatches')}</div>}
      <div ref={scrollRef} className={s.scroll}>
        <div role="list" aria-label={t('search')} style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vr) => {
            const r = rows[vr.index]
            const m = r.match
            return (
              <button
                key={vr.key}
                role="listitem"
                title={r.path}
                className={`${s.row} ${m ? s.match : s.file}`}
                style={{ transform: `translateY(${vr.start}px)` }}
                onClick={() => (m ? reveal(r.path, m.line, m.col, len) : useEditor.getState().open(r.path))}
              >
                {m ? (
                  <span className={s.text}>
                    {m.text.slice(0, m.start)}
                    <mark>{m.text.slice(m.start, m.start + len)}</mark>
                    {m.text.slice(m.start + len)}
                  </span>
                ) : (
                  <>
                    <span className={s.text}>{baseName(r.path)}</span>
                    <span className={s.dir}>{r.path.slice(0, -baseName(r.path).length - 1)}</span>
                    <span className={s.count}>{r.count}</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
