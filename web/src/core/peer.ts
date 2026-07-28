// 单个对端连接：封装一个 RTCPeerConnection，实现「完美协商」、trickle ICE、
// ICE 重启，并在连接建立后派生 SAS 指纹供带外校对。
//
// 极性约定（由 mesh 层按 peerId 字典序分配，保证两端一致）：
//   - initiator = 本端负责创建 data channel 并发起 offer
//   - polite    = 发生 offer 冲突时本端让步（回滚并接受对端 offer）
// 通常令较小 id 为 initiator 且 impolite，较大 id 为 polite。
//
// 传输降级：优先级依次为「直连打洞 → 内置 TURN → WS 中继」。前两级都在 ICE
// 层完成，对上层透明；最后一级（RelayTransport）走信令 WebSocket，只依赖服务器
// 已有的 HTTP/WS 端口，代价是数据要经服务器转发（故自带端到端加密）。
// 一旦降级到中继就不再切回：切换点上若有文件正在传，会直接损坏该次传输，
// 而降级本身已发生在 WebRTC 明确失败之后，收益不足以抵消这个风险。

import { Emitter } from './emitter'
import type { ChannelLike } from './channels'
import type { ControlMessage } from './messages'
import type { SignalData } from './protocol'
import { RelayTransport } from './relay-transport'
import { type Sas, computeSas, extractFingerprint } from './security'
import { IceDebugger } from '../utils/ice-debug'

/** 本端实际使用的传输通路。 */
export type PeerTransport = 'webrtc' | 'relay'

/** WebRTC 迟迟建不起来时，切到 WS 中继的等待时长。 */
const RELAY_FALLBACK_MS = 12_000

export interface PeerConfig {
  /** 对端 peerId。 */
  remoteId: string
  /** 完美协商极性：冲突时是否让步。 */
  polite: boolean
  /** 是否由本端创建 control 通道并发起首个 offer。 */
  initiator: boolean
  /** ICE 服务器（STUN/TURN），首项为 pphub 内置中继。 */
  iceServers: RTCIceServer[]
  /** 把一条信令交给信令层发往对端。 */
  sendSignal: (data: SignalData) => void
  /** 把一帧 WS 中继数据交给信令层（fallback 路径）。 */
  sendRelay: (frame: ArrayBuffer) => void
  /** 信令 WebSocket 当前积压字节数，供中继路径做背压。 */
  relayBuffered: () => number
}

type PeerEvents = {
  connectionstate: RTCPeerConnectionState
  channelopen: void
  control: ControlMessage
  /** 对端为一次文件传输新开的数据通道（label = file-<id>）。 */
  filechannel: { id: string; channel: ChannelLike }
  /** swarm 通道上到达的分块帧（4 字节 reqId + 负载）。 */
  chunk: ArrayBuffer
  /** 中继路径上到达的屏幕编码包（见 screencodec.ts）。 */
  screenpacket: ArrayBuffer
  /** 对端加入了媒体轨（屏幕共享等），streams[0] 为其所属流。 */
  track: { track: MediaStreamTrack; streams: readonly MediaStream[] }
  sas: Sas
  /** 实际使用的传输通路发生变化（降级到 WS 中继时触发）。 */
  transport: PeerTransport
  /** 需要降级到中继，但环境不允许（非安全上下文无 WebCrypto）。 */
  relayblocked: string
  close: void
}

export class Peer extends Emitter<PeerEvents> {
  readonly remoteId: string
  private pc: RTCPeerConnection
  private control: RTCDataChannel | null = null
  /** 分块拉取专用二进制通道（与 control 分离，避免大块阻塞控制消息）。 */
  private swarm: RTCDataChannel | null = null
  private readonly polite: boolean
  private readonly sendSignal: (data: SignalData) => void
  private iceDebugger: IceDebugger | null = null

  // WS 中继 fallback。
  private readonly cfg: PeerConfig
  private relay: RelayTransport | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  private relayBlocked = false
  private closed = false

  // 完美协商状态机标志。
  private makingOffer = false
  private ignoreOffer = false
  private settingRemoteAnswerPending = false
  private sasDone = false

  constructor(cfg: PeerConfig) {
    super()
    this.cfg = cfg
    this.remoteId = cfg.remoteId
    this.polite = cfg.polite
    this.sendSignal = cfg.sendSignal

    this.pc = new RTCPeerConnection({
      iceServers: cfg.iceServers,
      // 提前收集候选（含内置 TURN 的 relay 候选），加速连接建立。
      iceCandidatePoolSize: 4,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })

    // 启用 ICE 调试（开发/诊断模式）
    if (localStorage.getItem('pphub:debug:ice') === 'true') {
      this.iceDebugger = new IceDebugger(this.pc, cfg.remoteId)
    }

    this.wire()
    if (cfg.initiator) {
      this.setupControl(this.pc.createDataChannel('control', { ordered: true }))
      this.setupSwarm(this.pc.createDataChannel('swarm', { ordered: true }))
    }

    // 兜底：WebRTC 在期限内没连上就降级。'failed' 会更早触发同一路径。
    this.fallbackTimer = setTimeout(
      () => this.enableRelay('WebRTC 在超时前未建立连接'),
      RELAY_FALLBACK_MS,
    )

    // 诊断/测试开关：跳过 WebRTC，直接走中继。
    // localStorage.setItem('pphub:force:relay', 'true')
    if (localStorage.getItem('pphub:force:relay') === 'true') {
      this.enableRelay('本地强制中继开关已开启')
    }
  }

  get connectionState(): RTCPeerConnectionState {
    if (this.relay?.ready) return 'connected'
    return this.pc.connectionState
  }

  /** 当前走的是哪条通路（UI 用于提示「经服务器中继」）。 */
  get transport(): PeerTransport {
    return this.relay ? 'relay' : 'webrtc'
  }

  private wire(): void {
    const pc = this.pc

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        if (pc.localDescription) this.sendSignal({ description: pc.localDescription })
      } catch (err) {
        console.error('[peer] negotiationneeded', err)
      } finally {
        this.makingOffer = false
      }
    }

    pc.onicecandidate = ({ candidate }) => {
      this.sendSignal({ candidate: candidate ? candidate.toJSON() : null })
    }

    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'control') {
        this.setupControl(ev.channel)
      } else if (ev.channel.label === 'swarm') {
        this.setupSwarm(ev.channel)
      } else if (ev.channel.label.startsWith('file-')) {
        this.emit('filechannel', { id: ev.channel.label.slice(5), channel: ev.channel })
      }
    }

    pc.ontrack = (ev) => {
      this.emit('track', { track: ev.track, streams: ev.streams })
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        this.clearFallbackTimer()
        void this.maybeComputeSas()
      } else if (state === 'failed') {
        this.enableRelay('WebRTC 连接失败')
      }
      // 已降级到中继后不再上报 WebRTC 侧状态，否则 UI 会把可用连接显示成断开。
      if (!this.relay) this.emit('connectionstate', state)
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try {
          pc.restartIce()
        } catch (err) {
          console.error('[peer] restartIce', err)
        }
      }
    }
  }

  /** 处理来自对端、经信令中转的一条信令（description 或 candidate）。 */
  async handleSignal(data: SignalData): Promise<void> {
    const pc = this.pc

    // 对端已降级到 WS 中继：本端跟随，并用其公钥完成密钥协商。
    if (data.relayKey) {
      this.enableRelay('对端已降级到 WS 中继')
      void this.relay?.acceptRemoteKey(data.relayKey)
      return
    }

    try {
      if (data.description) {
        const description = data.description
        const readyForOffer =
          !this.makingOffer &&
          (pc.signalingState === 'stable' || this.settingRemoteAnswerPending)
        const offerCollision = description.type === 'offer' && !readyForOffer

        this.ignoreOffer = !this.polite && offerCollision
        if (this.ignoreOffer) return

        this.settingRemoteAnswerPending = description.type === 'answer'
        await pc.setRemoteDescription(description)
        this.settingRemoteAnswerPending = false

        if (description.type === 'offer') {
          await pc.setLocalDescription()
          if (pc.localDescription) this.sendSignal({ description: pc.localDescription })
        }
        void this.maybeComputeSas()
      } else {
        try {
          await pc.addIceCandidate(data.candidate ?? undefined)
          // 记录远程候选用于调试
          if (this.iceDebugger && data.candidate) {
            this.iceDebugger.addRemoteCandidate(data.candidate as RTCIceCandidate)
          }
        } catch (err) {
          if (!this.ignoreOffer) throw err
        }
      }
    } catch (err) {
      console.error('[peer] handleSignal', err)
    }
  }

  private setupControl(channel: RTCDataChannel): void {
    this.control = channel
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => this.emit('channelopen', undefined)
    channel.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        this.emit('control', JSON.parse(ev.data) as ControlMessage)
      } catch {
        /* 丢弃非法帧 */
      }
    }
  }

  private setupSwarm(channel: RTCDataChannel): void {
    this.swarm = channel
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this.emit('chunk', ev.data)
    }
  }

  /** 通过 control 通道发送一条控制消息；未就绪则返回 false。 */
  sendControl(msg: ControlMessage): boolean {
    if (this.relay) return this.relay.sendControl(msg)
    if (this.control?.readyState !== 'open') return false
    this.control.send(JSON.stringify(msg))
    return true
  }

  /** 在 swarm 通道上发一帧分块数据；未就绪返回 false。 */
  sendChunk(frame: ArrayBuffer): boolean {
    if (this.relay) return this.relay.sendChunk(frame)
    if (this.swarm?.readyState !== 'open') return false
    this.swarm.send(frame)
    return true
  }

  /** swarm 通道当前积压字节数（供块方据此限流，避免打爆缓冲）。 */
  get swarmBuffered(): number {
    if (this.relay) return this.relay.bufferedAmount
    return this.swarm?.readyState === 'open' ? this.swarm.bufferedAmount : 0
  }

  /**
   * 经中继发一个屏幕编码包。仅中继路径有效——WebRTC 路径用原生媒体轨
   * （addTrack），画质与延迟都更好，没必要走自编码。
   */
  sendScreen(packet: ArrayBuffer): boolean {
    return this.relay?.sendScreen(packet) ?? false
  }

  /** 中继是否已就绪到可以承载屏幕流（密钥协商完成）。 */
  get relayReady(): boolean {
    return this.relay?.ready ?? false
  }

  get swarmReady(): boolean {
    if (this.relay) return this.relay.ready
    return this.swarm?.readyState === 'open'
  }

  /** 为一次文件传输创建独立通道（有序可靠）；WebRTC 路径触发透明重协商。 */
  createFileChannel(id: string): ChannelLike {
    if (this.relay) return this.relay.createFileChannel(id)
    return this.pc.createDataChannel(`file-${id}`, { ordered: true })
  }

  // —— WS 中继 fallback ——

  /**
   * 降级到 WS 中继。幂等：超时、连接失败、对端先行降级三条路径都会调用。
   *
   * WebRTC 的**媒体轨**仍然过不去（SRTP 由浏览器内部收发，JS 拿不到编码帧），
   * 但屏幕共享另有一条路：mesh 会改用 WebCodecs 自行编码，编码字节经本通道的
   * KIND_SCREEN 转发（见 screencodec.ts）。代价是只有视频没有音频。
   */
  private enableRelay(reason: string): void {
    if (this.relay || this.closed) return
    this.clearFallbackTimer()

    // 中继路径的载荷由本模块自行加密（服务器会看到字节流，DTLS 不再覆盖）。
    // 非安全上下文里 crypto.subtle 不存在，无法加密——此时宁可明确失败，
    // 也不退化成明文中继。
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      if (!this.relayBlocked) {
        this.relayBlocked = true
        this.emit(
          'relayblocked',
          '无法 P2P 直连，需经服务器中继；但当前以 http 访问（非 localhost），'
            + '浏览器禁用了 WebCrypto，中继无法端到端加密。请改用 https 访问，'
            + '或让服务端以 --stun-turn 启动并放行 UDP/TCP 3478，使 WebRTC 直接打通。',
        )
      }
      return
    }

    console.warn(`[peer] ${this.remoteId} 降级到 WS 中继：${reason}`)

    const relay = new RelayTransport({
      remoteId: this.remoteId,
      sendFrame: (frame) => this.cfg.sendRelay(frame),
      sendKey: (jwk) => this.sendSignal({ relayKey: jwk }),
      bufferedAmount: () => this.cfg.relayBuffered(),
    })
    relay.onControl = (msg) => this.emit('control', msg as ControlMessage)
    relay.onChunk = (data) => this.emit('chunk', data)
    relay.onScreen = (packet) => this.emit('screenpacket', packet)
    relay.onFileChannel = (ev) => this.emit('filechannel', ev)
    relay.onSas = (sas) => {
      this.sasDone = true
      this.emit('sas', sas)
    }
    relay.onReady = () => {
      this.emit('connectionstate', 'connected')
      this.emit('channelopen', undefined)
    }
    this.relay = relay
    this.emit('transport', 'relay')
  }

  /** 投递一帧来自服务器的中继数据（由 mesh 按来源 peerId 路由到此）。 */
  handleRelayFrame(frame: ArrayBuffer): void {
    // 对端可能先于本端降级：首帧到达即视为降级信号。
    this.enableRelay('收到对端的中继数据')
    void this.relay?.handleFrame(frame)
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer === null) return
    clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
  }

  /** 向此连接加入一条媒体轨（触发透明重协商），返回 sender 供移除。 */
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    return this.pc.addTrack(track, stream)
  }

  /** 移除先前加入的媒体轨（触发透明重协商）。 */
  removeTrack(sender: RTCRtpSender): void {
    try {
      this.pc.removeTrack(sender)
    } catch {
      /* 连接可能已关闭 */
    }
  }

  /** 本端与对端 DTLS 指纹都就绪后，派生并广播 SAS（仅一次）。 */
  private async maybeComputeSas(): Promise<void> {
    if (this.sasDone) return
    const localSdp = this.pc.currentLocalDescription?.sdp ?? this.pc.localDescription?.sdp
    const remoteSdp = this.pc.currentRemoteDescription?.sdp ?? this.pc.remoteDescription?.sdp
    const local = extractFingerprint(localSdp)
    const remote = extractFingerprint(remoteSdp)
    if (!local || !remote) return
    if (typeof crypto === 'undefined' || !crypto.subtle) return

    this.sasDone = true
    try {
      this.emit('sas', await computeSas(local, remote))
    } catch (err) {
      this.sasDone = false
      console.error('[peer] computeSas', err)
    }
  }

  close(): void {
    this.closed = true
    this.clearFallbackTimer()
    this.relay?.close()
    try {
      this.control?.close()
      this.swarm?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc.close()
    } catch {
      /* ignore */
    }
    this.emit('close', undefined)
    this.clear()
  }
}
