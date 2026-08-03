// P2P control 通道上的应用层消息（与信令协议无关，端到端直传）。
// 保持可扩展的判别式联合：新增能力各自加 kind。

/** 一次「强制发送」传输的元信息（control 通道先行，数据走独立 file-<id> 通道）。 */
export interface FileOffer {
  id: string
  name: string
  size: number
  mime: string
  ts: number
}

/** 发送模式：force=立刻推送；lazy=挂到共享目录，等对方下载时才上传。 */
export type TransferMode = 'force' | 'lazy'

/** 投递范围：all=网络内所有节点（广播）；direct=指定节点（单播）。 */
export type SendScope = 'all' | 'direct'

/** 节点头像：emoji（带底色）或用户上传的小图 dataURL。 */
export interface Avatar {
  kind: 'emoji' | 'image'
  value: string
  color: string
}

/** 节点名片。rev 递增，晚到的旧版本不覆盖新值。 */
export interface Profile {
  nick: string
  avatar: Avatar
  rev: number
  /**
   * 本端能否解码中继路径的屏幕画面（WebCodecs `VideoDecoder`）。
   *
   * 通告它是为了让**发起端**在开采集器之前就知道对方看不看得了：中继路径的
   * 屏幕共享要求接收端能解码，而非安全上下文（明文 http）下 WebCodecs 不可用。
   * 缺省视为 true——老版本不带此字段，按「能解码」处理可保持既有行为，
   * 真解不了时接收端仍有兜底提示。
   */
  screenDecode?: boolean
}

/**
 * 共享文件目录项。懒发送与强制发送都会登记，供网络视图展示「谁有什么」，
 * 并作为分块拉取（多源下载）的寻址依据。
 */
export interface SharedFileMeta {
  fileId: string
  name: string
  size: number
  mime: string
  /** 分块尺寸（字节），两端必须一致才能按 index 寻址。 */
  chunkSize: number
  /** 分块总数 = ceil(size / chunkSize)。 */
  chunks: number
  ts: number
  /** 首次发起共享的节点（UI 展示来源，非唯一数据源）。 */
  owner: string
  mode: TransferMode
  scope: SendScope
  /** 图片共享的内联缩略图（小尺寸 dataURL，聊天气泡预览用）。 */
  thumb?: string
}

/** 画笔模式：普通笔、橡皮、直线、箭头、折线、矩形、椭圆、文本、图片、框选。 */
export type DrawMode =
  | 'pen'
  | 'eraser'
  | 'line'
  | 'arrow'
  | 'polyline'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'image'
  | 'select'

/**
 * 白板绘制元素基础接口。
 */
export interface WbElement {
  id: string
  color: string
  mode: DrawMode
}

/**
 * 笔画元素（pen/eraser）。坐标归一化到 [0,1]，points 为扁平化的 [x0,y0,x1,y1,…]。
 * size 是逻辑宽 1280 下的像素线宽，渲染时按实际画布宽度等比缩放。
 */
export interface WbStroke extends WbElement {
  mode: 'pen' | 'eraser'
  size: number
  points: number[]
}

/**
 * 两角点形状元素：直线/箭头按端点连线，矩形/椭圆按对角框线。
 */
export interface WbLine extends WbElement {
  mode: 'line' | 'arrow' | 'rect' | 'ellipse'
  size: number
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 折线元素。points 为扁平化的 [x0,y0,x1,y1,…]，arrow=true 时在末段画箭头。
 */
export interface WbPolyline extends WbElement {
  mode: 'polyline'
  size: number
  points: number[]
  arrow?: boolean
}

/**
 * 文本元素。
 */
export interface WbText extends WbElement {
  mode: 'text'
  x: number
  y: number
  text: string
  fontSize: number
}

/**
 * 图片元素。rotation 为绕中心的弧度（像素空间），缺省 0。
 */
export interface WbImage extends WbElement {
  mode: 'image'
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  dataUrl: string
}

/**
 * 所有白板元素的联合类型。
 */
export type WbItem = WbStroke | WbLine | WbPolyline | WbText | WbImage

/**
 * 画面（board）寻址：
 *   - `wb`             全网白板（广播）
 *   - `wb:<a>~<b>`     两节点私有白板（peerId 字典序拼接，只发给对方）
 *   - `screen:<peerId>` 叠加在该对端屏幕共享画面上的批注层
 */
export type BoardId = string

export type ControlMessage =
  /** 聊天。scope=all 为群聊；dm 为一对一私聊（只发给该对端）。msgId 全网唯一，表情回应据此寻址。 */
  | { kind: 'chat'; msgId?: string; text: string; ts: number; scope: 'all' | 'dm' }
  /** 对某条消息的表情回应（按 msgId 寻址；op=remove 撤销自己的回应）。 */
  | { kind: 'react'; msgId: string; emoji: string; op: 'add' | 'remove'; scope: 'all' | 'dm' }
  /**
   * 语音消息：录音编码为 base64 随控制通道直达（时长上限约 60s）。
   * 单条 control 消息受 SCTP maxMessageSize 约束（跨浏览器保守值 ~256KB），
   * 长录音按 part/parts 分片发送，接收端按 msgId 重组（control 有序可靠，
   * 分片天然按序到达）。不带 part 字段 = 单片。
   */
  | { kind: 'voice-note'; msgId: string; scope: 'all' | 'dm'; data: string; mime: string; dur: number; ts: number; part?: number; parts?: number }
  // —— RTT 探测（网络视图连线延迟）——
  | { kind: 'ping'; seq: number }
  | { kind: 'pong'; seq: number }
  /** 名片同步（通道就绪时互发一次，之后变更即广播）。 */
  | { kind: 'profile'; profile: Profile }
  /** 请求对方补发名片（本端 rev 落后或首次连接时）。 */
  | { kind: 'profile-req' }
  /** 本端视角的邻接表，用于网络视图画出「节点—节点」的真实连通性（附实测 RTT）。 */
  | { kind: 'link-state'; links: { peerId: string; state: string; rtt?: number }[] }
  // —— 强制发送（推）——
  | ({ kind: 'file-offer' } & FileOffer)
  /** 任一端取消/拒绝传输（含发送端中止），对端据此停止并清理。 */
  | { kind: 'file-cancel'; id: string; reason?: string }
  // —— 懒发送 / 多源下载（拉）——
  /** 新增一个共享文件（懒发送的核心：只登记，不上传）。 */
  | { kind: 'share-offer'; file: SharedFileMeta }
  /** 通道就绪时的目录全量同步。 */
  | { kind: 'share-list'; files: SharedFileMeta[] }
  /** 取消共享（对端从可下载列表移除）。 */
  | { kind: 'share-revoke'; fileId: string }
  /** 声明本端持有哪些分块：full=整份；bits=base64 位图。 */
  | { kind: 'have'; fileId: string; full?: boolean; bits?: string }
  /** 请求对端汇报某文件的持有情况（开始下载前的源发现）。 */
  | { kind: 'have-req'; fileId: string }
  /** 请求一个分块；数据走 swarm 二进制通道，以 reqId 关联。 */
  | { kind: 'chunk-req'; reqId: number; fileId: string; index: number }
  /** 无法提供该分块（已取消共享/尚未持有）。 */
  | { kind: 'chunk-nak'; reqId: number; reason: string }
  // —— 屏幕共享 ——
  /**
   * 本端开始/停止屏幕共享，此消息驱动对端 UI 状态。
   * via 标明画面走哪条路：
   *   track  = WebRTC 原生媒体轨（随重协商到达，画质最好、带音频）；
   *   codec  = 该对端已降级为中继，画面由 WebCodecs 自编码后经**每对**中继通道到达（无音频）；
   *   fanout = 大房间自适应组网，画面 WebCodecs 自编码后用群密钥加密、经服务器**扇出**到全房间
   *            （发送端单次上行，见 fanout.ts / ARCHITECTURE.md 路线乙）。
   */
  | { kind: 'screen-start'; scope: SendScope; via?: 'track' | 'codec' | 'fanout' }
  | { kind: 'screen-stop' }
  // —— 实时对讲（麦克风）——
  /**
   * 本端开麦。via 标明语音走哪条路：
   *   track  = WebRTC 原生音频轨；streamId 供对端把到达的媒体流识别为语音（区别于屏幕共享）；
   *   fanout = 大房间自适应组网，麦克风用 Opus 自编码、群密钥加密后经服务器扇出（见 voicecodec.ts）。
   * 缺省视为 track（兼容旧版）。
   */
  | { kind: 'voice-start'; streamId?: string; via?: 'track' | 'fanout' }
  | { kind: 'voice-stop' }
  // —— 媒体群密钥（路线乙）——
  /**
   * 发送端把本人的媒体群密钥（32 字节，base64）经**每对加密的 control 通道**发给某位观众。
   * 服务器扇出的是用此密钥加密的密文，因此密钥绝不能过服务器明文——只走点对点 control。
   * 屏幕与语音复用同一把发送端密钥（帧内 kind 区分）。
   */
  | { kind: 'media-key'; key: string }
  // —— 绘制（白板 / 屏幕批注共用）——
  | { kind: 'draw-begin'; board: BoardId; id: string; color: string; size: number; mode: 'pen' | 'eraser'; x: number; y: number }
  /** 追加一批采样点（扁平化 x,y 序列，发送端按 ~25fps 批量）。 */
  | { kind: 'draw-points'; board: BoardId; id: string; pts: number[] }
  | { kind: 'draw-end'; board: BoardId; id: string }
  /** 添加两角点形状元素（直线/箭头/矩形/椭圆）。 */
  | { kind: 'draw-line'; board: BoardId; id: string; color: string; size: number; mode: 'line' | 'arrow' | 'rect' | 'ellipse'; x1: number; y1: number; x2: number; y2: number }
  /** 添加折线元素。 */
  | { kind: 'draw-polyline'; board: BoardId; id: string; color: string; size: number; points: number[]; arrow?: boolean }
  /** 添加文本元素。 */
  | { kind: 'draw-text'; board: BoardId; id: string; color: string; x: number; y: number; text: string; fontSize: number }
  /** 添加图片元素。 */
  | { kind: 'draw-image'; board: BoardId; id: string; x: number; y: number; width: number; height: number; dataUrl: string }
  /** 更新既有图片元素的几何（拖动/缩放/旋转）。 */
  | { kind: 'draw-update'; board: BoardId; id: string; x: number; y: number; width: number; height: number; rotation?: number }
  /** 平移一组元素（框选拖动），dx/dy 为归一化增量。 */
  | { kind: 'draw-move'; board: BoardId; ids: string[]; dx: number; dy: number }
  /** 撤销：按 id 移除若干元素（仅撤自己画的）。 */
  | { kind: 'draw-remove'; board: BoardId; ids: string[] }
  | { kind: 'draw-clear'; board: BoardId }
  /** 全量状态同步（发给新入房的对端，接收方按 id 去重合并）。 */
  | { kind: 'draw-state'; board: BoardId; items: WbItem[] }
  // —— 远程指针（白板成员光标 / 屏幕共享「激光笔」）——
  | { kind: 'ptr-move'; board: BoardId; x: number; y: number }
  | { kind: 'ptr-click'; board: BoardId; x: number; y: number }
  | { kind: 'ptr-hide'; board: BoardId }
  // —— 你画我猜（公共白板游戏模式；出题人本地持词，猜中由出题人裁决）——
  /** 出题人开启一轮：hint 为提示（如字数），词只在出题人本地。 */
  | { kind: 'guess-start'; round: number; drawer: string; hint: string }
  /** 某人提交一次猜测（广播，所有人可见）。 */
  | { kind: 'guess-try'; round: number; text: string; ts: number }
  /** 出题人裁决猜中：公布答案与最新积分表。 */
  | { kind: 'guess-correct'; round: number; winner: string; word: string; scores: Record<string, number> }
  /** 出题人主动公布答案（无人猜中跳过本轮）。 */
  | { kind: 'guess-reveal'; round: number; word: string }
  | { kind: 'guess-end' }
  // —— 五子棋（一对一私聊对局）——
  | { kind: 'gomoku-invite'; gameId: string }
  | { kind: 'gomoku-accept'; gameId: string }
  | { kind: 'gomoku-decline'; gameId: string }
  /** 落子：n 为手数（从 1 起），用于丢包/乱序防御（control 有序，通常一致）。 */
  | { kind: 'gomoku-move'; gameId: string; n: number; x: number; y: number }
  | { kind: 'gomoku-resign'; gameId: string }
  // —— 游戏桌系统（支持多种游戏、旁观模式等）——
  | { kind: 'table-create'; tableId: string; table: unknown }
  | { kind: 'table-join'; tableId: string }
  | { kind: 'table-spectate'; tableId: string }
  | { kind: 'table-leave'; tableId: string }
  | { kind: 'table-start'; tableId: string }
  | { kind: 'table-sit'; tableId: string }
  | { kind: 'table-standup'; tableId: string }
  | { kind: 'table-invite'; tableId: string; gameName: string }
  | { kind: 'game-move'; tableId: string; moveData: unknown }
  | { kind: 'game-chat'; tableId: string; chatMsg: unknown }
  | { kind: 'game-config-propose'; tableId: string; proposal: unknown }
  | { kind: 'game-config-accept'; tableId: string }
  | { kind: 'mouse-pos'; tableId: string; pos: unknown }
  // —— 匹配系统 ——
  | { kind: 'match-request'; gameType: string }
  | { kind: 'match-cancel'; gameType: string }
  | { kind: 'match-found'; tableId: string; tableNumber?: string; gameType: string }
  // —— 邀请系统 ——
  | { kind: 'invite-send'; invite: unknown }
  | { kind: 'invite-accept'; inviteId: string }
  | { kind: 'invite-decline'; inviteId: string }
