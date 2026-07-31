// 房间会话（Mesh）：编排信令与多个 Peer，向上层（store）发出去 UI 化的事件。
//
// 极性分配：对每一对 (self, remote)，令字典序较小者为 initiator 且 impolite，
// 较大者为 polite。两端据此得到一致且互补的角色，天然规避 offer 冲突。

import { Emitter } from './emitter'
import {
  type ReceiveHandle,
  type SendHandle,
  receiveFile,
  sendFile,
} from './filetransfer'
import type {
  ControlMessage,
  FileOffer,
  Profile,
  SendScope,
  SharedFileMeta,
} from './messages'
import { Peer, type PeerTransport } from './peer'
import type { ChannelLike } from './channels'
import type { BuiltinIce, IceServer } from './protocol'
import {
  ScreenDecoder,
  ScreenEncoder,
  canDecodeScreen,
  canEncodeScreen,
} from './screencodec'
import type { Sas } from './security'
import type { Signaling, SignalingState } from './signaling'
import {
  Bitfield,
  CHUNK_SIZE,
  Download,
  type DownloadCallbacks,
  FileStore,
  chunkCount,
  packChunk,
  unpackChunk,
} from './swarm'
import { TopologyManager, type TopologyMode, type NetworkGroup } from './topology'

type MeshEvents = {
  self: string
  'peer-added': { peerId: string; nick?: string }
  'peer-removed': string
  'peer-state': { peerId: string; state: RTCPeerConnectionState }
  /** 该对端实际走的通路；'relay' 表示 WebRTC 打不通、已降级为服务器中继。 */
  'peer-transport': { peerId: string; transport: PeerTransport }
  'peer-sas': { peerId: string; sas: Sas }
  /** 对端的名片到达/更新。 */
  'peer-profile': { peerId: string; profile: Profile }
  /** 对端上报了它的邻接表（网络视图边数据，附实测 RTT）。 */
  'peer-links': { peerId: string; links: { peerId: string; state: string; rtt?: number }[] }
  /** 某对端的 control 通道就绪（可向其补发状态同步，如白板全量）。 */
  'peer-channel-open': string
  /** 拓扑模式变化 */
  'topology-mode': TopologyMode
  /** 网络分组更新 */
  'topology-groups': NetworkGroup[]
  chat: { from: string; msgId: string; text: string; ts: number; scope: 'all' | 'dm' }
  /** 对端对某条消息的表情回应。 */
  react: { from: string; msgId: string; emoji: string; op: 'add' | 'remove'; scope: 'all' | 'dm' }
  /** 对端发来的语音消息。 */
  'voice-note': {
    from: string
    msgId: string
    scope: 'all' | 'dm'
    data: string
    mime: string
    dur: number
    ts: number
  }
  /** 与该对端的实测往返延迟（ms）。 */
  'peer-rtt': { peerId: string; rtt: number }
  /** 对端开麦 / 关麦（实时对讲）。 */
  'voice-start': string
  'voice-stop': string
  /** 对端麦克风媒体流已到达，可以播放。 */
  'voice-stream': { peerId: string; stream: MediaStream }
  /** 游戏消息（你画我猜 / 五子棋），由上层维护对局状态。 */
  game: { from: string; msg: GameMessage }
  /** 对端要发文件给我（接收侧新传输开始，强制发送）。 */
  'file-offer': { peerId: string; offer: FileOffer }
  /** 双向传输进度（bytes 为已完成字节数）。 */
  'file-progress': { id: string; bytes: number }
  /** 接收完成，blob 可供保存。 */
  'file-done': { id: string; blob: Blob }
  /** 传输失败或被取消（双向）。 */
  'file-error': { id: string; reason: string; canceled: boolean }
  /** 对端共享了一个文件（懒发送登记，可下载）。 */
  'share-added': { peerId: string; file: SharedFileMeta }
  /** 共享被撤销或所有持有者离线。 */
  'share-removed': { fileId: string }
  /** 多源下载的源数量变化。 */
  'share-sources': { fileId: string; count: number }
  /** 本端持有的共享文件正被对端拉取（UI 显示上传活动）。 */
  'share-serving': { fileId: string; peerId: string }
  /** 对端宣布开始屏幕共享（媒体轨稍后经重协商到达）。 */
  'screen-start': string
  /** 对端屏幕共享的媒体流已到达，可以播放。 */
  'screen-stream': { peerId: string; stream: MediaStream }
  /** 对端停止屏幕共享。 */
  'screen-stop': string
  /** 绘制与远程指针消息（白板/屏幕批注），由上层维护状态。 */
  draw: { from: string; msg: DrawMessage }
  error: { code: string; msg: string }
  'signaling-state': SignalingState
}

/** ControlMessage 中与绘制/指针相关的子集。 */
export type DrawMessage = Extract<
  ControlMessage,
  { kind: `draw-${string}` } | { kind: `ptr-${string}` }
>

/** ControlMessage 中的游戏子集（你画我猜 / 五子棋 / 游戏桌 / 匹配 / 邀请）。 */
export type GameMessage = Extract<
  ControlMessage,
  | { kind: `guess-${string}` }
  | { kind: `gomoku-${string}` }
  | { kind: `table-${string}` }
  | { kind: `game-${string}` }
  | { kind: `match-${string}` }
  | { kind: `invite-${string}` }
  | { kind: 'mouse-pos' }
>

/** 供 store 查询的共享条目视图。 */
export interface ShareEntry {
  meta: SharedFileMeta
  /** 本端是否持有完整文件（源之一）。 */
  local: boolean
  /** 已知持有全部或部分分块的节点。 */
  holders: Set<string>
}

/** 一次屏幕共享的可达性预检结果。 */
export interface ScreenTargets {
  /** 能收到画面的对端。 */
  ok: string[]
  /** 收不到的对端及原因（用于在开采集器之前就告诉用户）。 */
  blocked: { peerId: string; reason: string }[]
}

/** join 的服务端应答。 */
export interface JoinAck {
  /** 房间内已有成员数（不含自己）。 */
  peerCount: number
  /** 服务端按当前在线规模建议的短码长度。 */
  codeLen: number
}

/** join 被服务端拒绝（房满、短码被占等），`code` 为服务端错误码。 */
export class JoinRejected extends Error {
  constructor(
    readonly code: string,
    msg: string,
  ) {
    super(msg)
    this.name = 'JoinRejected'
  }
}

/** 会终结 join 流程的服务端错误码；其余错误与 join 无关，继续等待。 */
const JOIN_ERRORS = new Set(['code-taken', 'room-full', 'duplicate-peer', 'already-joined'])

export class Mesh extends Emitter<MeshEvents> {
  myId = ''
  room = ''
  profile: Profile = { nick: '', avatar: { kind: 'emoji', value: '🦊', color: '#6c4bf4' }, rev: 1 }

  private readonly signaling: Signaling
  private readonly peers = new Map<string, Peer>()
  private readonly nicks = new Map<string, string | undefined>()
  /**
   * 对端通告的「能否解码中继屏幕画面」。名片到达前无记录，此时按能解码处理
   * （见 Profile.screenDecode）。
   */
  private readonly remoteScreenDecode = new Map<string, boolean>()
  private iceServers: RTCIceServer[] = []

  // 拓扑管理器（网络优化）
  private readonly topology: TopologyManager

  // 强制发送（推）登记表（按传输 id 索引；id 全局随机，跨 peer 不冲突）。
  private readonly pendingOffers = new Map<string, { peerId: string; offer: FileOffer }>()
  private readonly pendingChannels = new Map<string, ChannelLike>()
  private readonly activeSends = new Map<string, { peerId: string; handle: SendHandle }>()
  private readonly activeRecvs = new Map<string, { peerId: string; handle: ReceiveHandle }>()

  // 懒发送 / 多源下载（拉）。
  /** fileId → 共享条目（含本地 store：共享方持有 File，下载完成方持有分块）。 */
  private readonly shares = new Map<string, ShareEntry>()
  private readonly stores = new Map<string, FileStore>()
  private readonly downloads = new Map<string, Download>()
  /** 供块限流：swarm 通道积压超过阈值时暂缓读盘。 */
  private static readonly SERVE_BUFFER_HIGH = 4 * 1024 * 1024

  // 屏幕共享：本端共享流 + 每个对端上挂载的 senders（停止时逐一移除）。
  private screenStream: MediaStream | null = null
  private screenScope: { scope: SendScope; to?: string } = { scope: 'all' }
  private readonly screenSenders = new Map<string, RTCRtpSender[]>()

  // 实时对讲：本端麦克风流 + 各对端 senders；remoteVoiceStreams 记录对端通告的
  // 语音流 id，用于把到达的媒体流与屏幕共享区分开。
  private voiceStream: MediaStream | null = null
  private readonly voiceSenders = new Map<string, RTCRtpSender[]>()
  private readonly remoteVoiceStreams = new Map<string, string>()
  /** 语音消息分片重组缓冲：`${from}|${msgId}` → 已到分片。 */
  private readonly voiceParts = new Map<string, string[]>()

  // RTT 探测：每对端周期 ping，pong 回来算往返。
  private pingSeq = 1
  private readonly pendingPings = new Map<number, { peerId: string; sentAt: number }>()
  private readonly rtts = new Map<string, number>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  // 中继对端走 WebCodecs 自编码：一个编码器，画面分发给所有中继观众。
  private screenEncoder: ScreenEncoder | null = null
  private encoderStarting: Promise<boolean> | null = null
  private readonly codecViewers = new Set<string>()
  private readonly screenDecoders = new Map<string, ScreenDecoder>()
  /** 已就「本机无法解码」报过警的对端，避免每个包刷一条错误。 */
  private readonly decodeWarned = new Set<string>()

  constructor(signaling: Signaling, topologyMode: TopologyMode = 'hierarchical') {
    super()
    this.signaling = signaling
    this.topology = new TopologyManager()
    this.wireSignaling()
    this.wireTopology()
    // RTT 探测 + 邻接表（含 RTT）周期广播；leave 时清除。
    this.pingTimer = setInterval(() => this.pingAll(), 5000)

    // 从 localStorage 读取拓扑模式配置，默认使用分层模式
    const savedMode = localStorage.getItem('pphub:topology:mode') as TopologyMode | null
    if (savedMode === 'hierarchical' || savedMode === 'full-mesh') {
      topologyMode = savedMode
    } else if (!savedMode) {
      // 首次使用，默认分层模式
      topologyMode = 'hierarchical'
      localStorage.setItem('pphub:topology:mode', 'hierarchical')
    }
    this.topology.setMode(topologyMode)
  }

  /** 向所有通道就绪的对端发一轮 ping；久未应答的记录顺带过期。 */
  private pingAll(): void {
    const now = performance.now()
    for (const [seq, p] of this.pendingPings) {
      if (now - p.sentAt > 30_000) this.pendingPings.delete(seq)
    }
    for (const [peerId, peer] of this.peers) {
      const seq = this.pingSeq++
      if (peer.sendControl({ kind: 'ping', seq })) {
        this.pendingPings.set(seq, { peerId, sentAt: performance.now() })
      }
    }
    // 周期性重播邻接表：让对端网络视图上「节点—节点」边的 RTT 保持新鲜。
    if (this.peers.size > 0 && now - this.lastLinksBroadcast > 15_000) {
      this.lastLinksBroadcast = now
      this.broadcastLinks()
    }

    // 如果我是组长，定期广播拓扑信息
    if (this.topology.isLeader()) {
      const announce = this.topology.generateAnnounce()
      if (announce) {
        this.broadcast(announce)
      }
    }
  }

  private lastLinksBroadcast = 0

  private wireSignaling(): void {
    this.signaling.on('joined', ({ peerId, peers }) => {
      this.myId = peerId
      this.emit('self', peerId)
      // 初始化拓扑管理器
      this.topology.initialize(peerId, this.topology.getMode())
      for (const p of peers) {
        this.nicks.set(p.peerId, p.nick ?? undefined)
        this.addPeer(p.peerId)
      }
    })

    this.signaling.on('peer-join', (p) => {
      this.nicks.set(p.peerId, p.nick ?? undefined)
      this.addPeer(p.peerId)
    })

    this.signaling.on('peer-left', (peerId) => this.removePeer(peerId))

    this.signaling.on('signal', ({ from, data }) => {
      // 懒创建：容忍信令早于房间事件到达。
      const peer = this.peers.get(from) ?? this.addPeer(from)
      void peer.handleSignal(data)
    })

    this.signaling.on('error', (e) => this.emit('error', e))
    this.signaling.on('state', (s) => this.emit('signaling-state', s))

    // WS 中继帧：帧头里的 peerId 已被服务器改写为来源，据此路由到对应 Peer。
    this.signaling.on('relay', (frame) => {
      const from = relayFrameSource(frame)
      if (!from) return
      const peer = this.peers.get(from) ?? this.addPeer(from)
      peer.handleRelayFrame(frame)
    })
  }

  /** 连接拓扑管理器的事件 */
  private wireTopology(): void {
    this.topology.on('mode-change', (mode) => {
      this.emit('topology-mode', mode)
      // 保存到 localStorage
      localStorage.setItem('pphub:topology:mode', mode)
    })

    this.topology.on('groups-update', (groups) => {
      this.emit('topology-groups', groups)
    })

    this.topology.on('leader-change', ({ groupId, newLeader }) => {
      console.log(`[mesh] Group ${groupId} leader changed to ${newLeader}`)
      // 如果新组长是本节点，需要建立与其他组长的连接
      if (newLeader === this.myId) {
        const leaders = this.topology.getLeaders()
        for (const leader of leaders) {
          if (leader !== this.myId && !this.peers.has(leader)) {
            this.addPeer(leader)
          }
        }
      }
    })

    this.topology.on('connect-peer', (peerId) => {
      console.log(`[mesh] Topology requires connection to ${peerId}`)
      if (!this.peers.has(peerId)) {
        this.addPeer(peerId)
      }
    })

    this.topology.on('disconnect-peer', (peerId) => {
      console.log(`[mesh] Topology allows disconnection from ${peerId}`)
      // 注意：不立即断开，避免频繁震荡
      // 可以在下次拓扑评估时再决定是否真正断开
    })
  }

  /**
   * 加入房间：连接 → 领取 ICE 凭证 → 发送 join → 等待服务端应答。
   * `listen` 表示以短码监听者身份声明房间所有权（撞码时服务端拒绝）。
   */
  async join(room: string, profile: Profile, listen = false): Promise<JoinAck> {
    this.room = room
    this.profile = profile
    this.myId = genId()

    this.signaling.connect()
    await this.signaling.ready()

    const { iceServers, builtin } = await this.signaling.requestTurnCreds()
    // 内置 STUN/TURN 排在最前：它与本页同主机，必然可达。
    this.iceServers = [...builtinIceServers(builtin), ...iceServers.map(toRtcIceServer)]

    const ack = this.waitJoined()
    this.signaling.send({ t: 'join', room, peerId: this.myId, nick: profile.nick, listen })

    // 延迟进行拓扑优化（如果是分层或树状模式）
    ack.then(() => {
      if (this.topology.getMode() !== 'full-mesh') {
        // 等待 10 秒让所有连接建立并收集 RTT 数据
        setTimeout(() => {
          console.log('[mesh] Starting topology optimization...')
          this.optimizeTopology()
        }, 10000)
      }
    })

    return ack
  }

  /** 等待 join 应答：joined 兑现；join 阶段的服务端拒绝则以 JoinRejected 驳回。 */
  private waitJoined(): Promise<JoinAck> {
    return new Promise((resolve, reject) => {
      const offJoined = this.signaling.on('joined', ({ peers, codeLen }) => {
        cleanup()
        resolve({ peerCount: peers.length, codeLen })
      })
      const offError = this.signaling.on('error', (e) => {
        if (!JOIN_ERRORS.has(e.code)) return
        cleanup()
        reject(new JoinRejected(e.code, e.msg))
      })
      const cleanup = () => {
        offJoined()
        offError()
      }
    })
  }

  /** 群聊：向所有对端广播。 */
  sendChat(text: string, msgId: string): void {
    this.broadcast({ kind: 'chat', msgId, text, ts: Date.now(), scope: 'all' })
  }

  /** 私聊：只发给指定对端。 */
  sendDm(peerId: string, text: string, msgId: string): boolean {
    return this.sendTo(peerId, { kind: 'chat', msgId, text, ts: Date.now(), scope: 'dm' })
  }

  /**
   * 发送语音消息。base64 超过单条 control 消息的安全上限时自动分片
   * （接收端按 msgId 重组）。dm 时首片发送失败即返回 false。
   */
  sendVoiceNote(opts: {
    msgId: string
    data: string
    mime: string
    dur: number
    ts: number
    scope: 'all' | 'dm'
    to?: string
  }): boolean {
    const PART = 48_000
    const parts = Math.max(1, Math.ceil(opts.data.length / PART))
    for (let i = 0; i < parts; i++) {
      const piece: ControlMessage = {
        kind: 'voice-note',
        msgId: opts.msgId,
        scope: opts.scope,
        data: opts.data.slice(i * PART, (i + 1) * PART),
        mime: opts.mime,
        dur: opts.dur,
        ts: opts.ts,
        ...(parts > 1 ? { part: i, parts } : {}),
      }
      if (opts.scope === 'dm' && opts.to) {
        if (!this.sendTo(opts.to, piece)) return false
      } else {
        this.broadcast(piece)
      }
    }
    return true
  }

  /** 更新并广播本端名片。 */
  setProfile(profile: Profile): void {
    this.profile = profile
    this.broadcast({ kind: 'profile', profile: this.outgoingProfile() })
  }

  /**
   * 出站名片：在发送口统一注入本端解码能力，而不是让调用方逐处记得填。
   * 这是运行环境属性，UI 层不必关心；实时探测也避免了持久化到 localStorage
   * 后带着过期值跑到别的环境去。
   */
  private outgoingProfile(): Profile {
    return { ...this.profile, screenDecode: canDecodeScreen() }
  }

  /**
   * 向所有对端广播任意 control 消息（通道未就绪的对端静默跳过）。
   *
   * 一律走全连接直连：房间 ≤6 人（见 ARCHITECTURE.md），且拓扑优化后所有
   * WebRTC 连接始终保持（closeUnnecessaryConnections 不真正关闭连接），因此
   * 每个成员都直接可达。曾经的「分层智能广播」只发给必需连接、依赖组长再转发，
   * 但转发路径其实并不存在，跨组会漏送；点对点转发还会把发送者错记成中继组长
   * （A 发给 B，B 看到来自组长 C 的串号 bug）。直连既正确又最简单。
   * 拓扑管理器仅用于网络视图展示与统计，不再参与业务消息路由。
   */
  broadcast(msg: ControlMessage): void {
    for (const peer of this.peers.values()) peer.sendControl(msg)
  }

  /** 向指定对端发送一条 control 消息；未就绪返回 false。 */
  sendTo(peerId: string, msg: ControlMessage): boolean {
    return this.peers.get(peerId)?.sendControl(msg) ?? false
  }

  /** 当前各对端连接状态（link-state 广播 + 本端网络视图），附实测 RTT。 */
  linkStates(): { peerId: string; state: string; rtt?: number }[] {
    return [...this.peers.entries()].map(([peerId, p]) => ({
      peerId,
      state: p.connectionState,
      rtt: this.rtts.get(peerId),
    }))
  }

  private broadcastLinks(): void {
    this.broadcast({ kind: 'link-state', links: this.linkStates() })
  }

  // —— 屏幕共享 ——

  /**
   * 某次共享的可达性预检，在打开采集器**之前**调用。
   * 避免让用户选完屏幕、授完权，才发现根本没人收得到。
   */
  screenTargets(scope: SendScope = 'all', to?: string): ScreenTargets {
    const candidates =
      scope === 'direct' && to
        ? [this.peers.get(to)].filter((p): p is Peer => !!p)
        : [...this.peers.values()]

    const out: ScreenTargets = { ok: [], blocked: [] }
    for (const peer of candidates) {
      const who = this.nicks.get(peer.remoteId) ?? peer.remoteId
      if (peer.connectionState !== 'connected') {
        out.blocked.push({ peerId: peer.remoteId, reason: `${who} 尚未连接` })
      } else if (peer.transport === 'webrtc') {
        // 原生媒体轨，对端不需要 WebCodecs。
        out.ok.push(peer.remoteId)
      } else if (!canEncodeScreen()) {
        out.blocked.push({
          peerId: peer.remoteId,
          reason: `与 ${who} 走服务器中继，该路径需要 WebCodecs 编码画面，当前浏览器不支持`,
        })
      } else if (!this.canRemoteDecode(peer.remoteId)) {
        // 本端编得了，但对端解不了——中继路径要求接收端也有 WebCodecs。
        out.blocked.push({
          peerId: peer.remoteId,
          reason: `与 ${who} 走服务器中继，该路径需要对方浏览器支持 WebCodecs 解码，但对方不支持（常见于以明文 http 访问）`,
        })
      } else {
        out.ok.push(peer.remoteId)
      }
    }
    return out
  }

  /**
   * 对端能否解码中继屏幕画面。名片未到达时返回 true：老版本不通告此字段，
   * 保持既有行为；真解不了时接收端仍会给出提示。
   */
  private canRemoteDecode(peerId: string): boolean {
    return this.remoteScreenDecode.get(peerId) ?? true
  }

  /**
   * 开始屏幕共享。scope=all 发给所有对端；direct 只发给指定对端。
   * 后续新加入的对端仅在 scope=all 时自动补挂。
   */
  startScreenShare(stream: MediaStream, scope: SendScope = 'all', to?: string): void {
    this.stopScreenShare()
    this.screenStream = stream
    this.screenScope = { scope, to }
    const targets =
      scope === 'direct' && to
        ? [this.peers.get(to)].filter((p): p is Peer => !!p)
        : [...this.peers.values()]
    for (const peer of targets) this.attachScreen(peer)
  }

  /** 停止屏幕共享：撤各对端的媒体轨、关编码器、停本地轨道。 */
  stopScreenShare(): void {
    if (!this.screenStream) return
    for (const [peerId, senders] of this.screenSenders) {
      const peer = this.peers.get(peerId)
      if (peer) for (const s of senders) peer.removeTrack(s)
    }
    this.screenSenders.clear()
    this.codecViewers.clear()
    this.screenEncoder?.close()
    this.screenEncoder = null
    this.encoderStarting = null
    for (const track of this.screenStream.getTracks()) track.stop()
    this.screenStream = null
    this.broadcast({ kind: 'screen-stop' })
  }

  get sharingScreen(): boolean {
    return this.screenStream !== null
  }

  // —— 实时对讲（麦克风轨）——

  /**
   * 开麦：把麦克风轨挂到所有 WebRTC 直连/TURN 的对端（复用媒体轨重协商链路）。
   * 走 WS 中继的对端收不到（媒体轨过不了应用层中继，且未做音频自编码），
   * 返回收不到的对端列表供 UI 说明。
   */
  startVoice(stream: MediaStream): { blocked: string[] } {
    this.stopVoice()
    this.voiceStream = stream
    const blocked: string[] = []
    for (const peer of this.peers.values()) {
      if (peer.transport === 'webrtc') {
        this.attachVoice(peer)
      } else {
        blocked.push(peer.remoteId)
      }
    }
    return { blocked }
  }

  /** 关麦：撤各对端的音频轨并停止本地采集。 */
  stopVoice(): void {
    if (!this.voiceStream) return
    for (const [peerId, senders] of this.voiceSenders) {
      const peer = this.peers.get(peerId)
      if (peer) for (const s of senders) peer.removeTrack(s)
    }
    this.voiceSenders.clear()
    for (const track of this.voiceStream.getTracks()) track.stop()
    this.voiceStream = null
    this.broadcast({ kind: 'voice-stop' })
  }

  get voiceActive(): boolean {
    return this.voiceStream !== null
  }

  /** 幂等：把麦克风轨挂到某对端并通告流 id（对端据此识别为语音流）。 */
  private attachVoice(peer: Peer): void {
    const stream = this.voiceStream
    if (!stream || peer.transport !== 'webrtc') return
    if (!this.voiceSenders.has(peer.remoteId)) {
      const senders = stream.getAudioTracks().map((t) => peer.addTrack(t, stream))
      this.voiceSenders.set(peer.remoteId, senders)
    }
    peer.sendControl({ kind: 'voice-start', streamId: stream.id })
  }

  /** 本次共享是否覆盖该对端（广播覆盖全部，单播只覆盖指定的那个）。 */
  private sharedWith(peerId: string): boolean {
    return this.screenScope.scope === 'all' || this.screenScope.to === peerId
  }

  /**
   * 把本端屏幕挂到某个对端，并通知对方。幂等，可重复调用（对端通道就绪、
   * 中途降级都会再调一次）。
   *
   * 两条路径：
   *   - WebRTC 直连/TURN：原生媒体轨，画质与延迟最好，且带音频；
   *   - 已降级为中继：媒体轨过不去（SRTP 在浏览器内部，JS 拿不到编码帧），
   *     改用 WebCodecs 自行编码，编码字节走加密中继通道，仅视频。
   */
  private attachScreen(peer: Peer): void {
    const stream = this.screenStream
    if (!stream) return

    if (peer.transport === 'webrtc') {
      if (!this.screenSenders.has(peer.remoteId)) {
        const senders = stream.getTracks().map((t) => peer.addTrack(t, stream))
        this.screenSenders.set(peer.remoteId, senders)
      }
      peer.sendControl({ kind: 'screen-start', scope: this.screenScope.scope, via: 'track' })
      return
    }

    if (!canEncodeScreen()) {
      const who = this.nicks.get(peer.remoteId) ?? peer.remoteId
      this.emit('error', {
        code: 'screen-codec-unsupported',
        msg: `与 ${who} 的连接走服务器中继，该路径需要 WebCodecs 编码画面，当前浏览器不支持`,
      })
      return
    }

    // 对端解不了码就别发了：白烧一路编码，对面只会看到一条错误提示。
    // 预检已拦过一次，这里兜住「共享中途才降级到中继」的情形。
    if (!this.canRemoteDecode(peer.remoteId)) {
      const who = this.nicks.get(peer.remoteId) ?? peer.remoteId
      this.emit('error', {
        code: 'screen-codec-unsupported',
        msg: `与 ${who} 的连接走服务器中继，但对方浏览器不支持 WebCodecs 解码（常见于以明文 http 访问），TA 看不到你的画面`,
      })
      return
    }

    this.codecViewers.add(peer.remoteId)
    peer.sendControl({ kind: 'screen-start', scope: this.screenScope.scope, via: 'codec' })
    void this.ensureScreenEncoder().then((ok) => {
      // 新观众要等到下一个关键帧才能出画面，这里立刻补一个。
      if (ok) this.screenEncoder?.requestKeyFrame()
    })
  }

  /** 惰性创建编码器；并发调用共用同一个启动 promise。 */
  private ensureScreenEncoder(): Promise<boolean> {
    if (this.encoderStarting) return this.encoderStarting
    const track = this.screenStream?.getVideoTracks()[0]
    if (!track) return Promise.resolve(false)

    const encoder = new ScreenEncoder(track, {
      send: (packet) => this.fanoutScreen(packet),
      // 中继最终压在信令 WebSocket 的发送缓冲上，编码器据此丢帧。
      buffered: () => this.signaling.bufferedAmount,
    })
    this.encoderStarting = encoder.start().then((ok) => {
      // 启动期间可能已经停止共享了。
      if (!ok || !this.screenStream) {
        encoder.close()
        if (!ok) {
          this.emit('error', {
            code: 'screen-codec-unsupported',
            msg: '本机没有可用的视频编码器，无法向走中继的对端共享屏幕',
          })
        }
        return false
      }
      this.screenEncoder = encoder
      return true
    })
    return this.encoderStarting
  }

  /** 编码一次，分发给所有中继观众（中继内部会立即复制载荷，可复用同一份）。 */
  private fanoutScreen(packet: ArrayBuffer): void {
    for (const peerId of this.codecViewers) {
      this.peers.get(peerId)?.sendScreen(packet)
    }
  }

  /** 中继屏幕包到达：交给该对端的解码器，首帧解出后当作一条媒体流上报。 */
  private handleScreenPacket(from: string, packet: ArrayBuffer): void {
    let decoder = this.screenDecoders.get(from)
    if (!decoder) {
      if (!canDecodeScreen()) {
        if (!this.decodeWarned.has(from)) {
          this.decodeWarned.add(from)
          const who = this.nicks.get(from) ?? from
          this.emit('error', {
            code: 'screen-codec-unsupported',
            msg: `${who} 正经中继共享屏幕，但当前浏览器不支持 WebCodecs 解码，无法观看`,
          })
        }
        return
      }
      decoder = new ScreenDecoder()
      decoder.onReady = (stream) => this.emit('screen-stream', { peerId: from, stream })
      this.screenDecoders.set(from, decoder)
    }
    decoder.push(packet)
  }

  private dropScreenDecoder(peerId: string): void {
    this.screenDecoders.get(peerId)?.close()
    this.screenDecoders.delete(peerId)
    this.decodeWarned.delete(peerId)
  }

  // —— 强制发送（推模型，保留原有逐字节流式路径）——

  /**
   * 向指定对端发送一个文件。返回传输 id 与完成 promise；
   * 进度经 file-progress 事件上报。control 通道未就绪时返回 null。
   */
  sendFileTo(
    peerId: string,
    file: File,
  ): { id: string; offer: FileOffer; done: Promise<void>; cancel: () => void } | null {
    const peer = this.peers.get(peerId)
    if (!peer) return null

    const offer: FileOffer = {
      id: genId() + genId(),
      name: file.name,
      size: file.size,
      mime: file.type,
      ts: Date.now(),
    }
    if (!peer.sendControl({ kind: 'file-offer', ...offer })) return null

    const handle = sendFile(peer, offer, file, (bytes) =>
      this.emit('file-progress', { id: offer.id, bytes }),
    )
    this.activeSends.set(offer.id, { peerId, handle })

    const done = handle.done
      .then(() => {
        this.activeSends.delete(offer.id)
      })
      .catch((err) => {
        this.activeSends.delete(offer.id)
        throw err
      })

    return {
      id: offer.id,
      offer,
      done,
      cancel: () => {
        peer.sendControl({ kind: 'file-cancel', id: offer.id })
        handle.cancel()
      },
    }
  }

  /** 接收方主动取消一次接收中/待接收的传输。 */
  cancelReceive(id: string): void {
    const pending = this.pendingOffers.get(id)
    const active = this.activeRecvs.get(id)
    const peerId = active?.peerId ?? pending?.peerId
    if (peerId) this.peers.get(peerId)?.sendControl({ kind: 'file-cancel', id })
    active?.handle.cancel()
    this.pendingOffers.delete(id)
    this.pendingChannels.delete(id)
    this.activeRecvs.delete(id)
    this.emit('file-error', { id, reason: '已取消接收', canceled: true })
  }

  // —— 懒发送 / 多源下载（拉模型）——

  /**
   * 共享一个本地文件（懒发送）：登记元信息并广播，不上传任何字节。
   * scope=direct 时只对指定对端可见。
   */
  shareFile(file: File, scope: SendScope = 'all', to?: string, thumb?: string): SharedFileMeta {
    const meta: SharedFileMeta = {
      fileId: genId() + genId(),
      name: file.name,
      size: file.size,
      mime: file.type,
      chunkSize: CHUNK_SIZE,
      chunks: chunkCount(file.size),
      ts: Date.now(),
      owner: this.myId,
      mode: 'lazy',
      scope,
      thumb,
    }
    this.stores.set(meta.fileId, new FileStore(meta, file))
    this.shares.set(meta.fileId, { meta, local: true, holders: new Set([this.myId]) })
    const msg: ControlMessage = { kind: 'share-offer', file: meta }
    if (scope === 'direct' && to) {
      this.sendTo(to, msg)
    } else {
      this.broadcast(msg)
    }
    return meta
  }

  /** 撤销本端发起的共享。 */
  revokeShare(fileId: string): void {
    const entry = this.shares.get(fileId)
    if (!entry) return
    this.stores.delete(fileId)
    this.shares.delete(fileId)
    this.broadcast({ kind: 'share-revoke', fileId })
    this.emit('share-removed', { fileId })
  }

  /** 已知的可下载共享（不含本端发起的）。 */
  getShare(fileId: string): ShareEntry | undefined {
    return this.shares.get(fileId)
  }

  /**
   * 开始多源下载一个共享文件。向所有对端广播 have-req 做源发现，
   * 各源的 have 应答陆续把它们加入调度。
   */
  downloadShare(
    fileId: string,
    cb: Omit<DownloadCallbacks, 'onChunk' | 'onSources'> & {
      onSources?: (count: number) => void
    },
  ): { cancel: () => void } | null {
    const entry = this.shares.get(fileId)
    if (!entry || this.downloads.has(fileId)) return null

    const download = new Download(
      entry.meta,
      {
        request: (peerId, reqId, fid, index) =>
          this.sendTo(peerId, { kind: 'chunk-req', reqId, fileId: fid, index }),
      },
      {
        onProgress: cb.onProgress,
        onDone: (blob) => {
          this.downloads.delete(fileId)
          // 下载完整份后本端也成为源：store 留在供块表并向全网宣告 full。
          entry.holders.add(this.myId)
          this.broadcast({ kind: 'have', fileId, full: true })
          cb.onDone(blob)
        },
        onError: (reason) => {
          this.downloads.delete(fileId)
          cb.onError(reason)
        },
        onChunk: () => {
          // 拿到片段即成为部分源。节流：每 32 块或完成时广播一次位图。
          const st = download.store
          if (st.bitfield.count % 32 === 0) {
            this.broadcast({ kind: 'have', fileId, bits: st.bitfield.toBase64() })
          }
        },
        onSources: (count) => {
          this.emit('share-sources', { fileId, count })
          cb.onSources?.(count)
        },
      },
    )
    this.downloads.set(fileId, download)
    // 下载中也对外供块：把进行中的 store 注册进供块表。
    this.stores.set(fileId, download.store)

    // 源发现：已知持有者优先，同时全网广播补漏。
    this.broadcast({ kind: 'have-req', fileId })

    return {
      cancel: () => {
        download.cancel()
        this.downloads.delete(fileId)
        // 半成品不再对外供块（保持简单；已宣告的 have 由对端 nak 时自纠）。
        if (!download.store.complete) this.stores.delete(fileId)
      },
    }
  }

  /** 设置拓扑模式 */
  setTopologyMode(mode: TopologyMode): void {
    this.topology.setMode(mode)
  }

  /** 获取当前拓扑模式 */
  getTopologyMode(): TopologyMode {
    return this.topology.getMode()
  }

  /** 获取拓扑统计信息 */
  getTopologyStats() {
    return this.topology.getStats()
  }

  /** 优化拓扑连接：关闭不需要的连接 */
  private optimizeTopology(): void {
    const mode = this.topology.getMode()
    console.log(`[mesh] Optimizing topology (mode: ${mode})`)

    if (mode === 'full-mesh') {
      // 全连接模式：保持所有连接
      console.log('[mesh] Full-mesh mode: keeping all connections')
      return
    }

    // 获取拓扑要求的连接
    const required = this.topology.getRequiredConnections()
    const current = new Set(this.peers.keys())

    console.log(`[mesh] Required connections: ${required.size}`)
    console.log(`[mesh] Current connections: ${current.size}`)

    // 重要：广播拓扑信息到所有节点，确保一致性
    console.log('[mesh] Broadcasting topology information...')
    this.broadcastTopologyInfo()

    // 延迟关闭连接，等待拓扑信息同步
    setTimeout(() => {
      this.closeUnnecessaryConnections()
    }, 2000)
  }

  /** 广播拓扑信息（分组结果） */
  private broadcastTopologyInfo(): void {
    const groups = this.topology.getGroupsList()

    // 构造拓扑信息消息
    for (const group of groups) {
      const topoMsg: ControlMessage = {
        kind: 'topo-announce',
        groupId: group.id,
        leader: group.leader,
        members: Array.from(group.members),
        version: Date.now(), // 使用时间戳作为版本号
      }

      // 广播到所有节点
      this.broadcast(topoMsg)
    }
  }

  /** 关闭不需要的连接（在同步后执行） */
  private closeUnnecessaryConnections(): void {
    const required = this.topology.getRequiredConnections()
    const current = new Set(this.peers.keys())

    console.log('[mesh] Topology optimization: marking inactive connections...')
    console.log('[mesh] Required connections:', required.size)
    console.log('[mesh] Current connections:', current.size)

    // 重要：不关闭连接，只标记为"不活跃"
    // 这样保持 P2P 通道，避免降级到服务器中继
    let markedCount = 0
    let activeCount = 0

    for (const peerId of current) {
      if (required.has(peerId)) {
        // 必需的连接：标记为活跃
        activeCount++
      } else {
        // 不需要的连接：不关闭，但标记为备用
        // 这些连接仍然可用于冗余路由
        markedCount++
        console.log(
          `[mesh] Marking as backup: ${peerId.slice(0, 8)} ` +
          `(keeping WebRTC, not using for primary routing)`
        )
      }
    }

    console.log(
      `[mesh] Topology ready: ` +
      `${activeCount} active, ` +
      `${markedCount} backup, ` +
      `total ${this.peers.size} WebRTC connections maintained`
    )

    // 广播更新后的邻接表
    this.broadcastLinks()
  }

  /** 手动触发拓扑优化（用于测试或手动控制） */
  triggerTopologyOptimization(): void {
    this.optimizeTopology()
  }

  getNick(peerId: string): string | undefined {
    return this.nicks.get(peerId)
  }

  leave(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.pendingPings.clear()
    this.rtts.clear()
    this.topology.dispose()
    if (this.voiceStream) {
      for (const track of this.voiceStream.getTracks()) track.stop()
      this.voiceStream = null
    }
    this.voiceSenders.clear()
    this.remoteVoiceStreams.clear()
    this.voiceParts.clear()
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) track.stop()
      this.screenStream = null
    }
    this.screenSenders.clear()
    this.codecViewers.clear()
    this.screenEncoder?.close()
    this.screenEncoder = null
    this.encoderStarting = null
    for (const d of this.screenDecoders.values()) d.close()
    this.screenDecoders.clear()
    this.decodeWarned.clear()
    for (const { handle } of this.activeSends.values()) handle.cancel()
    for (const { handle } of this.activeRecvs.values()) handle.cancel()
    for (const d of this.downloads.values()) d.cancel()
    this.activeSends.clear()
    this.activeRecvs.clear()
    this.pendingOffers.clear()
    this.pendingChannels.clear()
    this.downloads.clear()
    this.stores.clear()
    this.shares.clear()
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.nicks.clear()
    this.remoteScreenDecode.clear()
    this.signaling.send({ t: 'leave' })
    this.signaling.close()
  }

  private addPeer(remoteId: string): Peer {
    const existing = this.peers.get(remoteId)
    if (existing) return existing

    // 在分层模式下，暂时延迟建立连接，等待拓扑计算完成
    // 注意：这里仍然创建 Peer，但可以在后续优化中实现按需连接

    const initiator = this.myId < remoteId
    const peer = new Peer({
      remoteId,
      initiator,
      polite: !initiator,
      iceServers: this.iceServers,
      sendSignal: (data) => this.signaling.send({ t: 'signal', to: remoteId, data }),
      sendRelay: (frame) => this.signaling.sendRelay(frame),
      relayBuffered: () => this.signaling.bufferedAmount,
    })

    peer.on('connectionstate', (state) => {
      this.emit('peer-state', { peerId: remoteId, state })
      // 连通性变化即把邻接表广播出去，网络视图据此画边。
      this.broadcastLinks()
    })
    peer.on('control', (msg) => this.handleControl(remoteId, msg))
    peer.on('filechannel', ({ id, channel }) => this.handleFileChannel(remoteId, id, channel))
    peer.on('chunk', (frame) => this.handleChunkFrame(remoteId, frame))
    peer.on('screenpacket', (packet) => this.handleScreenPacket(remoteId, packet))
    peer.on('sas', (sas) => this.emit('peer-sas', { peerId: remoteId, sas }))
    peer.on('transport', (transport) => {
      this.emit('peer-transport', { peerId: remoteId, transport })
      // 共享进行中的对端刚降级为中继：原生媒体轨已作废，改挂自编码路径。
      if (transport === 'relay' && this.screenStream && this.sharedWith(remoteId)) {
        this.screenSenders.delete(remoteId)
        this.attachScreen(peer)
      }
    })
    peer.on('track', ({ track, streams }) => {
      const stream = streams[0]
      if (!stream) return
      // 对讲的语音流 id 由 voice-start 先行通告；其余媒体流一律视为屏幕共享。
      if (this.remoteVoiceStreams.get(remoteId) === stream.id || (track.kind === 'audio' && stream.getVideoTracks().length === 0)) {
        this.emit('voice-stream', { peerId: remoteId, stream })
        return
      }
      this.emit('screen-stream', { peerId: remoteId, stream })
    })
    peer.on('channelopen', () => {
      // 通道就绪：互换名片、邻接表、共享目录；迟到者补挂屏幕。
      peer.sendControl({ kind: 'profile', profile: this.outgoingProfile() })
      peer.sendControl({ kind: 'link-state', links: this.linkStates() })
      const visible = [...this.shares.values()]
        .filter((e) => e.local && e.meta.scope === 'all')
        .map((e) => e.meta)
      if (visible.length > 0) peer.sendControl({ kind: 'share-list', files: visible })
      // attachScreen 幂等：这里既补发 screen-start，也让中继观众拿到关键帧
      // （中继的 channelopen 正好在密钥协商完成时触发）。
      if (this.screenStream && this.sharedWith(remoteId)) this.attachScreen(peer)
      if (this.voiceStream) this.attachVoice(peer)
      // 会话内续传：通道（重新）就绪时向它询问所有进行中下载的持块情况，
      // 停摆的下载据此拿回源并自动继续。
      for (const fileId of this.downloads.keys()) {
        peer.sendControl({ kind: 'have-req', fileId })
      }
      this.emit('peer-channel-open', remoteId)
    })

    this.peers.set(remoteId, peer)
    // 本端正在向全网共享屏幕：给新对端补挂画面。
    if (this.screenStream && this.screenScope.scope === 'all') this.attachScreen(peer)
    this.emit('peer-added', { peerId: remoteId, nick: this.nicks.get(remoteId) })
    // 构造期就可能已降级（如强制中继开关），此时 'transport' 事件早于上面的
    // 订阅发出，补一次同步；之后的变化由事件驱动。必须在 peer-added 之后，
    // 否则 store 里还没有这个成员可更新。
    if (peer.transport !== 'webrtc') {
      this.emit('peer-transport', { peerId: remoteId, transport: peer.transport })
    }
    return peer
  }

  private handleControl(from: string, msg: ControlMessage): void {
    switch (msg.kind) {
      case 'chat':
        this.emit('chat', {
          from,
          msgId: msg.msgId ?? `${from}-${msg.ts}`,
          text: msg.text,
          ts: msg.ts,
          scope: msg.scope ?? 'all',
        })
        break
      case 'react':
        this.emit('react', { from, msgId: msg.msgId, emoji: msg.emoji, op: msg.op, scope: msg.scope })
        break
      case 'voice-note': {
        // 分片重组：control 有序可靠，同一 msgId 的分片按序到达。
        let data = msg.data
        if (msg.parts && msg.parts > 1) {
          const key = `${from}|${msg.msgId}`
          const buf = this.voiceParts.get(key) ?? []
          buf.push(msg.data)
          if (buf.length < msg.parts) {
            this.voiceParts.set(key, buf)
            break
          }
          this.voiceParts.delete(key)
          data = buf.join('')
        }
        this.emit('voice-note', {
          from,
          msgId: msg.msgId,
          scope: msg.scope,
          data,
          mime: msg.mime,
          dur: msg.dur,
          ts: msg.ts,
        })
        break
      }
      case 'ping':
        this.sendTo(from, { kind: 'pong', seq: msg.seq })
        break
      case 'pong': {
        const p = this.pendingPings.get(msg.seq)
        if (p && p.peerId === from) {
          this.pendingPings.delete(msg.seq)
          const rtt = Math.max(0, Math.round(performance.now() - p.sentAt))
          this.rtts.set(from, rtt)
          this.emit('peer-rtt', { peerId: from, rtt })

          // 更新拓扑管理器的质量数据
          const peer = this.peers.get(from)
          this.topology.updateQuality(from, {
            rtt,
            state: peer?.connectionState ?? 'new',
            iceType: this.getIceType(peer),
          })
        }
        break
      }
      case 'voice-start':
        this.remoteVoiceStreams.set(from, msg.streamId)
        this.emit('voice-start', from)
        break
      case 'voice-stop':
        this.remoteVoiceStreams.delete(from)
        this.emit('voice-stop', from)
        break
      case 'guess-start':
      case 'guess-try':
      case 'guess-correct':
      case 'guess-reveal':
      case 'guess-end':
      case 'gomoku-invite':
      case 'gomoku-accept':
      case 'gomoku-decline':
      case 'gomoku-move':
      case 'gomoku-resign':
      case 'table-create':
      case 'table-join':
      case 'table-spectate':
      case 'table-leave':
      case 'table-start':
      case 'table-sit':
      case 'table-standup':
      case 'table-invite':
      case 'game-move':
      case 'game-chat':
      case 'mouse-pos':
      case 'match-request':
      case 'match-cancel':
      case 'match-found':
        this.emit('game', { from, msg })
        break
      case 'profile': {
        this.nicks.set(from, msg.profile.nick)
        // 名片通常在 channelopen 之后才到，那时 attachScreen 可能已因「未知能力
        // 默认可解码」而挂过。若通告说解不了，撤掉这个白发的观众。
        const before = this.canRemoteDecode(from)
        this.remoteScreenDecode.set(from, msg.profile.screenDecode ?? true)
        if (before && !this.canRemoteDecode(from) && this.codecViewers.delete(from)) {
          const who = msg.profile.nick || from
          this.emit('error', {
            code: 'screen-codec-unsupported',
            msg: `与 ${who} 的连接走服务器中继，但对方浏览器不支持 WebCodecs 解码（常见于以明文 http 访问），TA 看不到你的画面`,
          })
        }
        this.emit('peer-profile', { peerId: from, profile: msg.profile })
        break
      }
      case 'profile-req':
        this.sendTo(from, { kind: 'profile', profile: this.outgoingProfile() })
        break
      case 'link-state':
        this.emit('peer-links', { peerId: from, links: msg.links })
        break
      case 'screen-start':
        // 对方经中继共享（WebCodecs 自编码），而本机解不了：明确告知，
        // 否则只会看到一个永远黑屏的画面条目。提示只发一次，但拒绝要每次都拒。
        if (msg.via === 'codec' && !canDecodeScreen()) {
          if (!this.decodeWarned.has(from)) {
            this.decodeWarned.add(from)
            this.emit('error', {
              code: 'screen-codec-unsupported',
              msg: `${this.nicks.get(from) ?? from} 正经中继共享屏幕，但当前浏览器不支持 WebCodecs 解码，无法观看`,
            })
          }
          break
        }
        this.emit('screen-start', from)
        break
      case 'screen-stop':
        this.dropScreenDecoder(from)
        this.emit('screen-stop', from)
        break
      case 'draw-begin':
      case 'draw-points':
      case 'draw-end':
      case 'draw-line':
      case 'draw-polyline':
      case 'draw-text':
      case 'draw-image':
      case 'draw-update':
      case 'draw-move':
      case 'draw-remove':
      case 'draw-clear':
      case 'draw-state':
      case 'ptr-move':
      case 'ptr-click':
      case 'ptr-hide':
        this.emit('draw', { from, msg })
        break
      case 'file-offer': {
        const { kind: _kind, ...offer } = msg
        this.emit('file-offer', { peerId: from, offer })
        const channel = this.pendingChannels.get(offer.id)
        if (channel) {
          this.pendingChannels.delete(offer.id)
          this.startReceive(from, offer, channel)
        } else {
          this.pendingOffers.set(offer.id, { peerId: from, offer })
        }
        break
      }
      case 'file-cancel': {
        // 对端取消：可能是发送方中止（我在收），也可能是接收方拒收（我在发）。
        const send = this.activeSends.get(msg.id)
        if (send) {
          send.handle.cancel()
          this.activeSends.delete(msg.id)
        }
        const recv = this.activeRecvs.get(msg.id)
        if (recv) {
          recv.handle.cancel()
          this.activeRecvs.delete(msg.id)
        }
        const hadPending = this.pendingOffers.delete(msg.id)
        this.pendingChannels.delete(msg.id)
        if (send || recv || hadPending) {
          this.emit('file-error', { id: msg.id, reason: '对方取消了传输', canceled: true })
        }
        break
      }
      case 'share-offer':
        this.registerShare(from, msg.file)
        break
      case 'share-list':
        for (const f of msg.files) this.registerShare(from, f)
        break
      case 'share-revoke': {
        const entry = this.shares.get(msg.fileId)
        if (!entry || entry.local) break
        entry.holders.delete(from)
        this.downloads.get(msg.fileId)?.dropSource(from)
        // 下载进行中不作废条目：留给会话内续传等源恢复。
        if (entry.holders.size === 0 && !this.downloads.has(msg.fileId)) {
          this.shares.delete(msg.fileId)
          this.emit('share-removed', { fileId: msg.fileId })
        }
        break
      }
      case 'have': {
        const entry = this.shares.get(msg.fileId)
        if (entry) entry.holders.add(from)
        const dl = this.downloads.get(msg.fileId)
        if (dl) {
          const bits = msg.full
            ? Bitfield.full(dl.store.meta.chunks)
            : Bitfield.fromBase64(msg.bits ?? '', dl.store.meta.chunks)
          if (bits.count > 0) dl.addSource(from, bits)
        }
        break
      }
      case 'have-req': {
        const store = this.stores.get(msg.fileId)
        if (!store || store.bitfield.count === 0) break
        if (store.complete) {
          this.sendTo(from, { kind: 'have', fileId: msg.fileId, full: true })
        } else {
          this.sendTo(from, {
            kind: 'have',
            fileId: msg.fileId,
            bits: store.bitfield.toBase64(),
          })
        }
        break
      }
      case 'chunk-req':
        void this.serveChunk(from, msg.reqId, msg.fileId, msg.index)
        break
      case 'chunk-nak':
        this.downloads.forEach((dl) => {
          if (dl.ownsReq(msg.reqId)) dl.onNak(from, msg.reqId)
        })
        break
      // —— 拓扑管理消息 ——
      case 'topo-announce':
        // 收到拓扑通告：同步远端的分组信息
        console.log(`[mesh] Received topology from ${from.slice(0, 8)}:`, msg)
        this.handleTopologyAnnounce(from, msg)
        break
      case 'leader-elect':
        this.topology.handleLeaderElect(from, msg)
        break
      case 'leader-ack':
        // 组长确认消息（预留，当前选举逻辑较简单）
        break
      case 'relay-forward':
        // 收到中继消息：如果是发给我的，解包；如果我是组长且需要转发，继续转发
        this.handleRelayForward(from, msg)
        break
    }
  }

  /** 处理拓扑通告消息 */
  private handleTopologyAnnounce(
    from: string,
    msg: Extract<ControlMessage, { kind: 'topo-announce' }>
  ): void {
    // 传递给拓扑管理器
    this.topology.handleTopologyAnnounce(from, msg)

    // 同步拓扑信息：根据收到的分组信息更新本地视图
    // 注意：为了保持一致性，使用字典序最小的节点作为"协调者"
    const allPeers = [this.myId, ...Array.from(this.peers.keys())].sort()
    const coordinator = allPeers[0]

    if (from === coordinator) {
      // 收到协调者的拓扑信息，以此为准
      console.log(`[mesh] Syncing topology from coordinator ${coordinator.slice(0, 8)}`)
      // TODO: 应用协调者的拓扑决策
    }
  }

  /** 处理中继转发消息 */
  private handleRelayForward(from: string, msg: Extract<ControlMessage, { kind: 'relay-forward' }>): void {
    const { originalFrom, finalTo, payload } = msg

    // 如果是发给我的，直接处理
    if (finalTo === this.myId) {
      this.handleControl(originalFrom, payload)
      return
    }

    // 如果是广播消息 (finalTo === '*')
    if (finalTo === '*') {
      // 1. 本节点处理一次
      this.handleControl(originalFrom, payload)

      // 2. 如果我是组长，转发给我的组员（除了来源）
      if (this.topology.isLeader()) {
        const myGroupId = this.topology.getGroupId(this.myId)
        if (myGroupId) {
          const myGroup = this.topology.getGroupsList().find((g) => g.id === myGroupId)
          if (myGroup) {
            for (const member of myGroup.members) {
              if (member !== this.myId && member !== from && member !== originalFrom) {
                this.peers.get(member)?.sendControl(msg)
              }
            }
          }
        }

        // 3. 转发给其他组的组长（除了来源）
        const leaders = this.topology.getLeaders()
        for (const leader of leaders) {
          if (leader !== this.myId && leader !== from && leader !== originalFrom) {
            this.peers.get(leader)?.sendControl(msg)
          }
        }
      }
      return
    }

    // 如果是点对点消息，且我是组长，需要转发
    if (this.topology.isLeader()) {
      // 检查目标是否在我的组内
      if (this.topology.inSameGroup(this.myId, finalTo)) {
        // 目标在我的组内：转发整条 relay-forward（而非裸 payload），
        // 让目标经上面的 finalTo===myId 分支解包，把发送者正确还原为
        // originalFrom。若直接投递 payload，目标会把发送者错记成本组长（串号）。
        this.peers.get(finalTo)?.sendControl(msg)
      } else {
        // 目标在其他组，转发给目标的组长
        const targetLeader = this.topology.getLeader(finalTo)
        if (targetLeader && targetLeader !== this.myId) {
          this.peers.get(targetLeader)?.sendControl(msg)
        }
      }
    }
  }

  /** 获取 peer 的 ICE 类型（用于拓扑质量评估） */
  private getIceType(peer: Peer | undefined): 'host' | 'srflx' | 'relay' | 'unknown' {
    if (!peer) return 'unknown'
    // 简化版：根据 transport 推断
    // WebRTC relay 通常通过 TURN
    // 实际实现可以从 ICE 候选中获取更精确的类型
    if (peer.transport === 'relay') return 'relay'
    // 默认假设是直连或 srflx
    return 'host'
  }

  private removePeer(remoteId: string): void {
    const peer = this.peers.get(remoteId)
    if (!peer) return

    // 从拓扑管理器移除
    this.topology.removePeer(remoteId)

    peer.close()
    this.peers.delete(remoteId)
    this.nicks.delete(remoteId)
    this.remoteScreenDecode.delete(remoteId)
    this.screenSenders.delete(remoteId)
    this.codecViewers.delete(remoteId)
    this.dropScreenDecoder(remoteId)
    this.voiceSenders.delete(remoteId)
    this.remoteVoiceStreams.delete(remoteId)
    this.rtts.delete(remoteId)
    for (const key of [...this.voiceParts.keys()]) {
      if (key.startsWith(`${remoteId}|`)) this.voiceParts.delete(key)
    }
    // 该对端的未决 offer 不会再有数据通道了，直接清理。
    for (const [id, p] of this.pendingOffers) {
      if (p.peerId === remoteId) {
        this.pendingOffers.delete(id)
        this.emit('file-error', { id, reason: '对方已离线', canceled: false })
      }
    }
    // 共享目录：把它从持有者中移除；无人持有的远端共享作废（下载中的除外，
    // 留给会话内续传等源恢复）。
    for (const [fileId, entry] of [...this.shares]) {
      if (!entry.holders.delete(remoteId)) continue
      this.downloads.get(fileId)?.dropSource(remoteId)
      if (!entry.local && entry.holders.size === 0 && !this.downloads.has(fileId)) {
        this.shares.delete(fileId)
        this.emit('share-removed', { fileId })
      }
    }
    this.broadcastLinks()
    this.emit('peer-removed', remoteId)
  }

  /** 收到远端的 share-offer / share-list：登记为可下载条目。 */
  private registerShare(from: string, meta: SharedFileMeta): void {
    let entry = this.shares.get(meta.fileId)
    if (!entry) {
      entry = { meta, local: false, holders: new Set() }
      this.shares.set(meta.fileId, entry)
      entry.holders.add(from)
      this.emit('share-added', { peerId: from, file: meta })
    } else {
      entry.holders.add(from)
    }
  }

  /** 供块：读本地 store（File slice 或内存分块），经 swarm 通道回给请求方。 */
  private async serveChunk(
    from: string,
    reqId: number,
    fileId: string,
    index: number,
  ): Promise<void> {
    const peer = this.peers.get(from)
    const store = this.stores.get(fileId)
    if (!peer || !store || !store.bitfield.has(index)) {
      this.sendTo(from, { kind: 'chunk-nak', reqId, reason: 'unavailable' })
      return
    }
    // 简单限流：积压过高时等待回落，防止多请求方同时拉爆内存。
    while (peer.swarmReady && peer.swarmBuffered > Mesh.SERVE_BUFFER_HIGH) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const buf = await store.read(index)
    if (!buf || !peer.sendChunk(packChunk(reqId, buf))) {
      this.sendTo(from, { kind: 'chunk-nak', reqId, reason: 'read-failed' })
      return
    }
    this.emit('share-serving', { fileId, peerId: from })
  }

  /** swarm 通道帧到达：按 reqId 路由到对应下载任务。 */
  private handleChunkFrame(from: string, frame: ArrayBuffer): void {
    const parsed = unpackChunk(frame)
    if (!parsed) return
    for (const dl of this.downloads.values()) {
      if (dl.ownsReq(parsed.reqId)) {
        dl.onData(from, parsed.reqId, parsed.payload)
        return
      }
    }
  }

  private handleFileChannel(from: string, id: string, channel: ChannelLike): void {
    const pending = this.pendingOffers.get(id)
    if (pending && pending.peerId === from) {
      this.pendingOffers.delete(id)
      this.startReceive(from, pending.offer, channel)
    } else {
      // 数据通道先于 file-offer 到达：暂存，等元信息。
      this.pendingChannels.set(id, channel)
    }
  }

  private startReceive(peerId: string, offer: FileOffer, channel: ChannelLike): void {
    const handle = receiveFile(channel, offer, {
      onProgress: (bytes) => this.emit('file-progress', { id: offer.id, bytes }),
      onDone: (blob) => {
        this.activeRecvs.delete(offer.id)
        this.emit('file-done', { id: offer.id, blob })
      },
      onError: (reason) => {
        this.activeRecvs.delete(offer.id)
        this.emit('file-error', { id: offer.id, reason, canceled: false })
      },
    })
    this.activeRecvs.set(offer.id, { peerId, handle })
  }
}

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

/**
 * 读出 WS 中继帧头里的来源 peerId：[0]=版本, [1]=id 长度, [2..]=id。
 * 帧的其余部分是端到端密文，路由层不碰。
 */
function relayFrameSource(frame: ArrayBuffer): string | null {
  const buf = new Uint8Array(frame)
  if (buf.length < 2 || buf[0] !== 1) return null
  const len = buf[1]
  if (len === 0 || buf.length < 2 + len) return null
  return new TextDecoder().decode(buf.subarray(2, 2 + len))
}

function toRtcIceServer(s: IceServer): RTCIceServer {
  const out: RTCIceServer = { urls: s.urls }
  if (s.username) out.username = s.username
  if (s.credential) out.credential = s.credential
  return out
}

/**
 * 由内置 STUN/TURN 的端口与凭证拼出 ICE 服务器条目。
 * 主机名取 location.hostname：客户端既然能打开本页面，该主机必然可达，
 * 因此 pphub 自身就是最可靠的打洞/中继服务器。
 * UDP 优先（打洞 + 低延迟中继）；TURN over TCP 兜底（穿越禁 UDP 的网络，
 * 服务端可只暴露 TCP 并置于 nginx stream 之后）。
 */
function builtinIceServers(builtin: BuiltinIce | null | undefined): RTCIceServer[] {
  if (!builtin) return []
  const host = location.hostname
  const out: RTCIceServer[] = []
  if (builtin.udpPort > 0) {
    out.push({ urls: [`stun:${host}:${builtin.udpPort}`] })
    out.push({
      urls: [`turn:${host}:${builtin.udpPort}?transport=udp`],
      username: builtin.username,
      credential: builtin.credential,
    })
  }
  if (builtin.tcpPort > 0) {
    out.push({
      urls: [`turn:${host}:${builtin.tcpPort}?transport=tcp`],
      username: builtin.username,
      credential: builtin.credential,
    })
  }
  return out
}
