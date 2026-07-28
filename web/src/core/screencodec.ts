// 中继路径上的屏幕共享：用 WebCodecs 自己编解码，绕开浏览器内部的 SRTP 栈。
//
// 背景：WebRTC 的媒体轨（getDisplayMedia → addTrack）由浏览器内部收发，JS 拿不到
// 编码帧，因此**无法**经应用层中继转发。但 WebCodecs 给了另一条路——自己把画面
// 编成 EncodedVideoChunk，这些字节就在 JS 手里，能塞进已有的加密中继通道；对端
// 解码后画到 canvas，再用 canvas.captureStream() 变回一条真正的 MediaStream，
// 于是上层（screen-stream 事件、<video srcObject>、批注层坐标）一行都不用改。
//
// 与 WebRTC 媒体轨的差异，必须如实告知用户：
//   - 只传视频，不传音频（音频要另起 Opus 编解码 + 播放时钟同步，暂不做）；
//   - 没有 WebRTC 的拥塞控制，这里只按「中继积压」做粗粒度丢帧 + 固定码率；
//   - 需要安全上下文（VideoEncoder 与 crypto.subtle 一样在明文 http 下不存在）。
// 有 TURN（--stun-turn）时仍走原生媒体轨，本模块只在降级为中继的对端上启用。
//
// 线格式（一个包 = 中继 KIND_SCREEN 帧的明文负载）：
//   [0]      版本 = 1
//   [1]      类型：0=解码器配置(JSON) 1=编码帧
//   类型 0   [2..]  UTF-8 JSON（VideoDecoderConfig，description 以 base64 承载）
//   类型 1   [2]    标志位：bit0=关键帧 bit1=后面还有分片
//            [3..11) Float64BE 时间戳（微秒）
//            [11..]  编码字节（超过分片上限时切成多包，靠中继的有序可靠重组）

/** 编码目标宽度上限：屏幕内容缩到这个宽度足够看清文字，又能压住码率。 */
const MAX_WIDTH = 1600
/** 目标帧率。屏幕内容降帧率的画质损失远小于降分辨率。 */
const TARGET_FPS = 15
const TARGET_BITRATE = 1_800_000
/** 周期性关键帧：给中途切过来观看的人一个恢复点。 */
const KEYFRAME_INTERVAL_MS = 4_000

/**
 * 单个分片的负载上限。中继单帧明文上限 192KiB，这里留足头部与 GCM 余量。
 * 关键帧经常突破 100KiB，所以分片不是可选项。
 */
const MAX_FRAGMENT = 128 * 1024

/** 中继积压超过此值就丢帧——宁可掉帧也不让屏幕流把文件传输和聊天挤死。 */
const BACKPRESSURE_HIGH = 2 * 1024 * 1024

/** 编码器排队超过此数说明编码跟不上采集，丢掉新帧而不是堆积延迟。 */
const MAX_ENCODE_QUEUE = 2

const PKT_CONFIG = 0
const PKT_CHUNK = 1
const CHUNK_HEADER = 11

/** 优先级从高到低：H.264 基线（硬件编码最普及）→ VP8 → VP9。 */
const CODEC_CANDIDATES = ['avc1.42E01F', 'vp8', 'vp09.00.10.08']

// MediaStreamTrackProcessor 尚未进 lib.dom.d.ts，这里按用到的部分声明。
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<VideoFrame>
}

/** 本端能否把屏幕编码后经中继发出。 */
export function canEncodeScreen(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

/** 本端能否解码经中继收到的屏幕流。 */
export function canDecodeScreen(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

// —— 发送端 ——

export interface ScreenEncoderConfig {
  /** 发一个已封装好的包（调用方负责分发给各中继对端）。 */
  send: (packet: ArrayBuffer) => void
  /** 中继当前积压字节数，用作丢帧判据。 */
  buffered: () => number
}

/**
 * 采集 → 缩放 → 编码 → 分片发包。
 *
 * 一个共享会话只需一个实例：编码一次，包由 send 回调分发给所有中继对端，
 * 不会因为观看人数增加而重复编码。
 */
export class ScreenEncoder {
  private readonly cfg: ScreenEncoderConfig
  private readonly track: MediaStreamTrack
  private encoder: VideoEncoder | null = null
  /** start() 选定的编解码器；尺寸变化重配时沿用。 */
  private codec = ''
  /** 缩放画布：顺带把「源尺寸变化」和两种采集方式统一成一样的输入。 */
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  private width = 0
  private height = 0
  /** 最近一次成功编码的解码器配置，供新观众补发。 */
  private lastConfig: ArrayBuffer | null = null
  private lastKeyframeAt = 0
  private forceKeyframe = true
  private stopReader: (() => void) | null = null
  private closed = false
  private reconfiguring = false

  constructor(track: MediaStreamTrack, cfg: ScreenEncoderConfig) {
    this.track = track
    this.cfg = cfg
  }

  /** 选编解码器并启动采集循环。返回 false 表示本机没有可用的编码器。 */
  async start(): Promise<boolean> {
    if (!canEncodeScreen() || this.closed) return false

    const settings = this.track.getSettings()
    const srcW = settings.width ?? 1280
    const srcH = settings.height ?? 720
    const [w, h] = fitSize(srcW, srcH)

    const codec = await pickCodec(w, h)
    if (!codec) {
      console.error('[screen] 没有可用的视频编码器')
      return false
    }

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.onEncoded(chunk, meta),
      error: (err) => console.error('[screen] 编码器错误', err),
    })
    this.codec = codec
    this.configure(w, h)

    this.stopReader = readFrames(this.track, (img, sw, sh, ts) => this.onFrame(img, sw, sh, ts))
    return true
  }

  /**
   * 请求下一帧编成关键帧。新观众加入时调用，否则他要等到下一个周期性关键帧
   * 才能出画面。同时补发一次解码器配置。
   */
  requestKeyFrame(): void {
    this.forceKeyframe = true
    if (this.lastConfig) this.cfg.send(this.lastConfig.slice(0))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stopReader?.()
    this.stopReader = null
    try {
      this.encoder?.close()
    } catch {
      /* 已关闭 */
    }
    this.encoder = null
  }

  private configure(w: number, h: number): void {
    if (!this.encoder) return
    this.width = w
    this.height = h
    this.canvas = new OffscreenCanvas(w, h)
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
    const config: VideoEncoderConfig = {
      codec: this.codec,
      width: w,
      height: h,
      bitrate: TARGET_BITRATE,
      framerate: TARGET_FPS,
      // 实时模式：编码器不为了码率精度而缓冲，延迟明显更低。
      latencyMode: 'realtime',
    }
    // annexb 让每个关键帧自带 SPS/PPS，解码端无需 description，跨端更稳。
    if (this.codec.startsWith('avc1')) config.avc = { format: 'annexb' }
    this.encoder.configure(config)
    this.forceKeyframe = true
  }

  private onFrame(img: CanvasImageSource, srcW: number, srcH: number, tsUs: number): void {
    const encoder = this.encoder
    if (!encoder || this.closed || this.reconfiguring) return
    if (encoder.state !== 'configured') return

    // 源尺寸变了（窗口缩放、切换共享目标）就重配，保持画面不被拉伸。
    const [w, h] = fitSize(srcW || this.width, srcH || this.height)
    if (w !== this.width || h !== this.height) {
      this.reconfiguring = true
      try {
        this.configure(w, h)
      } finally {
        this.reconfiguring = false
      }
      return
    }

    // 背压：中继压得太满或编码器排队，直接丢这一帧。掉帧比堆延迟好。
    if (this.cfg.buffered() > BACKPRESSURE_HIGH) return
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return

    const ctx = this.ctx
    if (!ctx || !this.canvas) return
    ctx.drawImage(img, 0, 0, this.width, this.height)

    const frame = new VideoFrame(this.canvas, { timestamp: tsUs })
    const now = performance.now()
    const keyFrame =
      this.forceKeyframe || now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS
    if (keyFrame) {
      this.forceKeyframe = false
      this.lastKeyframeAt = now
    }
    try {
      encoder.encode(frame, { keyFrame })
    } catch (err) {
      console.error('[screen] encode', err)
    } finally {
      frame.close()
    }
  }

  private onEncoded(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (this.closed) return
    if (meta?.decoderConfig) {
      this.lastConfig = packConfig(meta.decoderConfig)
      this.cfg.send(this.lastConfig.slice(0))
    }
    const body = new Uint8Array(chunk.byteLength)
    chunk.copyTo(body)
    for (const packet of packChunk(body, chunk.type === 'key', chunk.timestamp)) {
      this.cfg.send(packet)
    }
  }
}

// —— 接收端 ——

/**
 * 解码 → 画到 canvas → captureStream 变回 MediaStream。
 *
 * 之所以绕回 MediaStream，是为了让接收侧与原生媒体轨完全同构：上层拿到的
 * 依旧是一条流，<video srcObject> 与批注层的坐标换算都不必区分两种来源。
 */
export class ScreenDecoder {
  /** 首帧解出来后回调，供上层把流交给 UI（早于首帧交出去只会是一块黑屏）。 */
  onReady: ((stream: MediaStream) => void) | null = null

  private decoder: VideoDecoder | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private stream: MediaStream | null = null
  /** 分片重组缓冲。中继有序可靠，按到达顺序拼接即可。 */
  private frags: Uint8Array[] = []
  private fragBytes = 0
  private closed = false
  private gotKeyFrame = false

  constructor() {
    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d', { alpha: false })
  }

  /** 投递一个中继屏幕包。 */
  push(packet: ArrayBuffer): void {
    if (this.closed || !canDecodeScreen()) return
    const buf = new Uint8Array(packet)
    if (buf.length < 2 || buf[0] !== 1) return

    if (buf[1] === PKT_CONFIG) {
      this.applyConfig(buf.subarray(2))
      return
    }
    if (buf[1] !== PKT_CHUNK || buf.length < CHUNK_HEADER) return

    const flags = buf[2]
    const more = (flags & 0b10) !== 0
    this.frags.push(buf.subarray(CHUNK_HEADER))
    this.fragBytes += buf.length - CHUNK_HEADER
    if (more) return

    const body = concat(this.frags, this.fragBytes)
    this.frags = []
    this.fragBytes = 0

    const key = (flags & 0b1) !== 0
    // 首个关键帧之前的增量帧解不出来，丢掉可避免解码器报错刷屏。
    if (!key && !this.gotKeyFrame) return
    if (key) this.gotKeyFrame = true

    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') return
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: view.getFloat64(3),
          data: body,
        }),
      )
    } catch (err) {
      console.error('[screen] decode', err)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.decoder?.close()
    } catch {
      /* 已关闭 */
    }
    this.decoder = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
    this.frags = []
  }

  private applyConfig(json: Uint8Array): void {
    let cfg: VideoDecoderConfig
    try {
      cfg = unpackConfig(json)
    } catch {
      return
    }
    // 同一份配置重复到达（每次补发关键帧都会带）时不重建解码器。
    if (this.decoder && this.decoder.state === 'configured') return
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (err) => console.error('[screen] 解码器错误', err),
      })
      this.decoder.configure(cfg)
    } catch (err) {
      console.error('[screen] 配置解码器失败', err)
      this.decoder = null
    }
  }

  private onFrame(frame: VideoFrame): void {
    if (this.closed) {
      frame.close()
      return
    }
    const w = frame.displayWidth
    const h = frame.displayHeight
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.ctx?.drawImage(frame, 0, 0)
    frame.close()

    if (!this.stream) {
      // captureStream 必须在画布已有内容后调用，否则首帧可能是空白。
      this.stream = this.canvas.captureStream(TARGET_FPS)
      this.onReady?.(this.stream)
    }
  }
}

// —— 线格式与工具 ——

/** description 可能是 ArrayBuffer / SharedArrayBuffer / 任意视图，统一成字节视图。 */
function viewOf(src: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src as ArrayBuffer)
}

/** 分段转 base64：一次性展开长数组会撑爆调用栈。 */
function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(s)
}

function packConfig(cfg: VideoDecoderConfig): ArrayBuffer {
  const plain: Record<string, unknown> = {
    codec: cfg.codec,
    codedWidth: cfg.codedWidth,
    codedHeight: cfg.codedHeight,
  }
  if (cfg.description) {
    plain.description = toBase64(viewOf(cfg.description))
  }
  const json = new TextEncoder().encode(JSON.stringify(plain))
  const out = new Uint8Array(2 + json.length)
  out[0] = 1
  out[1] = PKT_CONFIG
  out.set(json, 2)
  return out.buffer
}

function unpackConfig(json: Uint8Array): VideoDecoderConfig {
  const raw = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>
  const cfg: VideoDecoderConfig = {
    codec: String(raw.codec),
    codedWidth: typeof raw.codedWidth === 'number' ? raw.codedWidth : undefined,
    codedHeight: typeof raw.codedHeight === 'number' ? raw.codedHeight : undefined,
    // 实时流不需要重排序，关掉能少一帧延迟。
    optimizeForLatency: true,
  }
  if (typeof raw.description === 'string') {
    const bin = atob(raw.description)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    cfg.description = bytes
  }
  return cfg
}

/** 把一个编码帧切成若干个中继包（末包不带「还有后续」标志）。 */
function packChunk(body: Uint8Array, key: boolean, tsUs: number): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (let at = 0; at < body.length || at === 0; at += MAX_FRAGMENT) {
    const slice = body.subarray(at, at + MAX_FRAGMENT)
    const more = at + MAX_FRAGMENT < body.length
    const pkt = new Uint8Array(CHUNK_HEADER + slice.length)
    pkt[0] = 1
    pkt[1] = PKT_CHUNK
    pkt[2] = (key ? 0b1 : 0) | (more ? 0b10 : 0)
    new DataView(pkt.buffer).setFloat64(3, tsUs)
    pkt.set(slice, CHUNK_HEADER)
    out.push(pkt.buffer)
    if (!more) break
  }
  return out
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 按上限等比缩放，并对齐到偶数（多数编码器要求偶数尺寸）。 */
function fitSize(w: number, h: number): [number, number] {
  const scale = w > MAX_WIDTH ? MAX_WIDTH / w : 1
  const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2)
  return [even(w), even(h)]
}

/** 逐个试候选编解码器，返回首个本机支持的。 */
async function pickCodec(w: number, h: number): Promise<string | null> {
  for (const codec of CODEC_CANDIDATES) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
        bitrate: TARGET_BITRATE,
        framerate: TARGET_FPS,
      })
      if (supported) return codec
    } catch {
      /* 该候选不被识别，试下一个 */
    }
  }
  return null
}

/**
 * 从媒体轨取帧。优先 MediaStreamTrackProcessor（Chromium，无需 DOM 元素）；
 * 其余浏览器退回隐藏 <video> + requestVideoFrameCallback。两条路径都只把
 * 「一个可绘制的图像源」交给上层，由上层统一缩放，避免两套缩放逻辑。
 */
function readFrames(
  track: MediaStreamTrack,
  onFrame: (img: CanvasImageSource, w: number, h: number, tsUs: number) => void,
): () => void {
  if (typeof MediaStreamTrackProcessor !== 'undefined') {
    let stopped = false
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    void (async () => {
      while (!stopped) {
        let frame: VideoFrame | undefined
        try {
          const { done, value } = await reader.read()
          if (done) break
          frame = value
        } catch {
          break
        }
        if (!frame) continue
        try {
          onFrame(frame, frame.displayWidth, frame.displayHeight, frame.timestamp)
        } finally {
          frame.close()
        }
      }
      try {
        reader.cancel()
      } catch {
        /* 已结束 */
      }
    })()
    return () => {
      stopped = true
      void reader.cancel().catch(() => {})
    }
  }

  // 退化路径：视频元素必须在文档里才保证 rVFC 稳定触发，故插入一个 1px 的隐藏元素。
  const video = document.createElement('video')
  video.srcObject = new MediaStream([track])
  video.muted = true
  video.playsInline = true
  video.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(video)
  void video.play().catch(() => {})

  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null
  const emit = (tsUs: number) => {
    if (!stopped && video.videoWidth > 0) {
      onFrame(video, video.videoWidth, video.videoHeight, tsUs)
    }
  }
  if (typeof video.requestVideoFrameCallback === 'function') {
    const step = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return
      emit(Math.round(meta.mediaTime * 1e6))
      video.requestVideoFrameCallback(step)
    }
    video.requestVideoFrameCallback(step)
  } else {
    timer = setInterval(() => emit(Math.round(performance.now() * 1000)), 1000 / TARGET_FPS)
  }
  return () => {
    stopped = true
    if (timer !== null) clearInterval(timer)
    video.srcObject = null
    video.remove()
  }
}
