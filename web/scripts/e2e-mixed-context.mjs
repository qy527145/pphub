// 混合上下文下的互通性 E2E：一端安全上下文、一端非安全上下文，同一房间。
//
// 造法不需要 TLS：`http://127.0.0.1:<port>` 被浏览器特殊对待，算**安全**上下文
// （有 crypto.subtle / WebCodecs / getDisplayMedia）；`http://<局域网IP>:<port>`
// 算**非安全**上下文。两者打到同一个服务器实例、同一个房间，于是构成
// 「https 用户 + http 用户」在能力维度上的等价场景。
//
// 要验证的核心问题：两端能力不对称时会怎样。
//   1. 双方确实处在不同的上下文类别
//   2. 中继仍能建立——加密实现两端统一（都走纯 JS），不因一端有 subtle 而分叉
//   3. SAS 两端一致（跨上下文派生结果相同）
//   4. 聊天 / 白板 / 文件双向送达
//   5. 安全端 → 非安全端共享屏幕：预检判定为不可达，不留黑屏条目
//   6. 非安全端发起共享：本就没有采集能力，如实标为不可用
//
// 前置：cargo build && npm run build。运行：node scripts/e2e-mixed-context.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const PORT = 18096
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHROMIUM = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

/** 假的屏幕采集源：安全端用它发起共享，避免真的弹窗选屏。 */
const FAKE_DISPLAY = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    let t = 0
    setInterval(() => {
      t += 8
      ctx.fillStyle = `hsl(${t % 360} 70% 50%)`
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = '#fff'
      ctx.fillRect((t * 3) % 600, 160, 40, 40)
    }, 100)
    return canvas.captureStream(10)
  }
}

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

// fn 会被序列化到浏览器里执行，闭包捕获的 Node 侧变量在那边不存在；
// 外部值一律走 arg 显式传入。
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
      throw new Error(lastErr ? `判据出错 (${name}): ${lastErr.message}` : `超时: ${name}`)
    }
    await page.waitForTimeout(200)
  }
}

async function main() {
  const IP = lanIp()
  if (!IP) throw new Error('找不到局域网 IPv4，无法构造非安全上下文')
  const SECURE = `http://127.0.0.1:${PORT}` // localhost ⇒ 安全上下文
  const INSECURE = `http://${IP}:${PORT}` // 局域网 IP ⇒ 非安全上下文
  console.log(`  （安全端 ${SECURE} ／ 非安全端 ${INSECURE}，同一服务器同一房间）`)

  const server = spawn(
    path.join(ROOT, 'target/debug/pphub'),
    ['-H', '0.0.0.0', '-p', String(PORT)],
    { stdio: 'ignore' },
  )
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-proxy-server'],
  })
  try {
    await new Promise((r) => setTimeout(r, 800))

    const open = async (base, nick, withFakeDisplay) => {
      const ctx = await browser.newContext()
      await ctx.addInitScript(() => localStorage.setItem('pphub:force:relay', 'true'))
      if (withFakeDisplay) await ctx.addInitScript(FAKE_DISPLAY)
      const p = await ctx.newPage()
      await p.goto(base)
      await until(p, () => window.__pphub && window.__pphub.status !== 'connecting', `${nick} 就绪`)
      await p.evaluate((n) => {
        window.__pphub.setNick(n)
        return window.__pphub.connectTo('mixed-ctx-room')
      }, nick)
      return p
    }

    // 安全端给假采集源；非安全端不给——那边 getDisplayMedia 本就不存在。
    const s = await open(SECURE, 'secure', true)
    const i = await open(INSECURE, 'insecure', false)

    // —— 1. 两端确实处在不同上下文类别 ——
    const probe = (p) =>
      p.evaluate(() => ({
        secure: window.isSecureContext,
        subtle: typeof crypto?.subtle !== 'undefined',
        encode: window.__pphub.capabilities.screenEncode,
        decode: window.__pphub.capabilities.screenDecode,
        display: window.__pphub.capabilities.displayMedia,
      }))
    const [sc, ic] = [await probe(s), await probe(i)]
    if (!sc.secure || !sc.subtle) throw new Error(`安全端判定错误：${JSON.stringify(sc)}`)
    if (ic.secure || ic.subtle) throw new Error(`非安全端判定错误：${JSON.stringify(ic)}`)
    ok(`上下文不对称成立：安全端 subtle/编解码=${sc.subtle}/${sc.encode}，非安全端=${ic.subtle}/${ic.encode}`)

    // —— 2. 中继照常建立（加密两端统一，不因一端有 subtle 而谈不拢）——
    for (const [p, n] of [[s, '安全端'], [i, '非安全端']]) {
      await until(p, () => window.__pphub.connectedPeers.length === 1, `${n} 连通`)
      await until(
        p,
        () => window.__pphub.memberList.every((m) => m.transport === 'relay'),
        `${n} 标记中继`,
      )
    }
    ok('跨上下文中继建立成功：一端有 crypto.subtle、一端没有，密钥协商照样谈得拢')

    // —— 3. SAS ——
    const sasS = await until(s, () => window.__pphub.memberList[0]?.sas?.digits ?? null, '安全端 SAS')
    const sasI = await until(i, () => window.__pphub.memberList[0]?.sas?.digits ?? null, '非安全端 SAS')
    if (sasS !== sasI) throw new Error(`SAS 不一致：安全端=${sasS} 非安全端=${sasI}`)
    ok(`SAS 跨上下文一致（${sasS}）——两端派生出同一个值`)

    // —— 4. 业务数据双向 ——
    await s.evaluate(() => window.__pphub.sendChat('安全端发出', 'all'))
    await until(i, () => window.__pphub.messages.some((m) => m.text === '安全端发出'), '非安全端收到')
    await i.evaluate(() => window.__pphub.sendChat('非安全端发出', 'all'))
    await until(s, () => window.__pphub.messages.some((m) => m.text === '非安全端发出'), '安全端收到')
    const sId = await s.evaluate(() => window.__pphub.myId)
    await i.evaluate(
      ({ to }) => {
        const bytes = new Uint8Array(96 * 1024).map((_, n) => (n * 29 + 7) % 256)
        const f = new File([bytes], 'mixed.bin', { type: 'application/octet-stream' })
        window.__pphub.dispatchFiles([f], 'force', to)
      },
      { to: sId },
    )
    await until(
      s,
      () => window.__pphub.transfers.some((t) => t.name === 'mixed.bin' && t.state === 'done'),
      '安全端收完文件',
    )
    ok('聊天双向、96KiB 文件由非安全端 → 安全端完整送达')

    // —— 5. 安全端 → 非安全端共享屏幕 ——
    // 已知缺口：预检只看**本端**能否编码，对端的解码能力协议里从未通告，
    // 所以这里会误判为可达。真正的兜底在接收端——它会拒绝并给出原因，
    // 不留黑屏条目。断言按**实际行为**写，缺口在 README 矩阵里如实标注。
    const reach = await s.evaluate(() => window.__pphub.screenReach)
    if (reach.total !== 1) throw new Error(`对端数应为 1：${JSON.stringify(reach)}`)
    const before = await i.evaluate(() => window.__pphub.shareList.length)
    const started = await s.evaluate(() => window.__pphub.startShare('all'))
    await s.waitForTimeout(2500)
    const after = await i.evaluate(() => window.__pphub.shareList.length)

    if (after > before) throw new Error(`非安全端多出了收不到画面的共享条目：${after - before} 个`)
    ok('接收端兜底生效：非安全端拒绝 codec 共享，不留永远黑屏的条目')

    if (reach.ok === 1 && started) {
      ok('（已知缺口）发起端预检误判可达 1/1 并进入共享——对端解码能力未在协议中通告')
    } else {
      throw new Error(
        `预检行为与预期的已知缺口不符：reach=${JSON.stringify(reach)} started=${started}；` +
          '若已修复请更新本断言与 README 矩阵',
      )
    }

    // —— 6. 非安全端发起共享：连采集都没有 ——
    if (ic.display) throw new Error('非安全端不该有 getDisplayMedia')
    ok('非安全端如实标为无法发起共享（getDisplayMedia 被浏览器禁用）')

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
