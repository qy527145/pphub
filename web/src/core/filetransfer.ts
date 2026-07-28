// 文件传输引擎（1b）：在独立 file-<id> 数据通道上分块收发。
//
// 协议：发送端先经 control 通道发 file-offer 元信息，随后创建 `file-<id>`
// 通道流式发送二进制分块（背压驱动），发完排空缓冲后关闭通道。接收端把
// 通道二进制帧按序累积，字节数够 size 即成功；通道提前关闭视为中断。
// 任一端可经 control 通道发 file-cancel 中止。
//
// 落盘策略（MVP）：内存累积 Blob 后导出——桌面 ≤1GB 可用；流式落盘
// (FSA/OPFS) 见 ARCHITECTURE 6.1，后续增强。

import { BUFFERED_HIGH, BUFFERED_LOW, CHUNK_SIZE, waitForFlush } from './channels'
import type { FileOffer } from './messages'
import type { Peer } from './peer'

export interface SendHandle {
  /** 主动中止发送（不负责通知对端，由调用方发 file-cancel）。 */
  cancel(): void
  /** 发送完成（正常结束）兑现；取消或出错时 reject。 */
  done: Promise<void>
}

export class TransferCanceled extends Error {
  constructor() {
    super('transfer canceled')
    this.name = 'TransferCanceled'
  }
}

/**
 * 在指定 Peer 上发送一个文件。调用前应已经 control 通道发出 file-offer。
 * onProgress 以已发送字节数回调（含在途缓冲）。
 */
export function sendFile(
  peer: Peer,
  offer: FileOffer,
  file: File,
  onProgress: (bytes: number) => void,
): SendHandle {
  let canceled = false
  const channel = peer.createFileChannel(offer.id)
  channel.binaryType = 'arraybuffer'

  const done = (async () => {
    await waitOpen(channel)
    let offset = 0
    while (offset < file.size) {
      if (canceled) throw new TransferCanceled()
      if (channel.readyState !== 'open') throw new Error('通道意外关闭')
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
      await waitDrainOrDead(channel, () => canceled)
      if (canceled) throw new TransferCanceled()
      if (channel.readyState !== 'open') throw new Error('通道意外关闭')
      channel.send(chunk)
      offset += chunk.byteLength
      onProgress(offset)
    }
    await waitForFlush(channel)
    channel.close()
  })()

  done.catch(() => {
    try {
      channel.close()
    } catch {
      /* ignore */
    }
  })

  return {
    cancel: () => {
      canceled = true
    },
    done,
  }
}

export interface ReceiveCallbacks {
  onProgress(bytes: number): void
  onDone(blob: Blob): void
  onError(reason: string): void
}

export interface ReceiveHandle {
  /** 主动中止接收（不负责通知对端）。 */
  cancel(): void
}

/** 在对端新开的 file-<id> 通道上接收文件。 */
export function receiveFile(
  channel: RTCDataChannel,
  offer: FileOffer,
  cb: ReceiveCallbacks,
): ReceiveHandle {
  const parts: ArrayBuffer[] = []
  let received = 0
  let settled = false

  channel.binaryType = 'arraybuffer'

  const finish = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
  }

  channel.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return
    parts.push(ev.data)
    received += ev.data.byteLength
    cb.onProgress(received)
    if (received >= offer.size) {
      finish(() => cb.onDone(new Blob(parts, { type: offer.mime || 'application/octet-stream' })))
      channel.onclose = null
      try {
        channel.close()
      } catch {
        /* ignore */
      }
    }
  }

  channel.onclose = () => {
    finish(() => cb.onError('连接中断，传输未完成'))
  }
  channel.onerror = () => {
    finish(() => cb.onError('传输通道出错'))
  }

  return {
    cancel: () =>
      finish(() => {
        channel.onclose = null
        try {
          channel.close()
        } catch {
          /* ignore */
        }
      }),
  }
}

function waitOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    channel.onopen = () => resolve()
    channel.onerror = () => reject(new Error('通道打开失败'))
    channel.onclose = () => reject(new Error('通道在打开前被关闭'))
  })
}

/**
 * 背压等待：积压回落到低水位、或通道关闭/被取消时返回。
 * 主路径靠 bufferedamountlow 事件；辅以低频轮询兜底，
 * 避免对端中途关闭通道导致事件永不触发而挂起。
 */
function waitDrainOrDead(channel: RTCDataChannel, isCanceled: () => boolean): Promise<void> {
  if (channel.bufferedAmount <= BUFFERED_HIGH) return Promise.resolve()
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = BUFFERED_LOW
    const done = () => {
      clearInterval(timer)
      channel.removeEventListener('bufferedamountlow', done)
      resolve()
    }
    const timer = setInterval(() => {
      if (
        isCanceled() ||
        channel.readyState !== 'open' ||
        channel.bufferedAmount <= BUFFERED_LOW
      ) {
        done()
      }
    }, 250)
    channel.addEventListener('bufferedamountlow', done)
  })
}
