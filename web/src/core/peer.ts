// 单个对端连接：封装一个 RTCPeerConnection，实现「完美协商」、trickle ICE、
// ICE 重启，并在连接建立后派生 SAS 指纹供带外校对。
//
// 极性约定（由 mesh 层按 peerId 字典序分配，保证两端一致）：
//   - initiator = 本端负责创建 data channel 并发起 offer
//   - polite    = 发生 offer 冲突时本端让步（回滚并接受对端 offer）
// 通常令较小 id 为 initiator 且 impolite，较大 id 为 polite。

import { Emitter } from './emitter'
import type { ControlMessage } from './messages'
import type { SignalData } from './protocol'
import { type Sas, computeSas, extractFingerprint } from './security'
import { IceDebugger } from '../utils/ice-debug'

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
}

type PeerEvents = {
  connectionstate: RTCPeerConnectionState
  channelopen: void
  control: ControlMessage
  /** 对端为一次文件传输新开的数据通道（label = file-<id>）。 */
  filechannel: { id: string; channel: RTCDataChannel }
  /** swarm 通道上到达的分块帧（4 字节 reqId + 负载）。 */
  chunk: ArrayBuffer
  /** 对端加入了媒体轨（屏幕共享等），streams[0] 为其所属流。 */
  track: { track: MediaStreamTrack; streams: readonly MediaStream[] }
  sas: Sas
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

  // 完美协商状态机标志。
  private makingOffer = false
  private ignoreOffer = false
  private settingRemoteAnswerPending = false
  private sasDone = false

  constructor(cfg: PeerConfig) {
    super()
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
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState
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
      this.emit('connectionstate', pc.connectionState)
      if (pc.connectionState === 'connected') void this.maybeComputeSas()
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
    if (this.control?.readyState !== 'open') return false
    this.control.send(JSON.stringify(msg))
    return true
  }

  /** 在 swarm 通道上发一帧分块数据；未就绪返回 false。 */
  sendChunk(frame: ArrayBuffer): boolean {
    if (this.swarm?.readyState !== 'open') return false
    this.swarm.send(frame)
    return true
  }

  /** swarm 通道当前积压字节数（供块方据此限流，避免打爆缓冲）。 */
  get swarmBuffered(): number {
    return this.swarm?.readyState === 'open' ? this.swarm.bufferedAmount : 0
  }

  get swarmReady(): boolean {
    return this.swarm?.readyState === 'open'
  }

  /** 为一次文件传输创建独立数据通道（有序可靠），触发透明重协商。 */
  createFileChannel(id: string): RTCDataChannel {
    return this.pc.createDataChannel(`file-${id}`, { ordered: true })
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
