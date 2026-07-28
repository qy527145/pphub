// 端到端信令握手冒烟测试：两个 WS 客户端进同一房间，验证
// joined / peer-join / signal 中继 / peer-left 全链路。使用 Node 全局 WebSocket。

const URL = process.env.PPHUB_WS ?? 'ws://127.0.0.1:8090/ws'
const ROOM = 'smoke-' + Math.random().toString(36).slice(2, 7)

function open(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    ws.log = []
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      ws.log.push(m)
      console.log(`[${name}] <-`, JSON.stringify(m))
    }
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(`${name} ws error: ${e.message ?? e}`))
  })
}

const send = (ws, obj) => ws.send(JSON.stringify(obj))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (ws, pred, ms = 2000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = ws.log.find(pred)
    if (hit) return hit
    await wait(25)
  }
  throw new Error('timeout waiting for message')
}

let failures = 0
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`)
  if (!cond) failures++
}

const a = await open('A')
const b = await open('B')

// A 先加入。
send(a, { t: 'turn-creds' })
const creds = await waitFor(a, (m) => m.t === 'turn-creds')
check(Array.isArray(creds.iceServers) && creds.iceServers.length > 0, 'A 收到 ICE 服务器列表')
check(!JSON.stringify(creds).includes('PPHUB_TURN_SECRET'), 'ICE 凭证不含明文密钥名')

send(a, { t: 'join', room: ROOM, peerId: 'peer-a', nick: 'Alice' })
const aJoined = await waitFor(a, (m) => m.t === 'joined')
check(aJoined.peerId === 'peer-a', 'A joined 回显自身 peerId')
check(Array.isArray(aJoined.peers) && aJoined.peers.length === 0, 'A 是房间第一人，peers 为空')

// B 加入，A 应收到 peer-join，B 的 joined 应含 A。
send(b, { t: 'join', room: ROOM, peerId: 'peer-b', nick: 'Bob' })
const bJoined = await waitFor(b, (m) => m.t === 'joined')
check(
  bJoined.peers.some((p) => p.peerId === 'peer-a' && p.nick === 'Alice'),
  'B joined 列表包含已在场的 Alice',
)
const aSawB = await waitFor(a, (m) => m.t === 'peer-join')
check(aSawB.peer.peerId === 'peer-b' && aSawB.peer.nick === 'Bob', 'A 收到 Bob 的 peer-join')

// A → B 信令中继。
send(a, { t: 'signal', to: 'peer-b', data: { description: { type: 'offer', sdp: 'x' } } })
const relayed = await waitFor(b, (m) => m.t === 'signal')
check(relayed.from === 'peer-a', 'B 收到来自 A 的 signal（from 正确）')
check(relayed.data?.description?.type === 'offer', 'signal 负载被原样透传')

// B 离开，A 应收到 peer-left。
b.close()
const aSawLeave = await waitFor(a, (m) => m.t === 'peer-left')
check(aSawLeave.peerId === 'peer-b', 'A 收到 Bob 的 peer-left')

a.close()
await wait(100)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
