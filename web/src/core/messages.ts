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
}

/** 画笔模式：普通笔、橡皮、直线、箭头、折线、文本、图片、框选。 */
export type DrawMode =
  | 'pen'
  | 'eraser'
  | 'line'
  | 'arrow'
  | 'polyline'
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
 * 直线/箭头元素。
 */
export interface WbLine extends WbElement {
  mode: 'line' | 'arrow'
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
 * 图片元素。
 */
export interface WbImage extends WbElement {
  mode: 'image'
  x: number
  y: number
  width: number
  height: number
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
  /** 聊天。scope=all 为群聊；dm 为一对一私聊（只发给该对端）。 */
  | { kind: 'chat'; text: string; ts: number; scope: 'all' | 'dm' }
  /** 名片同步（通道就绪时互发一次，之后变更即广播）。 */
  | { kind: 'profile'; profile: Profile }
  /** 请求对方补发名片（本端 rev 落后或首次连接时）。 */
  | { kind: 'profile-req' }
  /** 本端视角的邻接表，用于网络视图画出「节点—节点」的真实连通性。 */
  | { kind: 'link-state'; links: { peerId: string; state: string }[] }
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
  /** 本端开始/停止屏幕共享（媒体轨随重协商到达，此消息驱动 UI 状态）。 */
  | { kind: 'screen-start'; scope: SendScope }
  | { kind: 'screen-stop' }
  // —— 绘制（白板 / 屏幕批注共用）——
  | { kind: 'draw-begin'; board: BoardId; id: string; color: string; size: number; mode: 'pen' | 'eraser'; x: number; y: number }
  /** 追加一批采样点（扁平化 x,y 序列，发送端按 ~25fps 批量）。 */
  | { kind: 'draw-points'; board: BoardId; id: string; pts: number[] }
  | { kind: 'draw-end'; board: BoardId; id: string }
  /** 添加直线/箭头元素。 */
  | { kind: 'draw-line'; board: BoardId; id: string; color: string; size: number; mode: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number }
  /** 添加折线元素。 */
  | { kind: 'draw-polyline'; board: BoardId; id: string; color: string; size: number; points: number[]; arrow?: boolean }
  /** 添加文本元素。 */
  | { kind: 'draw-text'; board: BoardId; id: string; color: string; x: number; y: number; text: string; fontSize: number }
  /** 添加图片元素。 */
  | { kind: 'draw-image'; board: BoardId; id: string; x: number; y: number; width: number; height: number; dataUrl: string }
  /** 撤销：按 id 移除若干元素（仅撤自己画的）。 */
  | { kind: 'draw-remove'; board: BoardId; ids: string[] }
  | { kind: 'draw-clear'; board: BoardId }
  /** 全量状态同步（发给新入房的对端，接收方按 id 去重合并）。 */
  | { kind: 'draw-state'; board: BoardId; items: WbItem[] }
  // —— 远程指针（白板成员光标 / 屏幕共享「激光笔」）——
  | { kind: 'ptr-move'; board: BoardId; x: number; y: number }
  | { kind: 'ptr-click'; board: BoardId; x: number; y: number }
  | { kind: 'ptr-hide'; board: BoardId }
