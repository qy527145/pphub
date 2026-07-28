// 运行环境能力探测：所有特性检测集中于此，供 UI 做优雅降级提示。
// 严格避免调用会触发权限弹窗的 API（如 getUserMedia），仅做存在性检查。

import { canDecodeScreen, canEncodeScreen } from './screencodec'

export interface Capabilities {
  /**
   * 是否安全上下文（https / localhost）。注意 RTCPeerConnection 本身**不**依赖它
   * （明文 http 下数据通道照常可用），受影响的是 crypto.subtle（SAS + WS 中继
   * 加密）、getDisplayMedia、剪贴板等。
   */
  secureContext: boolean
  /** RTCPeerConnection 是否可用。 */
  webrtc: boolean
  /** crypto.subtle 是否可用（SAS 指纹校验依赖它）。 */
  webCrypto: boolean
  /** 屏幕共享 getDisplayMedia 是否存在（移动端浏览器普遍缺失）。 */
  displayMedia: boolean
  /**
   * WebCodecs 视频编/解码是否可用。中继路径的屏幕共享靠它自行编码
   * （媒体轨走不了应用层中继），走 WebRTC 直连/TURN 时用不到。
   */
  screenEncode: boolean
  screenDecode: boolean
  /** 摄像头/麦克风 getUserMedia 是否存在。 */
  userMedia: boolean
  /** File System Access API（showSaveFilePicker，仅 Chromium）。 */
  fileSystemAccess: boolean
  /** OPFS（origin private file system），用于大文件暂存降级。 */
  opfs: boolean
}

export function detectCapabilities(): Capabilities {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext === true
  const md = navigator.mediaDevices as MediaDevices | undefined

  return {
    secureContext,
    webrtc: typeof RTCPeerConnection !== 'undefined',
    webCrypto: typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined',
    displayMedia: !!md && typeof md.getDisplayMedia === 'function',
    screenEncode: canEncodeScreen(),
    screenDecode: canDecodeScreen(),
    userMedia: !!md && typeof md.getUserMedia === 'function',
    fileSystemAccess: typeof (window as unknown as { showSaveFilePicker?: unknown })
      .showSaveFilePicker === 'function',
    opfs:
      typeof navigator.storage !== 'undefined' &&
      typeof navigator.storage.getDirectory === 'function',
  }
}
