// 纯展示图标；按钮的名称与交互仍由调用方提供。
export function Icon({ name }: { name: 'files' | 'search' | 'git' }) {
  const paths = {
    files: <><path d="M5 3.5h10l3 3V20H5z" /><path d="M15 3.5V7h3M8 11h7M8 15h7" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
    git: <><circle cx="7" cy="5" r="2" /><circle cx="7" cy="19" r="2" /><circle cx="17" cy="6" r="2" /><path d="M7 7v10M17 8v2a5 5 0 0 1-5 5H7" /></>,
  }
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>
}
