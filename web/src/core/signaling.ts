// 信令 WebSocket 客户端。
//
// 职责边界（安全约束）：只负责与信令服务器交换 SDP/ICE 与领取 TURN 凭证，
// 绝不承载任何业务数据（聊天、文件、媒体都走 P2P 数据/媒体通道）。

import { Emitter } from './emitter'
import type { ClientMsg, IceServer, PeerInfo, ServerMsg, SignalData } from './protocol'

export type SignalingState = 'idle' | 'connecting' | 'open' | 'closed'

type SignalingEvents = {
  state: SignalingState
  joined: { peerId: string; peers: PeerInfo[] }
  'peer-join': PeerInfo
  'peer-left': string
  signal: { from: string; data: SignalData }
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
  private turnWaiters: Array<(v: { iceServers: IceServer[]; ttl: number }) => void> = []

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

    ws.onopen = () => {
      this.reconnectAttempts = 0
      this.setState('open')
    }

    ws.onmessage = (ev) => {
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
        const payload = { iceServers: msg.iceServers, ttl: msg.ttl }
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

  /** 领取 TURN/STUN 凭证；返回在收到服务端 turn-creds 时兑现的 Promise。 */
  requestTurnCreds(): Promise<{ iceServers: IceServer[]; ttl: number }> {
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
