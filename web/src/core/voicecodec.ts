// 扇出路径上的实时对讲：用 WebCodecs 把麦克风自编码为 Opus，绕开浏览器内部
// 的 SRTP 栈——和 screencodec 之于屏幕共享同理。
//
// 背景：WebRTC 音频轨（getUserMedia → addTrack）由浏览器内部收发，JS 拿不到
// 编码帧，无法经服务器扇出。WebCodecs 的 AudioEncoder 让我们自己把麦克风编成
// EncodedAudioChunk（就在 JS 手里），加密后交给服务器扇出；对端 AudioDecoder
// 解回 AudioData，写入 MediaStreamTrackGenerator 变回一条 MediaStream，于是上层
// （voice-stream 事件、<audio srcObject>）与原生音频轨完全同构。
//
// 边界，须如实告知用户：
//   - 无 WebRTC 的回声消除/降噪链路（getUserMedia 的约束仍生效，但扇出后端到端无 AEC 反馈）；
//   - 需要安全上下文（AudioEncoder 与 crypto.subtle 一样在明文 http 下不存在）；
//   - Opus 每包独立可解，无「关键帧」概念，但**解码器配置**要让迟到的观众也拿到，
//     故发送端周期性重发配置包（见 VOICE_CONFIG_RESEND）。
//
// 线格式（一个包 = 扇出帧解密后的明文，去掉 kind 字节）：
//   [0]      版本 = 1
//   [1]      类型：0=解码器配置(JSON) 1=编码帧
//   类型 0   [2..]   UTF-8 JSON（AudioDecoderConfig，description 以 base64 承载）
//   类型 1   [2..10) Float64BE 时间戳（微秒） [10..] Opus 字节

/** Opus 目标码率：单声道语音 32kbps 足够清晰。 */
const OPUS_BITRATE = 32_000
/** 采集/编码假定的采样率与声道（getUserMedia 默认即 48kHz 单声道）。 */
const SAMPLE_RATE = 48_000
const CHANNELS = 1

/** 中继积压超过此值就丢帧——宁可掉音也不让语音把信令挤死。 */
const BACKPRESSURE_HIGH = 2 * 1024 * 1024
/** 编码器排队超过此数说明编码跟不上采集，丢新帧而非堆延迟。 */
const MAX_ENCODE_QUEUE = 4
/** 每发这么多编码包就重发一次解码器配置，让迟到的观众能在约 2s 内出声。 */
const VOICE_CONFIG_RESEND = 100

const PKT_CONFIG = 0
const PKT_CHUNK = 1
const CHUNK_HEADER = 10

// MediaStreamTrackProcessor / Generator 尚未进 lib.dom.d.ts，按用到的部分声明。
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<AudioData>
}
declare class MediaStreamTrackGenerator {
  constructor(init: { kind: 'audio' })
  readonly writable: WritableStream<AudioData>
}

/** 本端能否把麦克风编码后经扇出发出。 */
export function canEncodeVoice(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
}

/** 本端能否解码经扇出收到的语音流。 */
export function canDecodeVoice(): boolean {
  return (
    typeof AudioDecoder !== 'undefined' &&
    typeof EncodedAudioChunk !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined'
  )
}

/** 本机（当前配置下）是否真能启动 Opus 编码器。异步，供开麦前预检。 */
export async function opusEncodeSupported(): Promise<boolean> {
  if (!canEncodeVoice()) return false
  try {
    const { supported } = await AudioEncoder.isConfigSupported({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: OPUS_BITRATE,
    })
    return !!supported
  } catch {
    return false
  }
}

// —— 发送端 ——

export interface VoiceEncoderConfig {
  /** 发一个已封装好的包（调用方负责加密并扇出）。 */
  send: (packet: ArrayBuffer) => void
  /** 中继当前积压字节数，用作丢帧判据。 */
  buffered: () => number
}

/**
 * 采集 → Opus 编码 → 发包。一个开麦会话只需一个实例：编码一次，包由 send
 * 回调加密后扇出给全房间，不因观众增加而重复编码。
 */
export class VoiceEncoder {
  private readonly cfg: VoiceEncoderConfig
  private readonly track: MediaStreamTrack
  private encoder: AudioEncoder | null = null
  private configured = false
  private lastConfig: ArrayBuffer | null = null
  private sinceConfig = 0
  private stopReader: (() => void) | null = null
  private closed = false

  constructor(track: MediaStreamTrack, cfg: VoiceEncoderConfig) {
    this.track = track
    this.cfg = cfg
  }

  /** 启动编码。返回 false 表示本机没有可用的 Opus 编码器。 */
  async start(): Promise<boolean> {
    if (this.closed || !(await opusEncodeSupported())) return false
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => this.onEncoded(chunk, meta),
      error: (err) => console.error('[voice] 编码器错误', err),
    })
    this.stopReader = readAudio(this.track, (data) => this.onData(data))
    return true
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

  private onData(data: AudioData): void {
    const encoder = this.encoder
    if (!encoder || this.closed) {
      data.close()
      return
    }
    // 首帧到达时按其实际参数配置编码器，确保输入与编码器采样率/声道一致。
    if (!this.configured) {
      this.configured = true
      try {
        encoder.configure({
          codec: 'opus',
          sampleRate: data.sampleRate,
          numberOfChannels: data.numberOfChannels,
          bitrate: OPUS_BITRATE,
        })
      } catch (err) {
        console.error('[voice] 配置编码器失败', err)
        data.close()
        return
      }
    }
    // 背压：中继压得太满或编码器排队，丢这一帧。掉音比堆延迟好。
    if (this.cfg.buffered() > BACKPRESSURE_HIGH || encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      data.close()
      return
    }
    try {
      encoder.encode(data)
    } catch (err) {
      console.error('[voice] encode', err)
    } finally {
      data.close()
    }
  }

  private onEncoded(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    if (this.closed) return
    if (meta?.decoderConfig && !this.lastConfig) {
      this.lastConfig = packConfig(meta.decoderConfig)
      this.cfg.send(this.lastConfig.slice(0))
    }
    // 周期性重发配置：让共享开始后才入房/切到 fanout 的观众也能建起解码器。
    if (this.lastConfig && ++this.sinceConfig >= VOICE_CONFIG_RESEND) {
      this.sinceConfig = 0
      this.cfg.send(this.lastConfig.slice(0))
    }
    const body = new Uint8Array(chunk.byteLength)
    chunk.copyTo(body)
    this.cfg.send(packChunk(body, chunk.timestamp))
  }
}

// —— 接收端 ——

/**
 * Opus 解码 → 写入 MediaStreamTrackGenerator 变回 MediaStream。
 * 与原生音频轨同构：上层拿到的依旧是一条流，<audio srcObject> 不必区分来源。
 */
export class VoiceDecoder {
  /** 音频轨就绪后回调，供上层把流交给 UI 播放。 */
  onReady: ((stream: MediaStream) => void) | null = null

  private decoder: AudioDecoder | null = null
  private generator: MediaStreamTrackGenerator | null = null
  private writer: WritableStreamDefaultWriter<AudioData> | null = null
  private stream: MediaStream | null = null
  private closed = false

  /** 投递一个语音包（扇出帧解密后的明文）。 */
  push(packet: ArrayBuffer): void {
    if (this.closed || !canDecodeVoice()) return
    const buf = new Uint8Array(packet)
    if (buf.length < 2 || buf[0] !== 1) return

    if (buf[1] === PKT_CONFIG) {
      this.applyConfig(buf.subarray(2))
      return
    }
    if (buf[1] !== PKT_CHUNK || buf.length < CHUNK_HEADER) return

    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') return
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    try {
      decoder.decode(
        new EncodedAudioChunk({
          // Opus 每包独立可解，一律作 key（无帧间依赖）。
          type: 'key',
          timestamp: view.getFloat64(2),
          data: buf.subarray(CHUNK_HEADER),
        }),
      )
    } catch (err) {
      console.error('[voice] decode', err)
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
    void this.writer?.close().catch(() => {})
    this.writer = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
    this.generator = null
  }

  private applyConfig(json: Uint8Array): void {
    // 配置包会周期性重发；已建好解码器就忽略重复。
    if (this.decoder && this.decoder.state === 'configured') return
    let cfg: AudioDecoderConfig
    try {
      cfg = unpackConfig(json)
    } catch {
      return
    }
    try {
      this.generator = new MediaStreamTrackGenerator({ kind: 'audio' })
      this.writer = this.generator.writable.getWriter()
      this.stream = new MediaStream([this.generator as unknown as MediaStreamTrack])
      this.decoder = new AudioDecoder({
        output: (data) => this.onAudio(data),
        error: (err) => console.error('[voice] 解码器错误', err),
      })
      this.decoder.configure(cfg)
    } catch (err) {
      console.error('[voice] 配置解码器失败', err)
      this.decoder = null
      return
    }
    this.onReady?.(this.stream)
  }

  private onAudio(data: AudioData): void {
    const writer = this.writer
    if (this.closed || !writer) {
      data.close()
      return
    }
    // 写入 generator 会转移 AudioData 所有权；失败（如已关闭）时才由我们释放。
    writer.write(data).catch(() => {
      try {
        data.close()
      } catch {
        /* 已释放 */
      }
    })
  }
}

// —— 线格式与工具 ——

/** description 可能是 ArrayBuffer / 任意视图，统一成字节视图。 */
function viewOf(src: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src as ArrayBuffer)
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(s)
}

function packConfig(cfg: AudioDecoderConfig): ArrayBuffer {
  const plain: Record<string, unknown> = {
    codec: cfg.codec,
    sampleRate: cfg.sampleRate,
    numberOfChannels: cfg.numberOfChannels,
  }
  if (cfg.description) plain.description = toBase64(viewOf(cfg.description))
  const json = new TextEncoder().encode(JSON.stringify(plain))
  const out = new Uint8Array(2 + json.length)
  out[0] = 1
  out[1] = PKT_CONFIG
  out.set(json, 2)
  return out.buffer
}

function unpackConfig(json: Uint8Array): AudioDecoderConfig {
  const raw = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>
  const cfg: AudioDecoderConfig = {
    codec: String(raw.codec),
    sampleRate: typeof raw.sampleRate === 'number' ? raw.sampleRate : SAMPLE_RATE,
    numberOfChannels: typeof raw.numberOfChannels === 'number' ? raw.numberOfChannels : CHANNELS,
  }
  if (typeof raw.description === 'string') {
    const bin = atob(raw.description)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    cfg.description = bytes
  }
  return cfg
}

function packChunk(body: Uint8Array, tsUs: number): ArrayBuffer {
  const pkt = new Uint8Array(CHUNK_HEADER + body.length)
  pkt[0] = 1
  pkt[1] = PKT_CHUNK
  new DataView(pkt.buffer).setFloat64(2, tsUs)
  pkt.set(body, CHUNK_HEADER)
  return pkt.buffer
}

/**
 * 从音频轨取 AudioData 帧。优先 MediaStreamTrackProcessor（Chromium）；
 * 缺失时无法自编码音频（返回空停止器，调用方的 opusEncodeSupported 预检已拦）。
 */
function readAudio(track: MediaStreamTrack, onData: (data: AudioData) => void): () => void {
  if (typeof MediaStreamTrackProcessor === 'undefined') return () => {}
  let stopped = false
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
  void (async () => {
    while (!stopped) {
      let data: AudioData | undefined
      try {
        const { done, value } = await reader.read()
        if (done) break
        data = value
      } catch {
        break
      }
      if (!data) continue
      if (stopped) {
        data.close()
        break
      }
      onData(data) // onData 负责 close（编码或丢弃后）
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
