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
import { Peer } from './peer'
import type { BuiltinIce, IceServer } from './protocol'
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

type MeshEvents = {
  self: string
  'peer-added': { peerId: string; nick?: string }
  'peer-removed': string
  'peer-state': { peerId: string; state: RTCPeerConnectionState }
  'peer-sas': { peerId: string; sas: Sas }
  /** 对端的名片到达/更新。 */
  'peer-profile': { peerId: string; profile: Profile }
  /** 对端上报了它的邻接表（网络视图边数据）。 */
  'peer-links': { peerId: string; links: { peerId: string; state: string }[] }
  /** 某对端的 control 通道就绪（可向其补发状态同步，如白板全量）。 */
  'peer-channel-open': string
  chat: { from: string; text: string; ts: number; scope: 'all' | 'dm' }
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

/** 供 store 查询的共享条目视图。 */
export interface ShareEntry {
  meta: SharedFileMeta
  /** 本端是否持有完整文件（源之一）。 */
  local: boolean
  /** 已知持有全部或部分分块的节点。 */
  holders: Set<string>
}

export class Mesh extends Emitter<MeshEvents> {
  myId = ''
  room = ''
  profile: Profile = { nick: '', avatar: { kind: 'emoji', value: '🦊', color: '#6c4bf4' }, rev: 1 }

  private readonly signaling: Signaling
  private readonly peers = new Map<string, Peer>()
  private readonly nicks = new Map<string, string | undefined>()
  private iceServers: RTCIceServer[] = []

  // 强制发送（推）登记表（按传输 id 索引；id 全局随机，跨 peer 不冲突）。
  private readonly pendingOffers = new Map<string, { peerId: string; offer: FileOffer }>()
  private readonly pendingChannels = new Map<string, RTCDataChannel>()
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

  constructor(signaling: Signaling) {
    super()
    this.signaling = signaling
    this.wireSignaling()
  }

  private wireSignaling(): void {
    this.signaling.on('joined', ({ peerId, peers }) => {
      this.myId = peerId
      this.emit('self', peerId)
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
  }

  /** 加入房间：连接 → 领取 ICE 凭证 → 发送 join。 */
  async join(room: string, profile: Profile): Promise<void> {
    this.room = room
    this.profile = profile
    this.myId = genId()

    this.signaling.connect()
    await this.signaling.ready()

    const { iceServers, builtin } = await this.signaling.requestTurnCreds()
    // 内置 STUN/TURN 排在最前：它与本页同主机，必然可达。
    this.iceServers = [...builtinIceServers(builtin), ...iceServers.map(toRtcIceServer)]

    this.signaling.send({ t: 'join', room, peerId: this.myId, nick: profile.nick })
  }

  /** 群聊：向所有对端广播。 */
  sendChat(text: string): void {
    this.broadcast({ kind: 'chat', text, ts: Date.now(), scope: 'all' })
  }

  /** 私聊：只发给指定对端。 */
  sendDm(peerId: string, text: string): boolean {
    return this.sendTo(peerId, { kind: 'chat', text, ts: Date.now(), scope: 'dm' })
  }

  /** 更新并广播本端名片。 */
  setProfile(profile: Profile): void {
    this.profile = profile
    this.broadcast({ kind: 'profile', profile })
  }

  /** 向所有对端广播任意 control 消息（通道未就绪的对端静默跳过）。 */
  broadcast(msg: ControlMessage): void {
    for (const peer of this.peers.values()) peer.sendControl(msg)
  }

  /** 向指定对端发送一条 control 消息；未就绪返回 false。 */
  sendTo(peerId: string, msg: ControlMessage): boolean {
    return this.peers.get(peerId)?.sendControl(msg) ?? false
  }

  /** 当前各对端连接状态（link-state 广播 + 本端网络视图）。 */
  linkStates(): { peerId: string; state: string }[] {
    return [...this.peers.entries()].map(([peerId, p]) => ({
      peerId,
      state: p.connectionState,
    }))
  }

  private broadcastLinks(): void {
    this.broadcast({ kind: 'link-state', links: this.linkStates() })
  }

  // —— 屏幕共享 ——

  /**
   * 开始屏幕共享。scope=all 挂到所有对端；direct 只挂到指定对端。
   * 后续新加入的对端仅在 scope=all 时自动补挂。
   */
  startScreenShare(stream: MediaStream, scope: SendScope = 'all', to?: string): void {
    this.stopScreenShare()
    this.screenStream = stream
    this.screenScope = { scope, to }
    if (scope === 'direct' && to) {
      const peer = this.peers.get(to)
      if (peer) this.attachScreen(peer)
      this.sendTo(to, { kind: 'screen-start', scope })
    } else {
      for (const peer of this.peers.values()) this.attachScreen(peer)
      this.broadcast({ kind: 'screen-start', scope: 'all' })
    }
  }

  /** 停止屏幕共享：移除各对端上的 senders 并停止本地轨道。 */
  stopScreenShare(): void {
    if (!this.screenStream) return
    for (const [peerId, senders] of this.screenSenders) {
      const peer = this.peers.get(peerId)
      if (peer) for (const s of senders) peer.removeTrack(s)
    }
    this.screenSenders.clear()
    for (const track of this.screenStream.getTracks()) track.stop()
    this.screenStream = null
    this.broadcast({ kind: 'screen-stop' })
  }

  get sharingScreen(): boolean {
    return this.screenStream !== null
  }

  private attachScreen(peer: Peer): void {
    const stream = this.screenStream
    if (!stream) return
    const senders = stream.getTracks().map((t) => peer.addTrack(t, stream))
    this.screenSenders.set(peer.remoteId, senders)
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
  shareFile(file: File, scope: SendScope = 'all', to?: string): SharedFileMeta {
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

  getNick(peerId: string): string | undefined {
    return this.nicks.get(peerId)
  }

  leave(): void {
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) track.stop()
      this.screenStream = null
    }
    this.screenSenders.clear()
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
    this.signaling.send({ t: 'leave' })
    this.signaling.close()
  }

  private addPeer(remoteId: string): Peer {
    const existing = this.peers.get(remoteId)
    if (existing) return existing

    const initiator = this.myId < remoteId
    const peer = new Peer({
      remoteId,
      initiator,
      polite: !initiator,
      iceServers: this.iceServers,
      sendSignal: (data) => this.signaling.send({ t: 'signal', to: remoteId, data }),
    })

    peer.on('connectionstate', (state) => {
      this.emit('peer-state', { peerId: remoteId, state })
      // 连通性变化即把邻接表广播出去，网络视图据此画边。
      this.broadcastLinks()
    })
    peer.on('control', (msg) => this.handleControl(remoteId, msg))
    peer.on('filechannel', ({ id, channel }) => this.handleFileChannel(remoteId, id, channel))
    peer.on('chunk', (frame) => this.handleChunkFrame(remoteId, frame))
    peer.on('sas', (sas) => this.emit('peer-sas', { peerId: remoteId, sas }))
    peer.on('track', ({ streams }) => {
      if (streams[0]) this.emit('screen-stream', { peerId: remoteId, stream: streams[0] })
    })
    peer.on('channelopen', () => {
      // 通道就绪：互换名片、邻接表、共享目录；迟到者补 screen-start。
      peer.sendControl({ kind: 'profile', profile: this.profile })
      peer.sendControl({ kind: 'link-state', links: this.linkStates() })
      const visible = [...this.shares.values()]
        .filter((e) => e.local && e.meta.scope === 'all')
        .map((e) => e.meta)
      if (visible.length > 0) peer.sendControl({ kind: 'share-list', files: visible })
      if (this.screenStream && this.screenScope.scope === 'all') {
        peer.sendControl({ kind: 'screen-start', scope: 'all' })
      }
      this.emit('peer-channel-open', remoteId)
    })

    this.peers.set(remoteId, peer)
    // 本端正在向全网共享屏幕：给新对端补挂媒体轨。
    if (this.screenScope.scope === 'all') this.attachScreen(peer)
    this.emit('peer-added', { peerId: remoteId, nick: this.nicks.get(remoteId) })
    return peer
  }

  private handleControl(from: string, msg: ControlMessage): void {
    switch (msg.kind) {
      case 'chat':
        this.emit('chat', { from, text: msg.text, ts: msg.ts, scope: msg.scope ?? 'all' })
        break
      case 'profile':
        this.nicks.set(from, msg.profile.nick)
        this.emit('peer-profile', { peerId: from, profile: msg.profile })
        break
      case 'profile-req':
        this.sendTo(from, { kind: 'profile', profile: this.profile })
        break
      case 'link-state':
        this.emit('peer-links', { peerId: from, links: msg.links })
        break
      case 'screen-start':
        this.emit('screen-start', from)
        break
      case 'screen-stop':
        this.emit('screen-stop', from)
        break
      case 'draw-begin':
      case 'draw-points':
      case 'draw-end':
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
        if (entry.holders.size === 0) {
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
    }
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

  private handleFileChannel(from: string, id: string, channel: RTCDataChannel): void {
    const pending = this.pendingOffers.get(id)
    if (pending && pending.peerId === from) {
      this.pendingOffers.delete(id)
      this.startReceive(from, pending.offer, channel)
    } else {
      // 数据通道先于 file-offer 到达：暂存，等元信息。
      this.pendingChannels.set(id, channel)
    }
  }

  private startReceive(peerId: string, offer: FileOffer, channel: RTCDataChannel): void {
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

  private removePeer(remoteId: string): void {
    const peer = this.peers.get(remoteId)
    if (!peer) return
    peer.close()
    this.peers.delete(remoteId)
    this.nicks.delete(remoteId)
    this.screenSenders.delete(remoteId)
    // 该对端的未决 offer 不会再有数据通道了，直接清理。
    for (const [id, p] of this.pendingOffers) {
      if (p.peerId === remoteId) {
        this.pendingOffers.delete(id)
        this.emit('file-error', { id, reason: '对方已离线', canceled: false })
      }
    }
    // 共享目录：把它从持有者中移除；无人持有的远端共享作废。
    for (const [fileId, entry] of [...this.shares]) {
      if (!entry.holders.delete(remoteId)) continue
      this.downloads.get(fileId)?.dropSource(remoteId)
      if (!entry.local && entry.holders.size === 0) {
        this.shares.delete(fileId)
        this.emit('share-removed', { fileId })
      }
    }
    this.broadcastLinks()
    this.emit('peer-removed', remoteId)
  }
}

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
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
 */
function builtinIceServers(builtin: BuiltinIce | null | undefined): RTCIceServer[] {
  if (!builtin) return []
  const host = location.hostname
  return [
    { urls: [`stun:${host}:${builtin.udpPort}`] },
    {
      urls: [`turn:${host}:${builtin.udpPort}?transport=udp`],
      username: builtin.username,
      credential: builtin.credential,
    },
  ]
}
