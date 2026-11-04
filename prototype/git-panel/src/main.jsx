// PROTOTYPE（#11）：三种 git 面板变体，?variant=A|B|C 切换，?scenario= 切换 git 状态。随时可删。
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SCENARIOS, useGitModel } from './model.js'
import * as A from './VariantA.jsx'
import * as B from './VariantB.jsx'
import * as C from './VariantC.jsx'
import { Toast } from './shared.jsx'
import './style.css'

const VARIANTS = { A: [A.VariantA, A.name], B: [B.VariantB, B.name], C: [C.VariantC, C.name] }
const KEYS = Object.keys(VARIANTS)

function useParam(key, fallback) {
  const [v, setV] = useState(() => new URLSearchParams(location.search).get(key) ?? fallback)
  const set = (nv) => {
    const sp = new URLSearchParams(location.search)
    sp.set(key, nv)
    history.replaceState(null, '', `?${sp}`)
    setV(nv)
  }
  return [v, set]
}

function App() {
  const [variant, setVariant] = useParam('variant', 'A')
  const [scenario, setScenario] = useParam('scenario', 'normal')
  const [showState, setShowState] = useState(false)
  const [model, actions] = useGitModel(scenario)
  const [Variant, label] = VARIANTS[variant] ?? VARIANTS.A
  const cycle = (d) => setVariant(KEYS[(KEYS.indexOf(variant) + d + KEYS.length) % KEYS.length])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowLeft') cycle(-1)
      if (e.key === 'ArrowRight') cycle(1)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  return (
    <>
      {/* key 让切换变体时重置变体内部的 UI 状态 */}
      <Variant key={variant} model={model} actions={actions} />
      <Toast model={model} actions={actions} />
      <div className="proto-bar">
        <button onClick={() => cycle(-1)}>←</button>
        <span>
          {variant}（{label}）
        </span>
        <button onClick={() => cycle(1)}>→</button>
        <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
          {Object.entries(SCENARIOS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button onClick={() => setShowState(!showState)}>状态</button>
      </div>
      {showState && <pre className="proto-state">{JSON.stringify(model, null, 1)}</pre>}
    </>
  )
}

createRoot(document.getElementById('root')).render(<App />)
