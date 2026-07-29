// 后台消息提醒：页面不可见时用系统通知 + 标题闪烁提示，回到页面即恢复。
//
// Notification 权限必须在用户手势里申请（Safari 强制），因此由「连接」等
// 用户主动操作时调用 requestNotifyPermission()；未授权时仍有标题闪烁兜底。

let baseTitle: string | null = null
let flashTimer: ReturnType<typeof setInterval> | null = null

/** 在用户手势中申请通知权限（幂等；不支持或已决定过则静默返回）。 */
export function requestNotifyPermission(): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    void Notification.requestPermission()
  }
}

/**
 * 页面不可见时提醒一条消息：能发系统通知就发（点击聚焦回页面），
 * 同时开始标题闪烁。页面可见时什么都不做。
 */
export function notifyBackground(title: string, body: string): void {
  if (typeof document === 'undefined' || !document.hidden) return
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: 'pphub-msg' })
      n.onclick = () => {
        window.focus()
        n.close()
      }
    } catch {
      // 部分平台（如 Android Chrome）要求经 ServiceWorker 发通知，失败就只闪标题。
    }
  }
  startTitleFlash()
}

function startTitleFlash(): void {
  if (flashTimer !== null) return
  baseTitle = document.title
  let on = false
  flashTimer = setInterval(() => {
    on = !on
    document.title = on ? '● 新消息 - pphub' : (baseTitle ?? 'pphub')
  }, 1000)
  document.addEventListener('visibilitychange', stopTitleFlash)
  window.addEventListener('focus', stopTitleFlash)
}

function stopTitleFlash(): void {
  if (document.hidden) return
  if (flashTimer !== null) {
    clearInterval(flashTimer)
    flashTimer = null
  }
  if (baseTitle !== null) {
    document.title = baseTitle
    baseTitle = null
  }
  document.removeEventListener('visibilitychange', stopTitleFlash)
  window.removeEventListener('focus', stopTitleFlash)
}
