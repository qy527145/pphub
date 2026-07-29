import { computed, reactive, ref, shallowReactive, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import { peerColor } from '@/core/draw'
import { JoinRejected, Mesh } from '@/core/mesh'
import type { DrawMessage, GameMessage } from '@/core/mesh'
import type { PeerTransport } from '@/core/peer'
import type {
  Avatar,
  Profile,
  SendScope,
  SharedFileMeta,
  TransferMode,
  WbItem,
  WbStroke,
  WbLine,
  WbPolyline,
  WbText,
  WbImage,
} from '@/core/messages'
import { type Capabilities, detectCapabilities } from '@/core/capabilities'
import { imageToAvatar, loadProfile, saveProfile } from '@/core/profile'
import type { Sas } from '@/core/security'
import { Signaling, type SignalingState } from '@/core/signaling'
import {
  applyTheme,
  initialTheme,
  persistTheme,
  type Theme,
  watchSystemTheme,
} from '@/core/theme'
import { blobToDataURL, dataURLToBlob, makeImageThumb } from '@/utils/blob'
import type { DroppedPayload } from '@/utils/fs'
import { GOMOKU_SIZE, gomokuWinLine } from '@/utils/gomoku'
import { notifyBackground, requestNotifyPermission } from '@/utils/notify'
import { normalizeGuess } from '@/utils/words'
import { zipFolder } from '@/utils/zip'
import {
  type GameTable,
  type GameType,
  type GameChatMessage,
  type MousePosition,
  type PlayerRole,
  generateTableId,
  getGameMeta,
  canStartGame,
} from '@/core/games'

/** idle=未上线 · connecting=正在进房 · online=已在房间（监听中或已连接对端） */
export type Status = 'idle' | 'connecting' | 'online'

export type View = 'network' | 'send' | 'receive' | 'chat' | 'screen' | 'board' | 'games'

export interface Member {
  peerId: string
  nick?: string
  state: RTCPeerConnectionState | 'new'
  /** 实际通路：'relay' 表示 WebRTC 打不通、数据经服务器中继（屏幕共享不可用）。 */
  transport: PeerTransport
  sas?: Sas
  /** 用户已带外核对 SAS 一致。 */
  verified: boolean
  /** 该对端正在共享屏幕（screen-start 已到，媒体流可能稍后到达）。 */
  sharing?: boolean
  /** 对端名片（昵称 + 头像）；未到达时回退 nick/peerId。 */
  profile?: Profile
}

/** 白板/批注上的远程成员光标。 */
export interface RemotePointer {
  peerId: string
  x: number
  y: number
  ts: number
  color: string
}

/** 点击涟漪特效（转瞬即逝，由 store 定时清除）。 */
export interface ClickFx {
  id: number
  board: string
  x: number
  y: number
  color: string
}

/** 聊天频道：'all' 为群聊，否则为对端 peerId（一对一私聊）。 */
export type ChatChannel = 'all' | string

export interface ChatEntry {
  id: number
  /** 全网唯一消息 id（表情回应按它寻址）。文件卡片消息无 msgId。 */
  msgId?: string
  from: string
  fromNick: string
  text: string
  ts: number
  self: boolean
  channel: ChatChannel
  /** 文件卡片（消息中发文件时附带）。thumb 为图片的内联预览。 */
  file?: { fileId: string; name: string; size: number; mime?: string; thumb?: string }
  /** 语音消息（objectURL + 时长 ms）。 */
  voice?: { url: string; dur: number }
  /** 表情回应：emoji → 回应者 peerId 列表。 */
  reactions?: Record<string, string[]>
}

/** 一局五子棋（一对一，与某对端各持一份镜像状态）。 */
export interface GomokuGame {
  gameId: string
  opponent: string
  /** 1=黑（先手，邀请方）· 2=白。 */
  myColor: 1 | 2
  turn: 1 | 2
  /** 15×15 展平，0=空。 */
  cells: number[]
  moves: number
  state: 'invite-in' | 'invite-out' | 'active' | 'over'
  result?: 'win' | 'loss' | 'draw'
  /** 终局说明（认输/离线/连五）。 */
  reason?: string
  /** 最后一手下标（高亮）。 */
  last?: number
  winLine?: number[]
}

/** 你画我猜的一次猜测。 */
export interface GuessTry {
  round: number
  from: string
  nick: string
  text: string
  ts: number
  correct?: boolean
}

export interface Transfer {
  id: string
  direction: 'send' | 'recv'
  peerId: string
  peerNick: string
  name: string
  size: number
  bytes: number
  state: 'pending' | 'active' | 'done' | 'error' | 'canceled'
  error?: string
  /** 接收完成后的 objectURL，可再次保存。 */
  url?: string
  startedAt: number
  finishedAt?: number
}

/** 懒发送 / 多源下载条目（共享目录里的一项）。 */
export interface ShareItem {
  fileId: string
  name: string
  size: number
  mime: string
  ownerId: string
  scope: SendScope
  ts: number
  /** 本端是共享方（持有原始文件）。 */
  local: boolean
  /** idle=可下载 · downloading=多源下载中 · done=已完成 · error=失败 */
  state: 'idle' | 'downloading' | 'done' | 'error'
  bytes: number
  /** 当前参与供块的源数量。 */
  sources: number
  /** 本端作为源被拉取过的次数（上传活动指示）。 */
  served: number
  url?: string
  error?: string
  /** 图片共享的内联缩略图（列表/聊天预览）。 */
  thumb?: string
}

const LS_ALLOW_INCOMING = 'pphub.allowIncoming'
const LS_DEVICE_NAME = 'pphub.deviceName'
const SS_MY_CODE = 'pphub.myCode'
const SS_CODE_LEN = 'pphub.codeLen'
const SS_CURRENT_ROOM = 'pphub.currentRoom'

const CODE_LEN_MIN = 6
const CODE_LEN_MAX = 9

function defaultSignalingUrl(): string {
  const fromEnv = import.meta.env.VITE_SIGNALING_URL
  if (fromEnv) return fromEnv
  // 相对路径：自动继承 nginx 反向代理的路径前缀。
  // 取 pathname 的目录部分（去掉末段非斜线内容），再拼 ws。
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const dir = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1)
  return `${proto}://${location.host}${dir}ws`
}

/**
 * 数字临时短码（会话内稳定，刷新不变、关标签页失效）。
 * 长度 6 位起步，随服务端按在线规模下发的建议动态加长（防生日碰撞）。
 */
function ensureMyCode(): string {
  const saved = sessionStorage.getItem(SS_MY_CODE)
  if (saved && /^\d{6,9}$/.test(saved)) return saved
  return regenCode()
}

/** 服务端建议的码长（随 joined 应答更新，会话内记忆）。 */
function savedCodeLen(): number {
  const n = Number(sessionStorage.getItem(SS_CODE_LEN))
  return Number.isInteger(n) && n >= CODE_LEN_MIN && n <= CODE_LEN_MAX ? n : CODE_LEN_MIN
}

function noteCodeLen(len: number): void {
  const clamped = Math.min(CODE_LEN_MAX, Math.max(CODE_LEN_MIN, Math.floor(len)))
  sessionStorage.setItem(SS_CODE_LEN, String(clamped))
}

function regenCode(len = savedCodeLen()): string {
  const code = randomDigits(len)
  sessionStorage.setItem(SS_MY_CODE, code)
  return code
}

/** 密码学随机的数字串；按字节拒绝采样（≥250 丢弃）消除模偏差。 */
function randomDigits(len: number): string {
  const buf = new Uint8Array(len * 2)
  let out = ''
  while (out.length < len) {
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b < 250 && out.length < len) out += String(b % 10)
    }
  }
  return out
}

/** 从 UA 推导默认设备名（如 “Mac · Chrome”）。 */
function defaultDeviceName(): string {
  const ua = navigator.userAgent
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Firefox/')
      ? 'Firefox'
      : ua.includes('Chrome/')
        ? 'Chrome'
        : ua.includes('Safari/')
          ? 'Safari'
          : '浏览器'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua)
      ? 'Mac'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(ua)
          ? 'iPhone'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${os} · ${browser}` : browser
}

function triggerDownload(name: string, url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export const useRoomStore = defineStore('room', () => {
  const capabilities: Capabilities = detectCapabilities()

  // —— 连接状态 ——
  const status = ref<Status>('idle')
  const myId = ref('')
  const room = ref('')
  const myCode = ref(ensureMyCode())
  const myProfile = ref<Profile>(
    loadProfile(localStorage.getItem(LS_DEVICE_NAME) || defaultDeviceName()),
  )
  const allowIncoming = ref(localStorage.getItem(LS_ALLOW_INCOMING) !== '0')
  const signalingState = ref<SignalingState>('idle')
  const lastError = ref<string | null>(null)

  // —— 会话数据 ——
  const members = reactive(new Map<string, Member>())
  const messages = ref<ChatEntry[]>([])
  const transfers = ref<Transfer[]>([])
  /** 共享目录（懒发送登记 + 远端可下载）。 */
  const shares = reactive(new Map<string, ShareItem>())
  /** 网络拓扑：peerId → 它上报的邻接表（neighbor → 连接状态 + 实测 RTT）。 */
  const peerLinks = reactive(new Map<string, Map<string, { state: string; rtt?: number }>>())
  /** 本端到各对端的实测往返延迟（ms，5s 一轮 ping）。 */
  const rtts = reactive(new Map<string, number>())

  // —— 实时对讲 ——
  /** 本端正在说话（按住对讲）。 */
  const talking = ref(false)
  /** 正在说话的对端。 */
  const speaking = reactive(new Set<string>())
  /** 对端语音流的播放元素（非响应式，随 voice-stop / 离线回收）。 */
  const voiceEls = new Map<string, HTMLAudioElement>()

  // —— 你画我猜（公共白板游戏模式）——
  const guess = reactive({
    active: false,
    round: 0,
    drawer: '',
    hint: '',
    /** 谜底，只在出题人本地存在。 */
    word: '',
    tries: [] as GuessTry[],
    scores: {} as Record<string, number>,
    /** 上一轮结果（公布答案 / 有人猜中）。 */
    lastWord: '',
    lastWinner: '',
  })

  // —— 五子棋（一对一）——
  const gomoku = reactive(new Map<string, GomokuGame>())
  /** 打开棋盘面板的对局（对端 peerId）。 */
  const gomokuOpen = ref<string | null>(null)

  // —— 游戏系统（新版，支持游戏桌、旁观等）——
  const gameTables = reactive(new Map<string, GameTable>())
  /** 当前加入的游戏桌 ID */
  const currentTableId = ref<string | null>(null)
  /** 游戏内聊天消息 */
  const gameChats = reactive(new Map<string, GameChatMessage[]>())
  /** 游戏内鼠标位置 */
  const gameMousePositions = reactive(new Map<string, MousePosition[]>())

  /** 文件夹打包中的数量（UI 转圈提示）。 */
  const packing = ref(0)

  // —— 聊天频道 ——
  const activeChannel = ref<ChatChannel>('all')
  /** 各频道未读数（badge 汇总用）。 */
  const unread = reactive(new Map<ChatChannel, number>())

  // —— 屏幕共享 ——
  /** 本端是否正在共享屏幕。 */
  const sharing = ref(false)
  /** 本端共享的可见范围。 */
  const sharingScope = ref<{ scope: SendScope; to?: string }>({ scope: 'all' })
  /** 本端共享流（本地预览用）。 */
  const localScreen = shallowRef<MediaStream | null>(null)
  /** 远端共享流：sharerPeerId → MediaStream。 */
  const remoteScreens = shallowReactive(new Map<string, MediaStream>())
  /** 当前观看谁的画面：'self' 为自己预览，否则为 sharer peerId。 */
  const watching = ref<string | null>(null)

  // —— 白板 / 屏幕批注 ——
  // 元素本体不做响应式（高频追加 + canvas 直读），以 boardRev 驱动重绘。
  const boards = new Map<string, WbItem[]>()
  const boardRev = ref(0)
  /** 白板页当前打开的画板：'wb' 公共，或 dmBoardId(peer) 私有。 */
  const activeBoard = ref('wb')
  /** 正在绘制中的远端笔画：strokeId → { board, stroke }。 */
  const liveStrokes = new Map<string, { board: string; stroke: WbStroke }>()
  /** 本端各画面的元素 id 栈（撤销用）。 */
  const myStrokes = new Map<string, string[]>()
  /** 远程成员光标：`${board}|${peerId}` → RemotePointer。 */
  const pointers = reactive(new Map<string, RemotePointer>())
  /** 点击涟漪特效队列。 */
  const clicks = ref<ClickFx[]>([])

  // —— 外观 ——
  const theme = ref<Theme>(initialTheme())
  applyTheme(theme.value)
  // 未显式选过主题时继续跟随系统。
  watchSystemTheme((t) => {
    theme.value = t
    applyTheme(t)
  })

  // —— UI 导航 ——
  const activeView = ref<View>('network')
  const unseenRecv = ref(0)
  const unseenShare = ref(0)
  /** 白板页外收到「你画我猜」开局的角标。 */
  const unseenBoard = ref(0)
  /** 发送页预选目标（网络视图点节点「发文件」带过来）。 */
  const sendTarget = ref<'all' | string>('all')

  const memberList = computed(() => [...members.values()])
  const peerCount = computed(() => members.size)
  const connectedPeers = computed(() => memberList.value.filter((m) => m.state === 'connected'))
  /** 正在共享屏幕的远端成员。 */
  const sharers = computed(() => memberList.value.filter((m) => m.sharing))

  /**
   * 屏幕共享可达性（供 UI 决定按钮是否可点）。与 mesh.screenTargets 同一套判据：
   * 直连/TURN 的对端走原生媒体轨，对方不需要 WebCodecs；降级为中继的对端则要求
   * **本端能编码且对端能解码**（对端能力由名片 screenDecode 通告，缺省视为能解，
   * 兼容不带该字段的旧版本）。
   */
  const screenReach = computed(() => {
    const ok = connectedPeers.value.filter(
      (m) =>
        m.transport !== 'relay' ||
        (capabilities.screenEncode && (m.profile?.screenDecode ?? true)),
    ).length
    return { total: connectedPeers.value.length, ok }
  })
  /** 在自己短码的房间里等待别人连入。 */
  const listening = computed(() => status.value === 'online' && room.value === myCode.value)
  /** 分享链接：对方打开即加入我所在的房间（未上线则指向我的短码）。 */
  const shareLink = computed(() => {
    const target = status.value === 'online' ? room.value : myCode.value
    return `${location.origin}${location.pathname}?c=${encodeURIComponent(target)}`
  })
  const shareList = computed(() => [...shares.values()].sort((a, b) => b.ts - a.ts))
  const unreadTotal = computed(() => {
    let n = 0
    for (const v of unread.values()) n += v
    return n
  })

  let mesh: Mesh | null = null
  let msgSeq = 0
  let strokeSeq = 0
  let clickSeq = 0
  /** 发送侧取消回调（id → cancel）。 */
  const sendCancels = new Map<string, () => void>()
  /** 多源下载取消回调（fileId → cancel）。 */
  const downloadCancels = new Map<string, () => void>()

  // 光标停止上报后自动淡出（对端崩溃/切页时兜底）。
  setInterval(() => {
    const now = Date.now()
    for (const [key, p] of pointers) {
      if (now - p.ts > 5000) pointers.delete(key)
    }
  }, 2000)

  /** 成员显示名：名片昵称 > 信令 nick > peerId。 */
  function displayName(peerId: string): string {
    if (peerId === myId.value) return myProfile.value.nick || '我'
    const m = members.get(peerId)
    return m?.profile?.nick ?? m?.nick ?? peerId
  }

  /** 与某对端的私有白板 id（两端各自计算，结果一致）。 */
  function dmBoardId(peerId: string): string {
    const pair = [myId.value, peerId].sort()
    return `wb:${pair[0]}~${pair[1]}`
  }

  /** 私有白板 id 中的对方节点；非私有板返回 null。 */
  function dmBoardPeer(board: string): string | null {
    if (!board.startsWith('wb:')) return null
    const pair = board.slice(3).split('~')
    return pair.find((p) => p !== myId.value) ?? null
  }

  /** 取画面的元素数组（惰性创建）。canvas 组件配合 boardRev 直读。 */
  function getBoard(board: string): WbItem[] {
    let arr = boards.get(board)
    if (!arr) {
      arr = []
      boards.set(board, arr)
    }
    return arr
  }

  function bumpBoard(): void {
    boardRev.value++
  }

  /** 清掉某画面的全部本地状态（元素/光标/涟漪）。 */
  function dropBoard(board: string): void {
    boards.delete(board)
    myStrokes.delete(board)
    for (const [id, live] of liveStrokes) {
      if (live.board === board) liveStrokes.delete(id)
    }
    for (const key of pointers.keys()) {
      if (key.startsWith(`${board}|`)) pointers.delete(key)
    }
    clicks.value = clicks.value.filter((c) => c.board !== board)
    bumpBoard()
  }

  function findTransfer(id: string): Transfer | undefined {
    return transfers.value.find((t) => t.id === id)
  }

  /** 绘制/指针消息路由：私有白板只发给对方，其余广播。 */
  function sendDraw(board: string, msg: DrawMessage): void {
    if (!mesh) return
    const peer = dmBoardPeer(board)
    if (peer) {
      mesh.sendTo(peer, msg)
    } else {
      mesh.broadcast(msg)
    }
  }

  function bumpUnread(channel: ChatChannel): void {
    if (activeView.value === 'chat' && activeChannel.value === channel) return
    unread.set(channel, (unread.get(channel) ?? 0) + 1)
  }

  function createMesh(url: string): Mesh {
    const m = new Mesh(new Signaling(url))

    m.on('self', (id) => {
      myId.value = id
    })
    m.on('peer-added', ({ peerId, nick: n }) => {
      members.set(peerId, {
        peerId,
        nick: n,
        state: 'new',
        transport: 'webrtc',
        verified: false,
      })
    })
    m.on('peer-removed', (peerId) => {
      members.delete(peerId)
      peerLinks.delete(peerId)
      rtts.delete(peerId)
      speaking.delete(peerId)
      dropVoiceEl(peerId)
      // 私聊频道随成员消失，攒着的未读没有入口可清，一并清掉
      //（消息本体保留，重开该频道仍能看到历史）。
      unread.delete(peerId)
      // 进行中的对局：对方离线即终局。
      const game = gomoku.get(peerId)
      if (game && game.state === 'active') {
        game.state = 'over'
        game.result = 'win'
        game.reason = '对方已离线'
      } else if (game && game.state !== 'over') {
        gomoku.delete(peerId)
        if (gomokuOpen.value === peerId) gomokuOpen.value = null
      }
      if (members.size === 0 || remoteScreens.has(peerId)) cleanupRemoteShare(peerId)
      for (const key of pointers.keys()) {
        if (key.endsWith(`|${peerId}`)) pointers.delete(key)
      }
    })
    m.on('peer-state', ({ peerId, state }) => {
      const member = members.get(peerId)
      if (member) member.state = state
    })
    m.on('peer-transport', ({ peerId, transport }) => {
      const member = members.get(peerId)
      if (member) member.transport = transport
    })
    m.on('peer-sas', ({ peerId, sas }) => {
      const member = members.get(peerId)
      if (member) member.sas = sas
    })
    m.on('peer-profile', ({ peerId, profile }) => {
      const member = members.get(peerId)
      if (!member) return
      if (member.profile && member.profile.rev > profile.rev) return
      member.profile = profile
      member.nick = profile.nick
    })
    m.on('peer-links', ({ peerId, links }) => {
      peerLinks.set(
        peerId,
        new Map(links.map((l) => [l.peerId, { state: l.state, rtt: l.rtt }])),
      )
    })
    m.on('peer-rtt', ({ peerId, rtt }) => {
      rtts.set(peerId, rtt)
    })
    m.on('chat', ({ from, msgId, text, ts, scope }) => {
      const channel: ChatChannel = scope === 'dm' ? from : 'all'
      pushMessage({ from, fromNick: displayName(from), msgId, text, ts, self: false, channel })
      bumpUnread(channel)
    })
    m.on('react', ({ from, msgId, emoji, op }) => {
      applyReact(msgId, from, emoji, op)
    })
    m.on('voice-note', ({ from, msgId, scope, data, mime, dur, ts }) => {
      let url: string
      try {
        url = URL.createObjectURL(dataURLToBlob(data, mime))
      } catch {
        return
      }
      const channel: ChatChannel = scope === 'dm' ? from : 'all'
      pushMessage({
        from,
        fromNick: displayName(from),
        msgId,
        text: '',
        ts,
        self: false,
        channel,
        voice: { url, dur },
      })
      bumpUnread(channel)
    })

    // —— 实时对讲 ——
    m.on('voice-start', (peerId) => speaking.add(peerId))
    m.on('voice-stop', (peerId) => {
      speaking.delete(peerId)
      dropVoiceEl(peerId)
    })
    m.on('voice-stream', ({ peerId, stream }) => {
      let el = voiceEls.get(peerId)
      if (!el) {
        el = new Audio()
        el.autoplay = true
        voiceEls.set(peerId, el)
      }
      el.srcObject = stream
      void el.play().catch(() => {
        // 自动播放被拦（用户还没与页面交互过）：给出可操作的提示。
        lastError.value = '浏览器拦截了语音自动播放，点击页面任意处后恢复'
      })
    })

    // —— 游戏（你画我猜 / 五子棋）——
    m.on('game', ({ from, msg }) => handleGame(from, msg))

    m.on('peer-channel-open', (peerId) => {
      // 新对端通道就绪：补发公共白板与和它的私有白板全量状态（对方按 id 去重合并）。
      const wb = boards.get('wb')
      if (wb && wb.length > 0) {
        m.sendTo(peerId, { kind: 'draw-state', board: 'wb', items: wb })
      }
      const dm = boards.get(dmBoardId(peerId))
      if (dm && dm.length > 0) {
        m.sendTo(peerId, { kind: 'draw-state', board: dmBoardId(peerId), items: dm })
      }
    })

    m.on('screen-start', (peerId) => {
      const member = members.get(peerId)
      if (member) member.sharing = true
    })
    m.on('screen-stream', ({ peerId, stream }) => {
      remoteScreens.set(peerId, stream)
      const member = members.get(peerId)
      if (member) member.sharing = true
      // 自动切到新开播的画面；不在共享页时挂角标提醒。
      if (watching.value === null || watching.value === 'self') watching.value = peerId
      if (activeView.value !== 'screen') unseenShare.value++
    })
    m.on('screen-stop', (peerId) => cleanupRemoteShare(peerId))

    m.on('draw', ({ from, msg }) => applyDraw(from, msg))

    m.on('file-offer', ({ peerId, offer }) => {
      transfers.value.unshift({
        id: offer.id,
        direction: 'recv',
        peerId,
        peerNick: displayName(peerId),
        name: offer.name,
        size: offer.size,
        bytes: 0,
        state: 'pending',
        startedAt: Date.now(),
      })
      if (activeView.value !== 'receive') unseenRecv.value++
    })
    m.on('file-progress', ({ id, bytes }) => {
      const t = findTransfer(id)
      if (!t || t.state === 'done' || t.state === 'error' || t.state === 'canceled') return
      t.bytes = bytes
      if (t.state === 'pending') t.state = 'active'
    })
    m.on('file-done', ({ id, blob }) => {
      const t = findTransfer(id)
      if (!t) return
      t.bytes = t.size
      t.state = 'done'
      t.finishedAt = Date.now()
      t.url = URL.createObjectURL(blob)
      // 自动保存（浏览器允许程序化触发下载）。列表里保留“另存”入口。
      triggerDownload(t.name, t.url)
    })
    m.on('file-error', ({ id, reason, canceled }) => {
      const t = findTransfer(id)
      if (!t || t.state === 'done') return
      t.state = canceled ? 'canceled' : 'error'
      t.error = reason
      t.finishedAt = Date.now()
    })

    m.on('share-added', ({ peerId, file }) => {
      registerShare(file, false)
      if (activeView.value !== 'receive') unseenRecv.value++
      // 在对应频道插入文件卡片（私有共享 → 私聊频道；广播 → 群聊频道）。
      const channel: ChatChannel = file.scope === 'direct' ? peerId : 'all'
      pushMessage({
        from: peerId,
        fromNick: displayName(peerId),
        text: '',
        ts: file.ts,
        self: false,
        channel,
        file: {
          fileId: file.fileId,
          name: file.name,
          size: file.size,
          mime: file.mime,
          thumb: file.thumb,
        },
      })
      bumpUnread(channel)
    })
    m.on('share-removed', ({ fileId }) => {
      const item = shares.get(fileId)
      if (!item) return
      if (item.state === 'downloading') {
        item.state = 'error'
        item.error = '共享已撤销或所有源离线'
      } else if (item.state !== 'done') {
        shares.delete(fileId)
      }
    })
    m.on('share-sources', ({ fileId, count }) => {
      const item = shares.get(fileId)
      if (item) item.sources = count
    })
    m.on('share-serving', ({ fileId }) => {
      const item = shares.get(fileId)
      if (item) item.served++
    })

    m.on('signaling-state', (s) => {
      signalingState.value = s
    })
    m.on('error', (e) => {
      lastError.value = e.msg || e.code
      if (status.value === 'connecting') {
        teardown()
      }
    })

    return m
  }

  function registerShare(meta: SharedFileMeta, local: boolean): ShareItem {
    let item = shares.get(meta.fileId)
    if (!item) {
      item = {
        fileId: meta.fileId,
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
        ownerId: meta.owner,
        scope: meta.scope,
        ts: meta.ts,
        local,
        state: 'idle',
        bytes: local ? meta.size : 0,
        sources: 0,
        served: 0,
        thumb: meta.thumb,
      }
      shares.set(meta.fileId, item)
    }
    return item
  }

  function pushMessage(entry: Omit<ChatEntry, 'id'>): void {
    messages.value.push({ id: msgSeq++, ...entry })
    // 页面在后台时来消息：系统通知 + 标题闪烁（notify 内部判断可见性）。
    if (!entry.self) {
      const body = entry.text || (entry.voice ? '[语音消息]' : entry.file ? `[文件] ${entry.file.name}` : '')
      notifyBackground(entry.fromNick, body)
    }
  }

  /** 全网唯一消息 id（表情回应寻址用）。 */
  function genMsgId(): string {
    return `${myId.value || 'me'}-${Date.now().toString(36)}-${(msgSeq++).toString(36)}`
  }

  /** 按 msgId 更新一条消息的表情回应（本地与远端共用）。 */
  function applyReact(msgId: string, from: string, emoji: string, op: 'add' | 'remove'): void {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.msgId !== msgId) continue
      const reactions = m.reactions ?? (m.reactions = {})
      const who = reactions[emoji] ?? []
      if (op === 'add') {
        if (!who.includes(from)) reactions[emoji] = [...who, from]
      } else {
        const next = who.filter((p) => p !== from)
        if (next.length > 0) reactions[emoji] = next
        else delete reactions[emoji]
      }
      return
    }
  }

  /** 给某条消息加/撤自己的表情回应（再点同一个 emoji 即撤销）。 */
  function toggleReact(entry: ChatEntry, emoji: string): void {
    if (!mesh || !entry.msgId) return
    const mine = entry.reactions?.[emoji]?.includes(myId.value) ?? false
    const op = mine ? 'remove' : 'add'
    const scope = entry.channel === 'all' ? 'all' : 'dm'
    const msg = { kind: 'react' as const, msgId: entry.msgId, emoji, op: op as 'add' | 'remove', scope: scope as 'all' | 'dm' }
    if (entry.channel === 'all') {
      mesh.broadcast(msg)
    } else if (!mesh.sendTo(entry.channel, msg)) {
      return
    }
    applyReact(entry.msgId, myId.value, emoji, op)
  }

  function dropVoiceEl(peerId: string): void {
    const el = voiceEls.get(peerId)
    if (el) {
      el.pause()
      el.srcObject = null
      voiceEls.delete(peerId)
    }
  }

  /** 应用一条远端绘制/指针消息。 */
  function applyDraw(from: string, msg: DrawMessage): void {
    switch (msg.kind) {
      case 'draw-begin': {
        const stroke: WbStroke = {
          id: msg.id,
          color: msg.color,
          size: msg.size,
          mode: msg.mode,
          points: [msg.x, msg.y],
        }
        getBoard(msg.board).push(stroke)
        liveStrokes.set(msg.id, { board: msg.board, stroke })
        bumpBoard()
        break
      }
      case 'draw-points': {
        const live = liveStrokes.get(msg.id)
        if (live) {
          live.stroke.points.push(...msg.pts)
          bumpBoard()
        }
        break
      }
      case 'draw-end':
        liveStrokes.delete(msg.id)
        break
      case 'draw-line': {
        const line: WbLine = {
          id: msg.id,
          color: msg.color,
          mode: msg.mode,
          size: msg.size,
          x1: msg.x1,
          y1: msg.y1,
          x2: msg.x2,
          y2: msg.y2,
        }
        getBoard(msg.board).push(line)
        bumpBoard()
        break
      }
      case 'draw-polyline': {
        const pl: WbPolyline = {
          id: msg.id,
          color: msg.color,
          mode: 'polyline',
          size: msg.size,
          points: msg.points,
          arrow: msg.arrow,
        }
        getBoard(msg.board).push(pl)
        bumpBoard()
        break
      }
      case 'draw-text': {
        const text: WbText = {
          id: msg.id,
          color: msg.color,
          mode: 'text',
          x: msg.x,
          y: msg.y,
          text: msg.text,
          fontSize: msg.fontSize,
        }
        getBoard(msg.board).push(text)
        bumpBoard()
        break
      }
      case 'draw-image': {
        const image: WbImage = {
          id: msg.id,
          color: '#000',
          mode: 'image',
          x: msg.x,
          y: msg.y,
          width: msg.width,
          height: msg.height,
          dataUrl: msg.dataUrl,
        }
        getBoard(msg.board).push(image)
        bumpBoard()
        break
      }
      case 'draw-update': {
        const item = getBoard(msg.board).find((i) => i.id === msg.id)
        if (item && item.mode === 'image') {
          item.x = msg.x
          item.y = msg.y
          item.width = msg.width
          item.height = msg.height
          item.rotation = msg.rotation
          bumpBoard()
        }
        break
      }
      case 'draw-move': {
        const arr = boards.get(msg.board)
        if (arr) {
          const keep = new Set(msg.ids)
          for (const it of arr) {
            if (keep.has(it.id)) translateItem(it, msg.dx, msg.dy)
          }
          bumpBoard()
        }
        break
      }
      case 'draw-remove': {
        const arr = boards.get(msg.board)
        if (arr) {
          const drop = new Set(msg.ids)
          boards.set(
            msg.board,
            arr.filter((s) => !drop.has(s.id)),
          )
          bumpBoard()
        }
        break
      }
      case 'draw-clear':
        dropBoard(msg.board)
        break
      case 'draw-state': {
        const arr = getBoard(msg.board)
        const have = new Set(arr.map((s) => s.id))
        for (const item of msg.items) {
          if (!have.has(item.id)) arr.push(item)
        }
        bumpBoard()
        break
      }
      case 'ptr-move': {
        const key = `${msg.board}|${from}`
        const p = pointers.get(key)
        if (p) {
          p.x = msg.x
          p.y = msg.y
          p.ts = Date.now()
        } else {
          pointers.set(key, {
            peerId: from,
            x: msg.x,
            y: msg.y,
            ts: Date.now(),
            color: peerColor(from),
          })
        }
        break
      }
      case 'ptr-click':
        spawnClick(msg.board, msg.x, msg.y, peerColor(from))
        break
      case 'ptr-hide':
        pointers.delete(`${msg.board}|${from}`)
        break
    }
  }

  function spawnClick(board: string, x: number, y: number, color: string): void {
    const fx: ClickFx = { id: clickSeq++, board, x, y, color }
    clicks.value.push(fx)
    setTimeout(() => {
      clicks.value = clicks.value.filter((c) => c.id !== fx.id)
    }, 1200)
  }

  /** 远端停止共享 / 离线：撤画面、清批注层、回退观看目标。 */
  function cleanupRemoteShare(peerId: string): void {
    remoteScreens.delete(peerId)
    const member = members.get(peerId)
    if (member) member.sharing = false
    dropBoard(`screen:${peerId}`)
    if (watching.value === peerId) {
      const next = [...remoteScreens.keys()][0]
      watching.value = next ?? (sharing.value ? 'self' : null)
    }
  }

  // —— 屏幕共享 ——

  /**
   * 采集屏幕并共享。scope=all 给网络内所有节点；direct 只给指定节点。
   * 用户在选择器里取消不算错误。
   *
   * 采集之前先做可达性预检：一个能收到画面的节点都没有时直接拒绝，
   * 免得用户选完屏幕、授完权，才发现是白忙一场。
   */
  async function startShare(scope: SendScope = 'all', to?: string): Promise<boolean> {
    if (!mesh || status.value !== 'online') {
      lastError.value = '请先连接设备再共享屏幕'
      return false
    }
    const targets = mesh.screenTargets(scope, to)
    if (targets.ok.length === 0) {
      lastError.value = targets.blocked[0]?.reason ?? '当前没有可以接收画面的节点'
      return false
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return false
      lastError.value = `无法采集屏幕：${String(err)}`
      return false
    }
    localScreen.value = stream
    sharing.value = true
    sharingScope.value = { scope, to }
    mesh.startScreenShare(stream, scope, to)
    // 部分节点收不到：共享照常进行，但要说清楚少了谁。
    if (targets.blocked.length > 0) lastError.value = targets.blocked[0].reason
    // 浏览器原生「停止共享」按钮 → 轨道 ended → 同步收尾。
    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) videoTrack.onended = () => stopShare()
    if (watching.value === null) watching.value = 'self'
    return true
  }

  function stopShare(): void {
    if (!sharing.value) return
    mesh?.stopScreenShare()
    localScreen.value = null
    sharing.value = false
    dropBoard(`screen:${myId.value}`)
    if (watching.value === 'self') {
      watching.value = [...remoteScreens.keys()][0] ?? null
    }
  }

  // —— 白板 / 批注绘制（canvas 组件调用；按 board 路由单播/广播）——

  function beginStroke(
    board: string,
    mode: 'pen' | 'eraser',
    color: string,
    size: number,
    x: number,
    y: number,
  ): string {
    const id = `${myId.value || 'me'}-${strokeSeq++}-${Date.now().toString(36)}`
    const stroke: WbStroke = { id, color, size, mode, points: [x, y] }
    getBoard(board).push(stroke)
    liveStrokes.set(id, { board, stroke })
    const stack = myStrokes.get(board) ?? []
    stack.push(id)
    myStrokes.set(board, stack)
    sendDraw(board, { kind: 'draw-begin', board, id, color, size, mode, x, y })
    bumpBoard()
    return id
  }

  /** 追加一批采样点（组件按帧节流合并后调用）。 */
  function extendStroke(board: string, id: string, pts: number[]): void {
    const live = liveStrokes.get(id)
    if (!live || pts.length === 0) return
    live.stroke.points.push(...pts)
    sendDraw(board, { kind: 'draw-points', board, id, pts })
    bumpBoard()
  }

  function endStroke(board: string, id: string): void {
    liveStrokes.delete(id)
    sendDraw(board, { kind: 'draw-end', board, id })
  }

  /** 添加两角点形状（直线/箭头/矩形/椭圆）。 */
  function addLine(
    board: string,
    mode: 'line' | 'arrow' | 'rect' | 'ellipse',
    color: string,
    size: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): string {
    const id = `${myId.value || 'me'}-${strokeSeq++}-${Date.now().toString(36)}`
    const line: WbLine = { id, color, mode, size, x1, y1, x2, y2 }
    getBoard(board).push(line)
    const stack = myStrokes.get(board) ?? []
    stack.push(id)
    myStrokes.set(board, stack)
    sendDraw(board, { kind: 'draw-line', board, id, color, size, mode, x1, y1, x2, y2 })
    bumpBoard()
    return id
  }

  /** 添加折线（points 为扁平化归一化坐标，arrow 决定末段是否画箭头）。 */
  function addPolyline(
    board: string,
    color: string,
    size: number,
    points: number[],
    arrow: boolean,
  ): string {
    const id = `${myId.value || 'me'}-${strokeSeq++}-${Date.now().toString(36)}`
    const pl: WbPolyline = { id, color, mode: 'polyline', size, points: [...points], arrow }
    getBoard(board).push(pl)
    const stack = myStrokes.get(board) ?? []
    stack.push(id)
    myStrokes.set(board, stack)
    sendDraw(board, { kind: 'draw-polyline', board, id, color, size, points: [...points], arrow })
    bumpBoard()
    return id
  }

  /** 按 id 批量删除元素（对象橡皮 / 框选删除，可删他人元素）。 */
  function removeItems(board: string, ids: string[]): void {
    if (ids.length === 0) return
    const arr = boards.get(board)
    if (!arr) return
    const drop = new Set(ids)
    boards.set(
      board,
      arr.filter((s) => !drop.has(s.id)),
    )
    for (const id of ids) liveStrokes.delete(id)
    const stack = myStrokes.get(board)
    if (stack) myStrokes.set(board, stack.filter((id) => !drop.has(id)))
    sendDraw(board, { kind: 'draw-remove', board, ids })
    bumpBoard()
  }

  /** 添加文本。 */
  function addText(
    board: string,
    color: string,
    x: number,
    y: number,
    text: string,
    fontSize: number,
  ): string {
    const id = `${myId.value || 'me'}-${strokeSeq++}-${Date.now().toString(36)}`
    const textItem: WbText = { id, color, mode: 'text', x, y, text, fontSize }
    getBoard(board).push(textItem)
    const stack = myStrokes.get(board) ?? []
    stack.push(id)
    myStrokes.set(board, stack)
    sendDraw(board, { kind: 'draw-text', board, id, color, x, y, text, fontSize })
    bumpBoard()
    return id
  }

  /** 添加图片。 */
  function addImage(
    board: string,
    x: number,
    y: number,
    width: number,
    height: number,
    dataUrl: string,
  ): string {
    const id = `${myId.value || 'me'}-${strokeSeq++}-${Date.now().toString(36)}`
    const image: WbImage = { id, color: '#000', mode: 'image', x, y, width, height, dataUrl }
    getBoard(board).push(image)
    const stack = myStrokes.get(board) ?? []
    stack.push(id)
    myStrokes.set(board, stack)
    sendDraw(board, { kind: 'draw-image', board, id, x, y, width, height, dataUrl })
    bumpBoard()
    return id
  }

  /** 图片几何更新的网络限流时间戳（拖动中高频调用）。 */
  let lastImgUpdateSent = 0

  /** 更新图片几何（拖动/缩放/旋转）。flush=true 时强制发送（拖动结束）。 */
  function updateImage(
    board: string,
    id: string,
    patch: { x: number; y: number; width: number; height: number; rotation?: number },
    flush = false,
  ): void {
    const item = getBoard(board).find((i) => i.id === id)
    if (!item || item.mode !== 'image') return
    item.x = patch.x
    item.y = patch.y
    item.width = patch.width
    item.height = patch.height
    item.rotation = patch.rotation
    bumpBoard()
    const now = Date.now()
    if (flush || now - lastImgUpdateSent > 50) {
      lastImgUpdateSent = now
      sendDraw(board, { kind: 'draw-update', board, id, ...patch })
    }
  }

  /** 把单个元素整体平移（归一化增量）。 */
  function translateItem(it: WbItem, dx: number, dy: number): void {
    if (it.mode === 'pen' || it.mode === 'eraser' || it.mode === 'polyline') {
      const pts = it.points
      for (let i = 0; i + 1 < pts.length; i += 2) {
        pts[i] += dx
        pts[i + 1] += dy
      }
    } else if (it.mode === 'text' || it.mode === 'image') {
      it.x += dx
      it.y += dy
    } else if (
      it.mode === 'line' ||
      it.mode === 'arrow' ||
      it.mode === 'rect' ||
      it.mode === 'ellipse'
    ) {
      it.x1 += dx
      it.y1 += dy
      it.x2 += dx
      it.y2 += dy
    }
  }

  /** 框选拖动的网络累积增量（50ms 限流，flush 时清空）。 */
  let pendingMove: { board: string; ids: string[]; dx: number; dy: number } | null = null
  let lastMoveSent = 0

  /** 平移一组元素。flush=true 时强制发送累积增量（拖动结束）。 */
  function moveItems(board: string, ids: string[], dx: number, dy: number, flush = false): void {
    const arr = boards.get(board)
    if (!arr || ids.length === 0) return
    const keep = new Set(ids)
    for (const it of arr) {
      if (keep.has(it.id)) translateItem(it, dx, dy)
    }
    bumpBoard()
    if (pendingMove && pendingMove.board === board) {
      pendingMove.dx += dx
      pendingMove.dy += dy
    } else {
      pendingMove = { board, ids: [...ids], dx, dy }
    }
    const now = Date.now()
    if (flush || now - lastMoveSent > 50) {
      lastMoveSent = now
      if (pendingMove.dx !== 0 || pendingMove.dy !== 0) {
        sendDraw(board, {
          kind: 'draw-move',
          board,
          ids: pendingMove.ids,
          dx: pendingMove.dx,
          dy: pendingMove.dy,
        })
      }
      pendingMove = null
    }
  }

  /** 撤销本端在该画面的最后一个元素。 */
  function undoStroke(board: string): void {
    const stack = myStrokes.get(board)
    const id = stack?.pop()
    if (!id) return
    const arr = boards.get(board)
    if (arr) {
      boards.set(
        board,
        arr.filter((s) => s.id !== id),
      )
    }
    liveStrokes.delete(id)
    sendDraw(board, { kind: 'draw-remove', board, ids: [id] })
    bumpBoard()
  }

  /** 清空整个画面（对参与者生效）。 */
  function clearBoard(board: string): void {
    dropBoard(board)
    sendDraw(board, { kind: 'draw-clear', board })
  }

  // —— 远程指针 ——

  function sendPointer(board: string, x: number, y: number): void {
    sendDraw(board, { kind: 'ptr-move', board, x, y })
  }

  function sendClick(board: string, x: number, y: number): void {
    spawnClick(board, x, y, peerColor(myId.value))
    sendDraw(board, { kind: 'ptr-click', board, x, y })
  }

  function hidePointer(board: string): void {
    sendDraw(board, { kind: 'ptr-hide', board })
  }

  // —— 你画我猜（公共白板，出题人本地持词并裁决）——

  const amDrawer = computed(() => guess.active && guess.drawer === myId.value)

  /** 出题开新一轮：清空公共白板，广播提示；谜底只留在本地。 */
  function startGuessRound(word: string, hint?: string): void {
    const w = word.trim()
    if (!mesh || !w) return
    guess.round++
    guess.active = true
    guess.drawer = myId.value
    guess.word = w
    guess.hint = hint?.trim() || `${w.length} 个字`
    guess.tries = []
    guess.lastWord = ''
    guess.lastWinner = ''
    clearBoard('wb')
    mesh.broadcast({ kind: 'guess-start', round: guess.round, drawer: myId.value, hint: guess.hint })
    if (activeView.value !== 'board') setView('board')
    activeBoard.value = 'wb'
  }

  /** 猜词（广播给所有人；出题人收到后自动比对）。 */
  function submitGuess(text: string): void {
    const t = text.trim()
    if (!mesh || !t || !guess.active || amDrawer.value) return
    mesh.broadcast({ kind: 'guess-try', round: guess.round, text: t, ts: Date.now() })
    guess.tries.push({
      round: guess.round,
      from: myId.value,
      nick: myProfile.value.nick || '我',
      text: t,
      ts: Date.now(),
    })
  }

  /** 出题人裁决某次猜测为正确（自动比对不中时可手动判对）。 */
  function judgeCorrect(t: GuessTry): void {
    if (!mesh || !amDrawer.value || t.round !== guess.round) return
    const scores = { ...guess.scores }
    scores[t.from] = (scores[t.from] ?? 0) + 2
    scores[guess.drawer] = (scores[guess.drawer] ?? 0) + 1
    mesh.broadcast({
      kind: 'guess-correct',
      round: guess.round,
      winner: t.from,
      word: guess.word,
      scores,
    })
    settleGuessRound(t.from, guess.word, scores)
  }

  /** 出题人公布答案（无人猜中，跳过本轮）。 */
  function revealAnswer(): void {
    if (!mesh || !amDrawer.value) return
    mesh.broadcast({ kind: 'guess-reveal', round: guess.round, word: guess.word })
    settleGuessRound('', guess.word, guess.scores)
  }

  /** 结束整场游戏（清空计分板）。 */
  function endGuess(): void {
    mesh?.broadcast({ kind: 'guess-end' })
    resetGuess()
  }

  /** 一轮落定：记录答案与胜者，等待下一位出题。 */
  function settleGuessRound(winner: string, word: string, scores: Record<string, number>): void {
    guess.active = false
    guess.word = ''
    guess.lastWord = word
    guess.lastWinner = winner
    guess.scores = scores
    if (winner) {
      const t = [...guess.tries].reverse().find((x) => x.from === winner && x.round === guess.round)
      if (t) t.correct = true
    }
  }

  function resetGuess(): void {
    guess.active = false
    guess.round = 0
    guess.drawer = ''
    guess.hint = ''
    guess.word = ''
    guess.tries = []
    guess.scores = {}
    guess.lastWord = ''
    guess.lastWinner = ''
  }

  // —— 五子棋（一对一，两端镜像状态、各自校验）——

  function newGomokuGame(opponent: string, gameId: string, myColor: 1 | 2): GomokuGame {
    return {
      gameId,
      opponent,
      myColor,
      turn: 1,
      cells: new Array<number>(GOMOKU_SIZE * GOMOKU_SIZE).fill(0),
      moves: 0,
      state: myColor === 1 ? 'invite-out' : 'invite-in',
    }
  }

  /** 邀请对局：邀请方执黑先手。 */
  function inviteGomoku(peerId: string): void {
    if (!mesh) return
    const existing = gomoku.get(peerId)
    if (existing && existing.state !== 'over') return
    const gameId = genMsgId()
    if (!mesh.sendTo(peerId, { kind: 'gomoku-invite', gameId })) {
      lastError.value = '对方暂不可达，无法邀请对局'
      return
    }
    gomoku.set(peerId, newGomokuGame(peerId, gameId, 1))
    gomokuOpen.value = peerId
  }

  function respondGomoku(peerId: string, accept: boolean): void {
    const game = gomoku.get(peerId)
    if (!mesh || !game || game.state !== 'invite-in') return
    if (accept) {
      mesh.sendTo(peerId, { kind: 'gomoku-accept', gameId: game.gameId })
      game.state = 'active'
      gomokuOpen.value = peerId
    } else {
      mesh.sendTo(peerId, { kind: 'gomoku-decline', gameId: game.gameId })
      gomoku.delete(peerId)
    }
  }

  /** 落子（idx 为 15×15 展平下标）。 */
  function moveGomoku(peerId: string, idx: number): void {
    const game = gomoku.get(peerId)
    if (!mesh || !game || game.state !== 'active') return
    if (game.turn !== game.myColor || game.cells[idx] !== 0) return
    applyGomokuMove(game, idx, game.myColor)
    mesh.sendTo(peerId, {
      kind: 'gomoku-move',
      gameId: game.gameId,
      n: game.moves,
      x: idx % GOMOKU_SIZE,
      y: Math.floor(idx / GOMOKU_SIZE),
    })
  }

  function resignGomoku(peerId: string): void {
    const game = gomoku.get(peerId)
    if (!mesh || !game || game.state !== 'active') return
    mesh.sendTo(peerId, { kind: 'gomoku-resign', gameId: game.gameId })
    game.state = 'over'
    game.result = 'loss'
    game.reason = '你认输了'
  }

  /** 收起面板：撤回未被接受的邀请，或清掉终局记录。 */
  function closeGomoku(peerId: string): void {
    const game = gomoku.get(peerId)
    if (game && game.state === 'invite-out') {
      // 复用 decline 语义通知对方「邀请已撤回」。
      mesh?.sendTo(peerId, { kind: 'gomoku-decline', gameId: game.gameId })
      gomoku.delete(peerId)
    } else if (game && game.state === 'over') {
      gomoku.delete(peerId)
    }
    if (gomokuOpen.value === peerId) gomokuOpen.value = null
  }

  function applyGomokuMove(game: GomokuGame, idx: number, color: 1 | 2): void {
    game.cells[idx] = color
    game.moves++
    game.last = idx
    game.turn = color === 1 ? 2 : 1
    const line = gomokuWinLine(game.cells, idx)
    if (line) {
      game.state = 'over'
      game.winLine = line
      game.result = color === game.myColor ? 'win' : 'loss'
      game.reason = '五连珠'
    } else if (game.moves >= GOMOKU_SIZE * GOMOKU_SIZE) {
      game.state = 'over'
      game.result = 'draw'
      game.reason = '棋盘已满'
    }
  }

  /** 游戏消息统一入口（mesh 'game' 事件）。 */
  function handleGame(from: string, msg: GameMessage): void {
    switch (msg.kind) {
      case 'guess-start':
        guess.active = true
        guess.round = msg.round
        guess.drawer = msg.drawer
        guess.hint = msg.hint
        guess.word = ''
        guess.tries = []
        guess.lastWord = ''
        guess.lastWinner = ''
        if (activeView.value !== 'board') unseenBoard.value++
        notifyBackground('你画我猜', `${displayName(from)} 出题了，快来猜！`)
        break
      case 'guess-try': {
        if (!guess.active || msg.round !== guess.round) break
        const t: GuessTry = {
          round: msg.round,
          from,
          nick: displayName(from),
          text: msg.text,
          ts: msg.ts,
        }
        guess.tries.push(t)
        // 出题人自动裁决：归一化后精确命中即宣布猜中。
        if (amDrawer.value && normalizeGuess(msg.text) === normalizeGuess(guess.word)) {
          judgeCorrect(t)
        }
        break
      }
      case 'guess-correct':
        if (msg.round !== guess.round) break
        settleGuessRound(msg.winner, msg.word, msg.scores)
        break
      case 'guess-reveal':
        if (msg.round !== guess.round) break
        settleGuessRound('', msg.word, guess.scores)
        break
      case 'guess-end':
        resetGuess()
        break
      case 'gomoku-invite': {
        gomoku.set(from, { ...newGomokuGame(from, msg.gameId, 2), state: 'invite-in' })
        bumpUnread(from)
        notifyBackground('五子棋', `${displayName(from)} 邀请你对局`)
        break
      }
      case 'gomoku-accept': {
        const game = gomoku.get(from)
        if (game && game.gameId === msg.gameId && game.state === 'invite-out') {
          game.state = 'active'
          if (activeChannel.value !== from || activeView.value !== 'chat') bumpUnread(from)
        }
        break
      }
      case 'gomoku-decline': {
        const game = gomoku.get(from)
        if (game && game.gameId === msg.gameId && game.state !== 'active' && game.state !== 'over') {
          const wasInvited = game.state === 'invite-in'
          gomoku.delete(from)
          if (gomokuOpen.value === from) gomokuOpen.value = null
          lastError.value = wasInvited
            ? `${displayName(from)} 撤回了五子棋邀请`
            : `${displayName(from)} 婉拒了五子棋对局`
        }
        break
      }
      case 'gomoku-move': {
        const game = gomoku.get(from)
        if (!game || game.gameId !== msg.gameId || game.state !== 'active') break
        const idx = msg.y * GOMOKU_SIZE + msg.x
        const oppColor: 1 | 2 = game.myColor === 1 ? 2 : 1
        // control 有序可靠，n 不匹配说明状态漂移，忽略防御。
        if (msg.n !== game.moves + 1 || game.turn !== oppColor) break
        if (idx < 0 || idx >= game.cells.length || game.cells[idx] !== 0) break
        applyGomokuMove(game, idx, oppColor)
        if (activeChannel.value !== from || activeView.value !== 'chat') bumpUnread(from)
        break
      }
      case 'gomoku-resign': {
        const game = gomoku.get(from)
        if (game && game.gameId === msg.gameId && game.state === 'active') {
          game.state = 'over'
          game.result = 'win'
          game.reason = '对方认输'
        }
        break
      }
      // —— 游戏桌消息处理 ——
      case 'table-create': {
        const table = msg.table as GameTable
        if (table && table.tableId) {
          gameTables.set(table.tableId, table)
        }
        break
      }
      case 'table-join': {
        const table = gameTables.get(msg.tableId)
        if (table && !table.players.includes(from)) {
          table.players.push(from)
        }
        break
      }
      case 'table-spectate': {
        const table = gameTables.get(msg.tableId)
        if (table && !table.spectators.includes(from)) {
          table.spectators.push(from)
        }
        break
      }
      case 'table-leave': {
        const table = gameTables.get(msg.tableId)
        if (table) {
          table.players = table.players.filter(p => p !== from)
          table.spectators = table.spectators.filter(p => p !== from)
          // 如果桌主离开，转移给第一个玩家
          if (table.hostId === from && table.players.length > 0) {
            table.hostId = table.players[0]
          }
          // 如果桌子空了，删除
          if (table.players.length === 0 && table.spectators.length === 0) {
            gameTables.delete(msg.tableId)
          }
        }
        break
      }
      case 'table-start': {
        const table = gameTables.get(msg.tableId)
        if (table) {
          table.state = 'playing'
          table.startedAt = Date.now()
        }
        break
      }
      case 'table-sit': {
        const table = gameTables.get(msg.tableId)
        if (table) {
          table.spectators = table.spectators.filter(p => p !== from)
          if (!table.players.includes(from)) {
            table.players.push(from)
          }
        }
        break
      }
      case 'table-standup': {
        const table = gameTables.get(msg.tableId)
        if (table) {
          table.players = table.players.filter(p => p !== from)
          if (!table.spectators.includes(from)) {
            table.spectators.push(from)
          }
        }
        break
      }
      case 'table-invite': {
        // 收到邀请通知
        notifyBackground('游戏邀请', `${displayName(from)} 邀请你加入 ${msg.gameName}`)
        lastError.value = `${displayName(from)} 邀请你加入游戏桌`
        break
      }
      case 'game-move': {
        // 游戏动作，由具体游戏组件处理
        // 这里可以添加通用的同步逻辑
        break
      }
      case 'game-chat': {
        const chatMsg = msg.chatMsg as GameChatMessage
        if (chatMsg && msg.tableId) {
          const chats = gameChats.get(msg.tableId) || []
          chats.push(chatMsg)
          gameChats.set(msg.tableId, chats)
        }
        break
      }
      case 'mouse-pos': {
        const pos = msg.pos as MousePosition
        if (pos && msg.tableId) {
          const positions = gameMousePositions.get(msg.tableId) || []
          // 只保留最近的位置
          const filtered = positions.filter(p => p.peerId !== pos.peerId || Date.now() - p.ts < 5000)
          filtered.push(pos)
          gameMousePositions.set(msg.tableId, filtered)
        }
        break
      }
    }
  }

  /** 断开当前会话（不触发自动重新监听）。 */
  function teardown(): void {
    stopTalk()
    if (mesh) {
      mesh.leave()
      mesh = null
    }
    for (const [pid] of voiceEls) dropVoiceEl(pid)
    speaking.clear()
    resetGuess()
    gomoku.clear()
    gomokuOpen.value = null
    rtts.clear()
    for (const t of transfers.value) {
      if (t.state === 'active' || t.state === 'pending') {
        t.state = 'error'
        t.error = '连接已断开'
        t.finishedAt = Date.now()
      }
    }
    sendCancels.clear()
    for (const cancel of downloadCancels.values()) cancel()
    downloadCancels.clear()
    for (const item of shares.values()) {
      if (item.url) URL.revokeObjectURL(item.url)
    }
    shares.clear()
    peerLinks.clear()
    members.clear()
    unread.clear()
    activeChannel.value = 'all'
    // 屏幕共享与画板状态随会话销毁（换房间不携带旧内容）。
    sharing.value = false
    localScreen.value = null
    remoteScreens.clear()
    watching.value = null
    boards.clear()
    liveStrokes.clear()
    myStrokes.clear()
    pointers.clear()
    clicks.value = []
    activeBoard.value = 'wb'
    bumpBoard()
    myId.value = ''
    room.value = ''
    signalingState.value = 'idle'
    status.value = 'idle'
    // 清除持久化的房间信息
    sessionStorage.removeItem(SS_CURRENT_ROOM)
  }

  /** joinRoom 的结果：成功时附带服务端应答，失败时附带服务端错误码。 */
  type JoinOutcome =
    | { ok: true; peerCount: number; codeLen: number }
    | { ok: false; code?: string }

  /**
   * 加入指定房间（短码房或口令房）。已在线则先离开。
   * `listen` 表示以短码监听者身份声明房间所有权（撞码时服务端拒绝）。
   */
  async function joinRoom(roomName: string, listen = false): Promise<JoinOutcome> {
    lastError.value = null
    if (mesh) teardown()
    // 通常由用户点击触发，正是申请通知权限的合法时机（后台消息提醒用）。
    requestNotifyPermission()
    status.value = 'connecting'
    room.value = roomName
    try {
      mesh = createMesh(defaultSignalingUrl())
      const ack = await mesh.join(roomName, myProfile.value, listen)
      noteCodeLen(ack.codeLen)
      status.value = 'online'
      // 持久化当前房间信息，页面刷新后可恢复
      sessionStorage.setItem(SS_CURRENT_ROOM, roomName)
      return { ok: true, ...ack }
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err)
      teardown()
      return { ok: false, code: err instanceof JoinRejected ? err.code : undefined }
    }
  }

  /**
   * 打开「允许短码连我」时，进入自己短码的房间等待连入。
   * 短码撞车（生日碰撞）时服务端拒绝监听（code-taken），换码重试即可；
   * 若服务端按当前规模建议了更长的码且房里没人，主动升长换码。
   */
  async function listen(): Promise<void> {
    if (status.value !== 'idle') return
    let retries = 0
    while (retries < 3) {
      const res = await joinRoom(myCode.value, true)
      if (res.ok) {
        if (res.peerCount === 0 && myCode.value.length < res.codeLen) {
          // 升长不计入重试次数：这是主动换码，不是冲突。
          myCode.value = regenCode(res.codeLen)
          continue
        }
        return
      }
      if (res.code !== 'code-taken') return
      retries++
      myCode.value = regenCode()
    }
    lastError.value = '短码持续冲突，请稍后再试'
  }

  /** 用对方短码/口令直连。 */
  async function connectTo(code: string): Promise<boolean> {
    const target = code.trim()
    if (!target) return false
    if (target === myCode.value) {
      lastError.value = '这是你自己的短码，请输入对方的短码'
      return false
    }
    return (await joinRoom(target)).ok
  }

  /** 断开并（若开启）回到短码监听。 */
  async function disconnect(): Promise<void> {
    // 在自己短码房且对端仍在场时，直接重进会立刻被对方重连；
    // 换一个新短码保证“断开”语义成立（临时短码本就允许轮换）。
    const needNewCode = listening.value && peerCount.value > 0
    teardown()
    if (needNewCode) myCode.value = regenCode()
    if (allowIncoming.value) await listen()
  }

  function setAllowIncoming(v: boolean): void {
    allowIncoming.value = v
    localStorage.setItem(LS_ALLOW_INCOMING, v ? '1' : '0')
    if (v && status.value === 'idle') {
      void listen()
    } else if (!v && listening.value && peerCount.value === 0) {
      teardown()
    }
  }

  // —— 名片 ——

  function commitProfile(patch: Partial<Pick<Profile, 'nick' | 'avatar'>>): void {
    const next: Profile = {
      nick: patch.nick?.trim() || myProfile.value.nick,
      avatar: patch.avatar ?? myProfile.value.avatar,
      rev: myProfile.value.rev + 1,
    }
    myProfile.value = next
    saveProfile(next)
    localStorage.setItem(LS_DEVICE_NAME, next.nick)
    mesh?.setProfile(next)
  }

  function setNick(nick: string): void {
    if (!nick.trim()) return
    commitProfile({ nick })
  }

  function setAvatar(avatar: Avatar): void {
    commitProfile({ avatar })
  }

  async function setAvatarImage(file: File): Promise<void> {
    try {
      const dataUrl = await imageToAvatar(file)
      commitProfile({ avatar: { kind: 'image', value: dataUrl, color: '#7a8699' } })
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 换一个新短码；若正在监听则迁移到新短码房。 */
  async function regenerateCode(): Promise<void> {
    const wasListening = listening.value && peerCount.value === 0
    myCode.value = regenCode()
    if (wasListening) {
      teardown()
      await listen()
    }
  }

  /** 应用启动：处理 ?c= 直连参数，否则按设置进入监听。 */
  async function init(): Promise<void> {
    const params = new URLSearchParams(location.search)
    const code = params.get('c')
    if (code) {
      history.replaceState(null, '', location.pathname)
      if (code.trim() !== myCode.value) {
        await connectTo(code)
        return
      }
    }
    // 尝试恢复刷新前的房间。刷新前若在监听，存的就是自己的短码房，
    // 走 listen 以监听者身份重新声明所有权；connectTo 的自码校验只针对手动输入。
    const savedRoom = sessionStorage.getItem(SS_CURRENT_ROOM)
    if (savedRoom && savedRoom.trim()) {
      const target = savedRoom.trim()
      if (target === myCode.value) {
        await listen()
      } else {
        await joinRoom(target)
      }
      return
    }
    if (allowIncoming.value) await listen()
  }

  // —— 聊天 ——

  /** 发消息到当前频道（'all' 群发；否则私聊）。 */
  function sendChat(text: string, channel?: ChatChannel): void {
    const trimmed = text.trim()
    const ch = channel ?? activeChannel.value
    if (!trimmed || !mesh) return
    const msgId = genMsgId()
    if (ch === 'all') {
      mesh.sendChat(trimmed, msgId)
    } else if (!mesh.sendDm(ch, trimmed, msgId)) {
      lastError.value = '对方暂不可达，消息未送出'
      return
    }
    pushMessage({
      from: myId.value,
      fromNick: myProfile.value.nick || '我',
      msgId,
      text: trimmed,
      ts: Date.now(),
      self: true,
      channel: ch,
    })
  }

  /** 发送一条语音消息到当前频道（录音 blob → base64 经 control 直达）。 */
  async function sendVoiceNote(blob: Blob, durMs: number, channel?: ChatChannel): Promise<void> {
    const ch = channel ?? activeChannel.value
    if (!mesh || blob.size === 0) return
    if (blob.size > 1024 * 1024) {
      lastError.value = '录音过长，请控制在 60 秒内'
      return
    }
    const msgId = genMsgId()
    const data = await blobToDataURL(blob)
    const ok = mesh.sendVoiceNote({
      msgId,
      data,
      mime: blob.type || 'audio/webm',
      dur: durMs,
      ts: Date.now(),
      scope: ch === 'all' ? 'all' : 'dm',
      to: ch === 'all' ? undefined : ch,
    })
    if (!ok) {
      lastError.value = '对方暂不可达，语音未送出'
      return
    }
    pushMessage({
      from: myId.value,
      fromNick: myProfile.value.nick || '我',
      msgId,
      text: '',
      ts: Date.now(),
      self: true,
      channel: ch,
      voice: { url: URL.createObjectURL(blob), dur: durMs },
    })
  }

  // —— 实时对讲（按住说话，麦克风轨复用 PeerConnection）——

  async function startTalk(): Promise<boolean> {
    if (!mesh || status.value !== 'online' || talking.value) return false
    if (!capabilities.userMedia) {
      lastError.value = '当前环境无法使用麦克风（需 https 或 localhost）'
      return false
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      lastError.value = '无法访问麦克风（未授权或被占用）'
      return false
    }
    // 等待授权期间用户可能已松手/离线。
    if (!mesh || status.value !== 'online') {
      for (const t of stream.getTracks()) t.stop()
      return false
    }
    const { blocked } = mesh.startVoice(stream)
    talking.value = true
    if (blocked.length > 0) {
      lastError.value = `${blocked.map((p) => displayName(p)).join('、')} 走服务器中继，实时对讲听不到（可改发语音消息）`
    }
    return true
  }

  function stopTalk(): void {
    if (!talking.value) return
    mesh?.stopVoice()
    talking.value = false
  }

  /** 打开某个聊天频道（网络视图点「私聊」进来）。 */
  function openChat(channel: ChatChannel): void {
    activeChannel.value = channel
    unread.delete(channel)
    setView('chat')
  }

  // —— 文件：强制发送（推） ——

  /**
   * 强制发送：target 为 'all' 时发给所有已连接设备。
   * 同一对端内串行（避免通道交织），多对端之间并行。
   */
  function sendFiles(files: File[], target: 'all' | string = 'all'): void {
    const m = mesh
    if (!m || files.length === 0) return
    const targets =
      target === 'all' ? connectedPeers.value.map((p) => p.peerId) : [target]
    if (targets.length === 0) {
      lastError.value = '没有已连接的设备，无法发送'
      return
    }

    for (const pid of targets) {
      void (async () => {
        for (const file of files) {
          const handle = m.sendFileTo(pid, file)
          if (!handle) {
            transfers.value.unshift({
              id: `x${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
              direction: 'send',
              peerId: pid,
              peerNick: displayName(pid),
              name: file.name,
              size: file.size,
              bytes: 0,
              state: 'error',
              error: '对端通道未就绪',
              startedAt: Date.now(),
              finishedAt: Date.now(),
            })
            continue
          }
          transfers.value.unshift({
            id: handle.id,
            direction: 'send',
            peerId: pid,
            peerNick: displayName(pid),
            name: file.name,
            size: file.size,
            bytes: 0,
            state: 'active',
            startedAt: Date.now(),
          })
          sendCancels.set(handle.id, handle.cancel)
          try {
            await handle.done
            const t = findTransfer(handle.id)
            if (t) {
              t.bytes = t.size
              t.state = 'done'
              t.finishedAt = Date.now()
            }
          } catch (err) {
            const t = findTransfer(handle.id)
            if (t && t.state !== 'canceled' && t.state !== 'error') {
              const canceled = err instanceof Error && err.name === 'TransferCanceled'
              t.state = canceled ? 'canceled' : 'error'
              t.error = canceled ? '传输已取消' : String(err)
              t.finishedAt = Date.now()
            }
          } finally {
            sendCancels.delete(handle.id)
          }
        }
      })()
    }
  }

  // —— 文件：懒发送 + 多源下载（拉） ——

  /** 懒发送：只登记共享，不上传；对方点下载时才供块。图片附内联缩略图。 */
  async function shareFiles(files: File[], target: 'all' | string = 'all'): Promise<void> {
    const m = mesh
    if (!m || files.length === 0) return
    if (status.value !== 'online') {
      lastError.value = '请先连接设备再共享文件'
      return
    }
    for (const file of files) {
      const thumb = await makeImageThumb(file)
      const meta = m.shareFile(
        file,
        target === 'all' ? 'all' : 'direct',
        target === 'all' ? undefined : target,
        thumb,
      )
      const item = registerShare(meta, true)
      item.state = 'idle'
      // 在对应频道插入文件卡片消息（自己发的）。
      const channel: ChatChannel = target === 'all' ? 'all' : target
      pushMessage({
        from: myId.value,
        fromNick: myProfile.value.nick || '我',
        text: '',
        ts: meta.ts,
        self: true,
        channel,
        file: { fileId: meta.fileId, name: meta.name, size: meta.size, mime: meta.mime, thumb },
      })
    }
  }

  /** 统一入口：按模式分派（UI 上的「发送方式」选择）。 */
  function dispatchFiles(files: File[], mode: TransferMode, target: 'all' | string): void {
    if (mode === 'force') sendFiles(files, target)
    else void shareFiles(files, target)
  }

  /**
   * 分派一次拖拽/选择的完整载荷：零散文件按模式直发，文件夹先打包成
   * store 模式 zip（保留目录结构，接收端解压即得）再发。
   */
  async function dispatchPayload(
    payload: DroppedPayload,
    mode: TransferMode,
    target: 'all' | string,
  ): Promise<void> {
    if (payload.files.length > 0) dispatchFiles(payload.files, mode, target)
    for (const folder of payload.folders) {
      packing.value++
      try {
        const zipped = await zipFolder(folder.name, folder.entries)
        dispatchFiles([zipped], mode, target)
      } catch (err) {
        lastError.value = err instanceof Error ? err.message : String(err)
      } finally {
        packing.value--
      }
    }
  }

  /** 撤销本端共享。 */
  function revokeShare(fileId: string): void {
    mesh?.revokeShare(fileId)
    const item = shares.get(fileId)
    if (item?.url) URL.revokeObjectURL(item.url)
    shares.delete(fileId)
  }

  /** 从多个源并行下载一个共享文件。 */
  function downloadShare(fileId: string): void {
    const m = mesh
    const item = shares.get(fileId)
    if (!m || !item || item.local || item.state === 'downloading') return
    item.state = 'downloading'
    item.bytes = 0
    item.error = undefined
    const handle = m.downloadShare(fileId, {
      onProgress: (bytes) => {
        item.bytes = bytes
      },
      onDone: (blob) => {
        downloadCancels.delete(fileId)
        item.bytes = item.size
        item.state = 'done'
        item.url = URL.createObjectURL(blob)
        triggerDownload(item.name, item.url)
      },
      onError: (reason) => {
        downloadCancels.delete(fileId)
        if (item.state === 'downloading') {
          item.state = 'error'
          item.error = reason
        }
      },
    })
    if (!handle) {
      item.state = 'error'
      item.error = '无法开始下载'
      return
    }
    downloadCancels.set(fileId, handle.cancel)
  }

  function cancelDownload(fileId: string): void {
    downloadCancels.get(fileId)?.()
    downloadCancels.delete(fileId)
    const item = shares.get(fileId)
    if (item && item.state === 'downloading') {
      item.state = 'idle'
      item.bytes = 0
      item.sources = 0
    }
  }

  function cancelTransfer(id: string): void {
    const t = findTransfer(id)
    if (!t || (t.state !== 'active' && t.state !== 'pending')) return
    if (t.direction === 'send') {
      sendCancels.get(id)?.()
    } else {
      mesh?.cancelReceive(id)
    }
  }

  function clearFinishedTransfers(): void {
    for (const t of transfers.value) {
      if (t.url && t.state !== 'active' && t.state !== 'pending') URL.revokeObjectURL(t.url)
    }
    transfers.value = transfers.value.filter(
      (t) => t.state === 'active' || t.state === 'pending',
    )
  }

  function setTheme(t: Theme): void {
    theme.value = t
    applyTheme(t)
    persistTheme(t)
  }

  function toggleTheme(): void {
    setTheme(theme.value === 'daylight' ? 'midnight' : 'daylight')
  }

  function setView(v: View): void {
    activeView.value = v
    if (v === 'chat') unread.delete(activeChannel.value)
    if (v === 'receive') unseenRecv.value = 0
    if (v === 'screen') unseenShare.value = 0
    if (v === 'board') unseenBoard.value = 0
  }

  function markVerified(peerId: string): void {
    const member = members.get(peerId)
    if (member) member.verified = true
  }

  // —— 网络视图的动作分发（点节点头像/中心节点触发） ——

  function actionSendFile(target: 'all' | string): void {
    sendTarget.value = target
    setView('send')
  }

  function actionBoard(target: 'all' | string): void {
    activeBoard.value = target === 'all' ? 'wb' : dmBoardId(target)
    setView('board')
  }

  async function actionShareScreen(target: 'all' | string): Promise<void> {
    setView('screen')
    if (!sharing.value) {
      await startShare(target === 'all' ? 'all' : 'direct', target === 'all' ? undefined : target)
    }
  }

  /** 网络视图「五子棋」入口：切到与该节点的私聊，有对局就开棋盘，否则发邀请。 */
  function actionGomoku(peerId: string): void {
    openChat(peerId)
    if (gomoku.has(peerId)) {
      gomokuOpen.value = peerId
    } else {
      inviteGomoku(peerId)
    }
  }

  /** 你画我猜入口信号：白板页消费它弹出出题面板（挂载时与变化时都检查）。 */
  const guessSetupReq = ref(false)

  /** 网络视图「你画我猜」入口：切到公共白板并直接弹出出题面板。 */
  function actionGuess(): void {
    activeBoard.value = 'wb'
    setView('board')
    guessSetupReq.value = true
  }

  // —— 游戏桌管理 ——

  function createGameTable(gameType: GameType, isPublic: boolean): void {
    const tableId = generateTableId()
    const table: GameTable = {
      tableId,
      gameType,
      hostId: myId.value,
      state: 'waiting',
      visibility: isPublic ? 'public' : 'private',
      players: [myId.value],
      spectators: [],
      config: {},
    }
    gameTables.set(tableId, table)
    currentTableId.value = tableId

    // 广播创建游戏桌消息
    mesh?.broadcast({
      kind: 'table-create',
      tableId,
      table,
    })

    // 切换到游戏视图
    setView('games')
  }

  function joinGameTable(tableId: string, asSpectator: boolean): void {
    const table = gameTables.get(tableId)
    if (!table) return

    if (asSpectator) {
      if (!table.spectators.includes(myId.value)) {
        table.spectators.push(myId.value)
      }
    } else {
      if (!table.players.includes(myId.value)) {
        table.players.push(myId.value)
      }
    }

    currentTableId.value = tableId

    // 广播加入消息
    mesh?.broadcast({
      kind: asSpectator ? 'table-spectate' : 'table-join',
      tableId,
    })

    setView('games')
  }

  function leaveGameTable(): void {
    if (!currentTableId.value) return

    const table = gameTables.get(currentTableId.value)
    if (!table) return

    // 移除自己
    table.players = table.players.filter((p) => p !== myId.value)
    table.spectators = table.spectators.filter((p) => p !== myId.value)

    // 广播离开消息
    mesh?.broadcast({
      kind: 'table-leave',
      tableId: currentTableId.value,
    })

    // 如果是桌主且桌上还有人，转移桌主
    if (table.hostId === myId.value && table.players.length > 0) {
      table.hostId = table.players[0]
    }

    // 如果桌上没人了，删除游戏桌
    if (table.players.length === 0 && table.spectators.length === 0) {
      gameTables.delete(currentTableId.value)
    }

    currentTableId.value = null
    setView('network')
  }

  function startGameTable(tableId: string): void {
    const table = gameTables.get(tableId)
    if (!table || table.hostId !== myId.value || table.state !== 'waiting') return

    // 检查人数是否满足
    const meta = getGameMeta(table.gameType)
    if (!meta || !canStartGame(table.gameType, table.players.length)) {
      lastError.value = `人数不足，需要 ${meta?.playerCount} 人`
      return
    }

    table.state = 'playing'
    table.startedAt = Date.now()

    // 广播开始游戏消息
    mesh?.broadcast({
      kind: 'table-start',
      tableId,
    })
  }

  function sendGameMove(tableId: string, moveData: unknown): void {
    mesh?.broadcast({
      kind: 'game-move',
      tableId,
      moveData,
    })
  }

  function sendGameChat(tableId: string, text: string): void {
    const table = gameTables.get(tableId)
    if (!table) return

    const role: PlayerRole = table.players.includes(myId.value) ? 'player' : 'spectator'

    const msg: GameChatMessage = {
      from: myId.value,
      text,
      ts: Date.now(),
      role,
    }

    // 添加到本地聊天记录
    const chats = gameChats.get(tableId) || []
    chats.push(msg)
    gameChats.set(tableId, chats)

    // 广播聊天消息
    mesh?.broadcast({
      kind: 'game-chat',
      tableId,
      chatMsg: msg,
    })
  }

  function sendGameMousePos(tableId: string, x: number, y: number): void {
    const pos: MousePosition = {
      peerId: myId.value,
      x,
      y,
      ts: Date.now(),
    }

    mesh?.broadcast({
      kind: 'mouse-pos',
      tableId,
      pos,
    })
  }

  function sitDownAtTable(tableId: string): void {
    const table = gameTables.get(tableId)
    if (!table || table.state !== 'waiting') return

    // 从旁观者移到玩家
    table.spectators = table.spectators.filter((p) => p !== myId.value)
    if (!table.players.includes(myId.value)) {
      table.players.push(myId.value)
    }

    // 广播坐下消息
    mesh?.broadcast({
      kind: 'table-sit',
      tableId,
    })
  }

  function standUpFromTable(tableId: string): void {
    const table = gameTables.get(tableId)
    if (!table || table.state !== 'waiting') return

    // 从玩家移到旁观者
    table.players = table.players.filter((p) => p !== myId.value)
    if (!table.spectators.includes(myId.value)) {
      table.spectators.push(myId.value)
    }

    // 广播站起消息
    mesh?.broadcast({
      kind: 'table-standup',
      tableId,
    })
  }

  function inviteToTable(tableId: string, peerId: string): void {
    const table = gameTables.get(tableId)
    if (!table) return

    // 发送邀请消息给指定玩家
    mesh?.sendTo(peerId, {
      kind: 'table-invite',
      tableId,
      gameName: getGameMeta(table.gameType)?.name || '游戏',
    })
  }

  return {
    capabilities,
    status,
    myId,
    room,
    myCode,
    myProfile,
    allowIncoming,
    signalingState,
    lastError,
    members,
    messages,
    transfers,
    shares,
    shareList,
    peerLinks,
    rtts,
    talking,
    speaking,
    guess,
    amDrawer,
    gomoku,
    gomokuOpen,
    gameTables,
    currentTableId,
    gameChats,
    gameMousePositions,
    packing,
    theme,
    activeView,
    activeChannel,
    unread,
    unreadTotal,
    unseenRecv,
    unseenShare,
    unseenBoard,
    sendTarget,
    memberList,
    peerCount,
    connectedPeers,
    sharers,
    screenReach,
    listening,
    shareLink,
    sharing,
    sharingScope,
    localScreen,
    remoteScreens,
    watching,
    boardRev,
    activeBoard,
    pointers,
    clicks,
    displayName,
    dmBoardId,
    init,
    listen,
    connectTo,
    disconnect,
    setAllowIncoming,
    setNick,
    setAvatar,
    setAvatarImage,
    regenerateCode,
    sendChat,
    sendVoiceNote,
    toggleReact,
    startTalk,
    stopTalk,
    openChat,
    sendFiles,
    shareFiles,
    dispatchFiles,
    dispatchPayload,
    startGuessRound,
    submitGuess,
    judgeCorrect,
    revealAnswer,
    endGuess,
    inviteGomoku,
    respondGomoku,
    moveGomoku,
    resignGomoku,
    closeGomoku,
    revokeShare,
    downloadShare,
    cancelDownload,
    cancelTransfer,
    clearFinishedTransfers,
    setTheme,
    toggleTheme,
    setView,
    markVerified,
    startShare,
    stopShare,
    getBoard,
    beginStroke,
    extendStroke,
    endStroke,
    addLine,
    addPolyline,
    addText,
    addImage,
    updateImage,
    moveItems,
    removeItems,
    undoStroke,
    clearBoard,
    sendPointer,
    sendClick,
    hidePointer,
    actionSendFile,
    actionBoard,
    actionShareScreen,
    actionGomoku,
    actionGuess,
    guessSetupReq,
    createGameTable,
    joinGameTable,
    leaveGameTable,
    startGameTable,
    sendGameMove,
    sendGameChat,
    sendGameMousePos,
    sitDownAtTable,
    standUpFromTable,
    inviteToTable,
  }
})
