// 信令 WebSocket 客户端。
//
// 职责边界（安全约束）：文本帧只承载 SDP/ICE 与 TURN 凭证；二进制帧是
// WS 中继（fallback）载荷，已由 relay-transport.ts 端到端加密，服务器与
// 本模块都不解析其内容，只按帧头的 peerId 路由。

import { Emitter } from './emitter'
import type {
  BuiltinIce,
  ClientMsg,
  IceServer,
  PeerInfo,
  ServerMsg,
  SignalData,
} from './protocol'

export type SignalingState = 'idle' | 'connecting' | 'open' | 'closed'

/** turn-creds 响应负载。 */
export interface TurnCredsPayload {
  iceServers: IceServer[]
  ttl: number
  builtin?: BuiltinIce | null
}

type SignalingEvents = {
  state: SignalingState
  joined: { peerId: string; peers: PeerInfo[] }
  'peer-join': PeerInfo
  'peer-left': string
  signal: { from: string; data: SignalData }
  /** WS 中继二进制帧（帧头 peerId 已被服务器改写为来源）。 */
  relay: ArrayBuffer
  error: { code: string; msg: string }
}

const MAX_BACKOFF_MS = 15_000

export class Signaling extends Emitter<SignalingEvents> {
  private ws: WebSocket | null = null
  private url: string
  private _state: SignalingState = 'idle'
  private manualClose = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private turnWaiters: Array<(v: TurnCredsPayload) => void> = []

  constructor(url: string) {
    super()
    this.url = url
  }

  get state(): SignalingState {
    return this._state
  }

  private setState(s: SignalingState) {
    if (this._state === s) return
    this._state = s
    this.emit('state', s)
  }

  connect(): void {
    if (this.ws && (this._state === 'open' || this._state === 'connecting')) return
    this.manualClose = false
    this.open()
  }

  private open(): void {
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.emit('error', { code: 'ws-open-failed', msg: String(err) })
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.reconnectAttempts = 0
      this.setState('open')
    }

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.emit('relay', ev.data)
        return
      }
      let msg: ServerMsg
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg
      } catch {
        return
      }
      this.dispatch(msg)
    }

    ws.onerror = () => {
      // 详细原因在 onclose 中处理；此处仅记录。
    }

    ws.onclose = () => {
      this.ws = null
      this.setState('closed')
      if (!this.manualClose) this.scheduleReconnect()
    }
  }

  private dispatch(msg: ServerMsg): void {
    switch (msg.t) {
      case 'joined':
        this.emit('joined', { peerId: msg.peerId, peers: msg.peers })
        break
      case 'peer-join':
        this.emit('peer-join', msg.peer)
        break
      case 'peer-left':
        this.emit('peer-left', msg.peerId)
        break
      case 'signal':
        this.emit('signal', { from: msg.from, data: msg.data })
        break
      case 'turn-creds': {
        const payload: TurnCredsPayload = {
          iceServers: msg.iceServers,
          ttl: msg.ttl,
          builtin: msg.builtin,
        }
        const waiters = this.turnWaiters
        this.turnWaiters = []
        for (const resolve of waiters) resolve(payload)
        break
      }
      case 'error':
        this.emit('error', { code: msg.code, msg: msg.msg })
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.manualClose) this.open()
    }, delay)
  }

  send(msg: ClientMsg): void {
    if (this.ws && this._state === 'open') {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** 发一帧 WS 中继数据（调用方已封好帧头并加密）。 */
  sendRelay(frame: ArrayBuffer): void {
    if (this.ws && this._state === 'open') {
      this.ws.send(frame)
    }
  }

  /**
   * 底层 WebSocket 的发送积压字节数。
   *
   * 中继路径没有 RTCDataChannel 的 bufferedAmount 可用，文件传输的背压
   * 就靠这个值：服务器投递不动时会停止读取，TCP 窗口收紧，积压在此显现。
   */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  /** 领取 TURN/STUN 凭证；返回在收到服务端 turn-creds 时兑现的 Promise。 */
  requestTurnCreds(): Promise<TurnCredsPayload> {
    return new Promise((resolve) => {
      this.turnWaiters.push(resolve)
      this.send({ t: 'turn-creds' })
    })
  }

  /** 在连接就绪后兑现。 */
  ready(): Promise<void> {
    if (this._state === 'open') return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.on('state', (s) => {
        if (s === 'open') {
          off()
          resolve()
        }
      })
    })
  }

  close(): void {
    this.manualClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.setState('closed')
  }
}
