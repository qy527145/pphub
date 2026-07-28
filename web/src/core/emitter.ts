// 极简类型化事件发射器：避免引入 mitt 等依赖。
// 用法：
//   const e = new Emitter<{ open: void; message: string }>()
//   const off = e.on('message', (s) => ...)
//   e.emit('message', 'hi'); off()

export type Handler<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<unknown>>>()

  /** 订阅事件，返回取消订阅函数。 */
  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler as Handler<unknown>)
    return () => set!.delete(handler as Handler<unknown>)
  }

  /** 单次订阅：触发一次后自动取消。 */
  once<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(type, (payload) => {
      off()
      handler(payload)
    })
    return off
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type)
    if (!set) return
    // 复制一份，允许处理器在回调中取消订阅。
    for (const handler of [...set]) {
      ;(handler as Handler<Events[K]>)(payload)
    }
  }

  /** 清空全部订阅（销毁时调用）。 */
  clear(): void {
    this.handlers.clear()
  }
}
