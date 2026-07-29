// 明文 http（局域网 IP，非安全上下文）下的中继 E2E。
//
// 这是本套件存在的理由：`crypto.subtle` 在这种上下文里不存在，中继过去会
// 直接拒绝降级，跨网段的设备彻底连不上。改用纯 JS 加密（crypto.ts）后，
// http 下的中继照常可用且仍是密文——本脚本就验证这一点，并顺带确认
// 「加密确实生效」而不是悄悄退化成明文。
//
// 覆盖：
//   1. 确属非安全上下文（crypto.subtle 缺失，getRandomValues 尚在）
//   2. 中继链路建立，两端 transport=relay
//   3. SAS 两端一致（http 下安全核验仍然可用）
//   4. 聊天 / 白板 / 文件经中继送达
//   5. 服务器看到的中继帧确为密文——明文关键字不出现在线缆上
//   6. 屏幕共享在 http 下仍不可用，且给出的是「采集/编码 API 被禁用」而非误导
//
// 前置：cargo build && npm run build。运行：node scripts/e2e-http-relay.mjs
// 需要一个本机局域网 IP（127.0.0.1 算安全上下文，测不出问题）。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const PORT = 18095
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHROMIUM = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

/** 找一个非回环 IPv4：必须用它访问才会被判定为非安全上下文。 */
function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

// 注意 fn 会被序列化后在浏览器里求值，闭包捕获的 Node 侧变量在那边是
// undefined。需要外部值时一律走 arg 显式传入，别指望闭包。
async function until(page, fn, name, { timeout = 25000, arg } = {}) {
  const t0 = Date.now()
  let lastErr = null
  for (;;) {
    let v
    try {
      v = await page.evaluate(fn, arg)
      lastErr = null
    } catch (err) {
      v = null
      lastErr = err
    }
    if (v) return v
    if (Date.now() - t0 > timeout) {
      // 判据本身抛异常（例如引用了不存在的变量）和「条件迟迟不成立」是两回事，
      // 混在一起报会把测试脚本的 bug 说成产品的 bug。
      throw new Error(lastErr ? `判据出错 (${name}): ${lastErr.message}` : `超时: ${name}`)
    }
    await page.waitForTimeout(200)
  }
}

async function main() {
  const IP = lanIp()
  if (!IP) throw new Error('找不到局域网 IPv4，无法构造非安全上下文')
  const BASE = `http://${IP}:${PORT}`
  console.log(`  （经 ${BASE} 访问，应为非安全上下文）`)

  const server = spawn(
    path.join(ROOT, 'target/debug/pphub'),
    ['-H', '0.0.0.0', '-p', String(PORT)],
    { stdio: 'ignore' },
  )
  // 代理会拦截局域网 IP，显式绕开。
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-proxy-server'],
  })
  try {
    await new Promise((r) => setTimeout(r, 800))

    const pages = []
    for (const name of ['alpha', 'bravo']) {
      const ctx = await browser.newContext()
      await ctx.addInitScript(() => {
        localStorage.setItem('pphub:force:relay', 'true')
      })
      const p = await ctx.newPage()
      await p.goto(BASE)
      await until(p, () => window.__pphub && window.__pphub.status !== 'connecting', `${name} 就绪`)
      await p.evaluate((n) => {
        window.__pphub.setNick(n)
        return window.__pphub.connectTo('http-relay-room')
      }, name)
      pages.push(p)
    }
    const [a, b] = pages

    // —— 1. 确认这确实是非安全上下文 ——
    const env = await a.evaluate(() => ({
      secure: window.isSecureContext,
      subtle: typeof crypto?.subtle !== 'undefined',
      random: typeof crypto?.getRandomValues === 'function',
    }))
    if (env.secure || env.subtle) {
      throw new Error(`没测到非安全上下文：${JSON.stringify(env)}`)
    }
    if (!env.random) throw new Error('getRandomValues 也没有，纯 JS 加密无法工作')
    ok('确属非安全上下文：crypto.subtle 缺失，getRandomValues 可用')

    // —— 2. 中继链路建立（改造前这里会直接失败）——
    for (const [p, name] of [[a, 'A'], [b, 'B']]) {
      await until(p, () => window.__pphub.connectedPeers.length === 1, `${name} 经中继连通`)
      await until(
        p,
        () => window.__pphub.memberList.every((m) => m.transport === 'relay'),
        `${name} 标记为中继`,
      )
    }
    ok('明文 http 下中继链路照常建立（改造前会被拒绝）')

    // —— 3. SAS ——
    const sasA = await until(a, () => window.__pphub.memberList[0]?.sas?.digits ?? null, 'A SAS')
    const sasB = await until(b, () => window.__pphub.memberList[0]?.sas?.digits ?? null, 'B SAS')
    if (sasA !== sasB) throw new Error(`SAS 不一致：A=${sasA} B=${sasB}`)
    ok(`安全核验在 http 下仍可用：SAS 两端一致（${sasA}）`)

    // —— 4. 业务数据 ——
    const bId = await b.evaluate(() => window.__pphub.myId)
    await a.evaluate(() => window.__pphub.sendChat('http 中继群聊', 'all'))
    await until(
      b,
      () => window.__pphub.messages.some((m) => m.text === 'http 中继群聊'),
      'B 收到群聊',
    )
    await a.evaluate(() => {
      const s = window.__pphub
      const id = s.beginStroke('wb', 'pen', '#00aaff', 3, 0.1, 0.1)
      s.extendStroke('wb', id, [0.3, 0.3, 0.5, 0.5])
      s.endStroke('wb', id)
    })
    await until(b, () => window.__pphub.getBoard('wb').length > 0, 'B 白板同步')
    await a.evaluate(
      ({ to }) => {
        const bytes = new Uint8Array(128 * 1024).map((_, i) => (i * 37 + 11) % 256)
        const f = new File([bytes], 'http-relay.bin', { type: 'application/octet-stream' })
        window.__pphub.dispatchFiles([f], 'force', to)
      },
      { to: bId },
    )
    await until(
      b,
      () => window.__pphub.transfers.some((t) => t.name === 'http-relay.bin' && t.state === 'done'),
      'B 收完文件',
    )
    ok('聊天 / 白板 / 128KiB 文件经 http 中继完整送达')

    // —— 5. 线上确为密文 ——
    // 中继帧是点对点寻址的，旁观者连上信令也收不到别人的帧，所以直接在发送端
    // 取证：钩住 WebSocket.prototype.send，检查真正出站的字节里有没有明文。
    // 服务器转发的就是这些字节，因此「这里没有明文」等价于「服务器看不到明文」。
    const SECRET = '明文不该出现在线缆上-CANARY-9271'
    const wire = await a.evaluate(async (secret) => {
      const seen = []
      const orig = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (data instanceof ArrayBuffer) seen.push(new Uint8Array(data).slice())
        return orig.call(this, data)
      }
      window.__pphub.sendChat(secret, 'all')
      await new Promise((r) => setTimeout(r, 1200))
      WebSocket.prototype.send = orig
      const needle = new TextEncoder().encode(secret)
      const contains = (hay) => {
        outer: for (let i = 0; i + needle.length <= hay.length; i++) {
          for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
          return true
        }
        return false
      }
      // 阴性对照：往一段字节里明文塞入 needle，contains 必须能揪出来。否则
      // 「没找到明文」可能只是搜索函数本身失效，这条断言就成了空过。
      const control = new Uint8Array(needle.length + 64)
      control.set(needle, 20)
      return {
        frames: seen.length,
        bytes: seen.reduce((n, f) => n + f.length, 0),
        leaked: seen.some(contains),
        detectorWorks: contains(control),
      }
    }, SECRET)

    if (wire.frames === 0) throw new Error('没抓到出站中继帧，检查手段失效')
    if (!wire.detectorWorks) throw new Error('明文探测函数自身失效，本条断言不成立')
    if (wire.leaked) throw new Error('明文出现在中继帧里——加密没有生效！')
    await until(b, (s) => window.__pphub.messages.some((m) => m.text === s), 'B 收到该消息', {
      arg: SECRET,
    })
    ok(
      `中继帧确为密文：抓到 ${wire.frames} 帧 / ${wire.bytes} 字节出站数据，均不含明文` +
        `（探测函数经阴性对照验证有效），而对端能正确解出`,
    )

    // —— 6. 屏幕共享在 http 下仍不可用，且原因要说对 ——
    const screen = await a.evaluate(() => ({
      displayMedia: window.__pphub.capabilities.displayMedia,
      encode: window.__pphub.capabilities.screenEncode,
      reachOk: window.__pphub.screenReach.ok,
    }))
    if (screen.displayMedia || screen.encode) {
      throw new Error(`http 下不该有采集/编码能力：${JSON.stringify(screen)}`)
    }
    if (screen.reachOk !== 0) throw new Error('预检应判定为不可达（无编码能力）')
    ok('屏幕共享在 http 下如实标为不可用（采集与 WebCodecs 均被浏览器禁用）')

    console.log(`\n全部通过（${passed} 项）`)
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`)
  process.exit(1)
})
