// 主题切换：两套主题写在 <html data-theme> 上，颜色全部走 CSS 变量
// （见 style.css）。选择持久化到 localStorage；未选过则跟随系统偏好。
// index.html 里有一段同样逻辑的早期脚本，避免首帧闪白/闪黑。

export type Theme = 'daylight' | 'midnight'

export const THEMES: { id: Theme; label: string; icon: string }[] = [
  { id: 'daylight', label: '日间', icon: 'sun' },
  { id: 'midnight', label: '夜间', icon: 'moon' },
]

const LS_THEME = 'pphub.theme'

function isTheme(v: unknown): v is Theme {
  return v === 'daylight' || v === 'midnight'
}

/** 系统偏好（未做过选择时的默认值）。 */
function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'midnight' : 'daylight'
}

/** 读取已保存的主题；没有则回落到系统偏好。 */
export function initialTheme(): Theme {
  const saved = localStorage.getItem(LS_THEME)
  return isTheme(saved) ? saved : systemTheme()
}

/** 是否由用户显式选定（决定要不要继续跟随系统切换）。 */
export function hasExplicitTheme(): boolean {
  return isTheme(localStorage.getItem(LS_THEME))
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

export function persistTheme(theme: Theme): void {
  localStorage.setItem(LS_THEME, theme)
}

/** 订阅系统主题变化（仅在用户未显式选定时回调）。返回取消订阅函数。 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!mq) return () => {}
  const handler = (e: MediaQueryListEvent) => {
    if (!hasExplicitTheme()) onChange(e.matches ? 'midnight' : 'daylight')
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
