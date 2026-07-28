// 复制文本到剪贴板。
//
// `navigator.clipboard` 只在安全上下文（https / localhost）下存在，以局域网 IP
// 明文 http 访问时整个对象都拿不到；此外即便存在，也可能因权限被拒而 reject。
// 两种情况都退回 `execCommand('copy')`——它已废弃，但在这种部署下是唯一可用的
// 路径，各浏览器仍然支持。

/** 复制成功返回 true；两条路径都失败返回 false（调用方负责提示）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 权限被拒等，继续走降级路径 */
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 移出视口且不可见，避免复制瞬间页面抖动。
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
