// 数据通道通用参数与背压工具。

/** 单条 SCTP 消息安全上限（各浏览器普遍支持 256 KiB，此处取保守值）。 */
export const MAX_MESSAGE_SIZE = 256 * 1024

/** 大文件分块尺寸；16–64 KiB 为跨浏览器安全区间，取 64 KiB 换吞吐。 */
export const CHUNK_SIZE = 64 * 1024

/** bufferedAmount 低水位阈值：低于它才继续灌数据。 */
export const BUFFERED_LOW = 256 * 1024

/** bufferedAmount 高水位：达到它就暂停发送，等待回落。 */
export const BUFFERED_HIGH = 1024 * 1024

/**
 * 背压：当通道积压超过高水位时，等待其回落到低水位阈值以下再 resolve。
 * 依赖 bufferedamountlow 事件，避免忙等。
 */
export function waitForDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= BUFFERED_HIGH) return Promise.resolve()
  return new Promise((resolve) => {
    const prev = channel.bufferedAmountLowThreshold
    channel.bufferedAmountLowThreshold = BUFFERED_LOW
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow)
      channel.bufferedAmountLowThreshold = prev
      resolve()
    }
    channel.addEventListener('bufferedamountlow', onLow)
  })
}

/** 等待通道积压彻底清空（关闭通道前调用，避免丢尾部数据）。 */
export function waitForFlush(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (channel.readyState !== 'open' || channel.bufferedAmount === 0) resolve()
      else setTimeout(tick, 50)
    }
    tick()
  })
}
