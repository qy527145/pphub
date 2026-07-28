// WS 应用层中继（单端口 fallback）冒烟测试。
//
// 覆盖 src/ws.rs 的 relay_binary：
//   - 帧头改写：入站携带「目标 peerId」，出站被换成「来源 peerId」
//   - 载荷原样透传（服务器不解析、不改动密文）
//   - 非法帧（版本号错、长度越界、目标不存在、未加入房间）被丢弃而非崩溃
//
// 用法：先起服务器（如 PPHUB_PORT=8090 cargo run），再
//   PPHUB_WS=ws://127.0.0.1:8090/ws node web/scripts/smoke-relay.mjs

const URL = process.env.PPHUB_WS ?? 'ws://127.0.0.1:8090/ws'
const ROOM = 'relay-' + Math.random().toString(36).slice(2, 7)

function open(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    ws.binaryType = 'arraybuffer'
    ws.json = []
    ws.bin = []
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        ws.bin.push(new Uint8Array(e.data))
        console.log(`[${name}] <- binary ${e.data.byteLength}B`)
      } else {
        ws.json.push(JSON.parse(e.data))
        console.log(`[${name}] <-`, e.data)
      }
    }
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(`${name} ws error: ${e.message ?? e}`))
  })
}

const send = (ws, obj) => ws.send(JSON.stringify(obj))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitJson(ws, pred, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = ws.json.find(pred)
    if (hit) return hit
    await wait(25)
  }
  throw new Error('timeout waiting for json')
}

async function waitBin(ws, n = 1, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (ws.bin.length >= n) return ws.bin[n - 1]
    await wait(25)
  }
  throw new Error('timeout waiting for binary')
}

let failures = 0
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`)
  if (!cond) failures++
}

/** 按线格式封一帧：[1][idLen][id][payload]。 */
function frame(toId, payload) {
  const id = new TextEncoder().encode(toId)
  const out = new Uint8Array(2 + id.length + payload.length)
  out[0] = 1
  out[1] = id.length
  out.set(id, 2)
  out.set(payload, 2 + id.length)
  return out
}

function parse(buf) {
  const idLen = buf[1]
  return {
    version: buf[0],
    from: new TextDecoder().decode(buf.subarray(2, 2 + idLen)),
    payload: buf.subarray(2 + idLen),
  }
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

const a = await open('A')
const b = await open('B')

// 未加入房间就发中继帧：必须被丢弃且连接存活。
a.send(frame('peer-b', new Uint8Array([1, 2, 3])))
await wait(100)
check(a.readyState === WebSocket.OPEN, '未加入房间的中继帧被丢弃，连接未断开')

send(a, { t: 'join', room: ROOM, peerId: 'peer-a', nick: 'Alice' })
await waitJson(a, (m) => m.t === 'joined')
send(b, { t: 'join', room: ROOM, peerId: 'peer-b', nick: 'Bob' })
await waitJson(b, (m) => m.t === 'joined')

// A → B：模拟一帧 AES-GCM 密文（服务器视角只是不透明字节）。
const payload = new Uint8Array(4096)
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff
a.send(frame('peer-b', payload))

const got = parse(await waitBin(b, 1))
check(got.version === 1, 'B 收到的帧版本为 1')
check(got.from === 'peer-a', '帧头的目标 peerId 已被改写为来源 peer-a')
check(eq(got.payload, payload), '载荷逐字节原样透传')

// B → A：反向同样成立。
const back = new TextEncoder().encode('pong')
b.send(frame('peer-a', back))
const gotBack = parse(await waitBin(a, 1))
check(gotBack.from === 'peer-b' && eq(gotBack.payload, back), '反向中继同样正确')

// 非法帧：版本号错、idLen 越界、目标不在房间——都应静默丢弃。
a.send(new Uint8Array([9, 6, 112, 101, 101, 114, 45, 98, 1]))
a.send(new Uint8Array([1, 200, 1, 2, 3]))
a.send(frame('peer-zzz', new Uint8Array([1])))
a.send(new Uint8Array([1]))
await wait(200)
check(b.bin.length === 1, '非法帧未被投递给 B')
check(a.readyState === WebSocket.OPEN && b.readyState === WebSocket.OPEN, '非法帧未导致断连')

// 大帧（超过服务器 256KiB 上限）应被丢弃，正常帧仍能继续收发。
a.send(frame('peer-b', new Uint8Array(300 * 1024)))
await wait(200)
check(b.bin.length === 1, '超限帧被丢弃')
a.send(frame('peer-b', new Uint8Array([42])))
const after = parse(await waitBin(b, 2))
check(after.payload.length === 1 && after.payload[0] === 42, '超限帧之后连接仍可用')

a.close()
b.close()
await wait(150)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
