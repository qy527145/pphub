// ICE 连接诊断工具：记录并显示 ICE 候选收集和连接过程

export interface IceDebugInfo {
  localCandidates: RTCIceCandidate[]
  remoteCandidates: RTCIceCandidate[]
  selectedPair: RTCIceCandidatePair | null
  connectionState: RTCPeerConnectionState
  iceGatheringState: RTCIceGatheringState
  iceConnectionState: RTCIceConnectionState
}

export class IceDebugger {
  private localCandidates: RTCIceCandidate[] = []
  private remoteCandidates: RTCIceCandidate[] = []

  constructor(
    private pc: RTCPeerConnection,
    private remoteId: string
  ) {
    this.setupLogging()
  }

  private setupLogging() {
    const { pc, remoteId } = this

    // 监听本地候选
    const originalIceHandler = pc.onicecandidate
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        this.localCandidates.push(event.candidate)
        this.logCandidate('LOCAL', event.candidate)
      } else {
        console.log(`[ICE] 本地候选收集完成 -> ${remoteId}`, this.getCandidateSummary())
      }
      if (originalIceHandler) originalIceHandler.call(pc, event)
    }

    // 监听ICE连接状态
    const originalIceConnHandler = pc.oniceconnectionstatechange
    pc.oniceconnectionstatechange = (event: Event) => {
      console.log(`[ICE] 连接状态变化 -> ${remoteId}:`, pc.iceConnectionState)
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.logSelectedPair()
      }
      if (originalIceConnHandler) originalIceConnHandler.call(pc, event)
    }

    // 监听ICE收集状态
    const originalGatherHandler = pc.onicegatheringstatechange
    pc.onicegatheringstatechange = (event: Event) => {
      console.log(`[ICE] 收集状态 -> ${remoteId}:`, pc.iceGatheringState)
      if (originalGatherHandler) originalGatherHandler.call(pc, event)
    }

    // 监听整体连接状态
    const originalConnHandler = pc.onconnectionstatechange
    pc.onconnectionstatechange = (event: Event) => {
      console.log(`[ICE] PeerConnection 状态 -> ${remoteId}:`, pc.connectionState)
      if (originalConnHandler) originalConnHandler.call(pc, event)
    }
  }

  private logCandidate(type: 'LOCAL' | 'REMOTE', candidate: RTCIceCandidate) {
    const c = candidate
    console.log(
      `[ICE] ${type} -> ${this.remoteId}:`,
      `${c.type}/${c.protocol}`,
      c.address || '?',
      `:${c.port}`,
      c.relatedAddress ? `(via ${c.relatedAddress}:${c.relatedPort})` : ''
    )
  }

  addRemoteCandidate(candidate: RTCIceCandidate) {
    this.remoteCandidates.push(candidate)
    this.logCandidate('REMOTE', candidate)
  }

  private getCandidateSummary() {
    const count = (candidates: RTCIceCandidate[], type: RTCIceCandidateType) =>
      candidates.filter((c) => c.type === type).length

    return {
      local: {
        host: count(this.localCandidates, 'host'),
        srflx: count(this.localCandidates, 'srflx'),
        relay: count(this.localCandidates, 'relay'),
      },
      remote: {
        host: count(this.remoteCandidates, 'host'),
        srflx: count(this.remoteCandidates, 'srflx'),
        relay: count(this.remoteCandidates, 'relay'),
      },
    }
  }

  private async logSelectedPair() {
    try {
      const stats = await this.pc.getStats()
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          console.log(`[ICE] ✅ 选中的候选对 -> ${this.remoteId}:`, {
            local: report.localCandidateId,
            remote: report.remoteCandidateId,
            nominated: report.nominated,
            state: report.state,
          })

          // 查找对应的候选详情
          const localCand = Array.from(stats.values()).find(
            (s) => s.type === 'local-candidate' && s.id === report.localCandidateId
          )
          const remoteCand = Array.from(stats.values()).find(
            (s) => s.type === 'remote-candidate' && s.id === report.remoteCandidateId
          )

          if (localCand) {
            console.log(
              `[ICE]   本地: ${localCand.candidateType} ${localCand.address}:${localCand.port} (${localCand.protocol})`
            )
          }
          if (remoteCand) {
            console.log(
              `[ICE]   远端: ${remoteCand.candidateType} ${remoteCand.address}:${remoteCand.port} (${remoteCand.protocol})`
            )
          }

          // 关键：检查是否使用了中继
          if (localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay') {
            console.warn(`[ICE] ⚠️ 连接使用了TURN中继 -> ${this.remoteId}`)
          } else if (localCand?.candidateType === 'srflx' || remoteCand?.candidateType === 'srflx') {
            console.log(`[ICE] ℹ️ 连接使用了STUN穿透（公网地址）-> ${this.remoteId}`)
          } else {
            console.log(`[ICE] ℹ️ 连接使用了直连（局域网）-> ${this.remoteId}`)
          }
        }
      }
    } catch (err) {
      console.error('[ICE] 获取统计信息失败:', err)
    }
  }

  getDebugInfo(): IceDebugInfo {
    return {
      localCandidates: [...this.localCandidates],
      remoteCandidates: [...this.remoteCandidates],
      selectedPair: null, // 需要异步查询
      connectionState: this.pc.connectionState,
      iceGatheringState: this.pc.iceGatheringState,
      iceConnectionState: this.pc.iceConnectionState,
    }
  }
}
