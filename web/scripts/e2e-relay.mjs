// 单端口（WS 应用层中继）E2E：服务器按默认方式启动（不加 --stun-turn，因而
// 只监听 HTTP 端口），浏览器侧打开 `pphub:force:relay` 开关跳过 WebRTC，
// 验证降级路径本身完整可用。
//
// 覆盖：
//   1. 降级链路建立：两端 transport=relay，状态显示为已连接
//   2. 端到端加密：ECDH 派生的 SAS 两端一致（服务器只转发密文）
//   3. 聊天（control 通道）
//   4. 白板（control 通道，高频小消息）
//   5. 强制发送文件（独立 file 通道 + 背压）
//   6. 懒发送 + 多源下载（swarm 通道 + 分块协议）
//   7. 屏幕共享（WebCodecs 自编码后走 screen 通道，媒体轨过不了应用层中继）
//   8. 解不了码的对端不会出现「永远黑屏」的画面条目
//
// 前置：cargo build && npm run build。运行：node scripts/e2e-relay.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const PORT = 18093
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHROMIUM = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

// 无头环境没有真实桌面可采，注入一张不断变色的画布充当屏幕。
// 变色是有意的：能据此判断对端画面是在持续更新，而不是只解出了一帧。
const FAKE_DISPLAY = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    let hue = 0
    setInterval(() => {
      hue = (hue + 37) % 360
      ctx.fillStyle = `hsl(${hue} 70% 50%)`
      ctx.fillRect(0, 0, 640, 360)
    }, 100)
    return canvas.captureStream(10)
  }
}

async function until(page, fn, name, timeout = 25000) {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = await page.evaluate(fn)
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`超时: ${name}`)
    await page.waitForTimeout(200)
  }
}

function randBytes(n) {
  const a = new Array(n)
  for (let i = 0; i < n; i++) a[i] = (i * 37 + 11) % 256
  return a
}

/**
 * 新开一个浏览器上下文并加入测试房间。
 * 所有节点都在任何脚本执行前打开强制中继开关：本机两端本来能直连，
 * 不强制就测不到降级路径。
 */
async function join(browser, name, { fakeDisplay = false, noDecoder = false } = {}) {
  const ctx = await browser.newContext()
  await ctx.addInitScript(() => {
    localStorage.setItem('pphub:force:relay', 'true')
  })
  if (fakeDisplay) await ctx.addInitScript(FAKE_DISPLAY)
  // 模拟不支持 WebCodecs 解码的浏览器（移动端 / 老版本）。
  if (noDecoder) await ctx.addInitScript(() => delete window.VideoDecoder)
  const p = await ctx.newPage()
  await p.goto(BASE)
  await until(p, () => window.__pphub && window.__pphub.status !== 'connecting', `${name} 就绪`)
  await p.evaluate((n) => {
    window.__pphub.setNick(n)
    return window.__pphub.connectTo('e2e-relay-room')
  }, name)
  return p
}

async function main() {
  const server = spawn(
    path.join(ROOT, 'target/debug/pphub'),
    ['-H', '127.0.0.1', '-p', String(PORT)],
    { stdio: 'ignore' },
  )
  const browser = await chromium.launch({ executablePath: CHROMIUM })
  try {
    await new Promise((r) => setTimeout(r, 800))

    const a = await join(browser, 'alpha', { fakeDisplay: true })
    const b = await join(browser, 'bravo')

    // —— 1. 降级链路建立 ——
    for (const [p, name] of [[a, 'A'], [b, 'B']]) {
      await until(p, () => window.__pphub.connectedPeers.length === 1, `${name} 经中继连通`)
      await until(
        p,
        () => window.__pphub.memberList.every((m) => m.transport === 'relay'),
        `${name} 标记为中继传输`,
      )
    }
    ok('单端口模式：WebRTC 不可用时经 WS 中继建立连接')

    await until(a, () => document.body.innerText.includes('中继'), 'A 视图显示中继标记')
    ok('网络视图明确标注「中继」而非伪装成直连')

    // —— 2. 端到端加密：SAS 两端一致 ——
    const sasA = await until(
      a,
      () => window.__pphub.memberList[0]?.sas?.digits ?? null,
      'A 派生 SAS',
    )
    const sasB = await until(
      b,
      () => window.__pphub.memberList[0]?.sas?.digits ?? null,
      'B 派生 SAS',
    )
    if (sasA !== sasB) throw new Error(`SAS 不一致：A=${sasA} B=${sasB}`)
    ok(`端到端加密：ECDH 派生的 SAS 两端一致（${sasA}）`)

    // —— 3. 聊天 ——
    const bId = await b.evaluate(() => window.__pphub.myId)
    await a.evaluate(() => window.__pphub.sendChat('中继群聊', 'all'))
    await until(
      b,
      () => window.__pphub.messages.some((m) => m.text === '中继群聊' && m.channel === 'all'),
      'B 收到群聊',
    )
    await a.evaluate((to) => window.__pphub.sendChat('中继私聊', to), bId)
    await until(
      b,
      () => window.__pphub.messages.some((m) => m.text === '中继私聊' && m.channel !== 'all'),
      'B 收到私聊',
    )
    ok('control 通道：群聊与私聊经中继送达')

    // —— 4. 白板 ——
    await a.evaluate(() => {
      const s = window.__pphub
      const id = s.beginStroke('wb', 'pen', '#00aaff', 3, 0.1, 0.1)
      s.extendStroke('wb', id, [0.3, 0.3, 0.5, 0.5])
      s.endStroke('wb', id)
    })
    await until(b, () => window.__pphub.getBoard('wb').length > 0, 'B 白板同步')
    ok('control 通道：白板笔画经中继同步')

    // —— 5. 强制发送文件 ——
    await a.evaluate(
      ({ bytes, to }) => {
        const f = new File([new Uint8Array(bytes)], 'relay.bin', {
          type: 'application/octet-stream',
        })
        window.__pphub.dispatchFiles([f], 'force', to)
      },
      { bytes: randBytes(256 * 1024), to: bId },
    )
    await until(
      b,
      () => window.__pphub.transfers.some((t) => t.name === 'relay.bin' && t.state === 'done'),
      'B 收完 relay.bin',
    )
    ok('file 通道：256KiB 文件经中继完整送达')

    // —— 6. 懒发送 + 多源下载（swarm 分块协议）——
    await a.evaluate(
      ({ bytes }) => {
        const f = new File([new Uint8Array(bytes)], 'relay-lazy.bin', {
          type: 'application/octet-stream',
        })
        window.__pphub.dispatchFiles([f], 'lazy', 'all')
      },
      { bytes: randBytes(300 * 1024) },
    )
    await until(
      b,
      () => window.__pphub.shareList.some((s) => s.name === 'relay-lazy.bin' && !s.local),
      'B 看到共享',
    )
    const fileId = await b.evaluate(
      () => window.__pphub.shareList.find((s) => s.name === 'relay-lazy.bin').fileId,
    )
    await b.evaluate((id) => window.__pphub.downloadShare(id), fileId)
    await until(
      b,
      () => window.__pphub.shareList.find((s) => s.name === 'relay-lazy.bin')?.state === 'done',
      'B 下载完成',
    )
    ok('swarm 通道：懒发送共享的分块下载经中继完成')

    // —— 7. 屏幕共享（WebCodecs → screen 通道）——
    const reach = await a.evaluate(() => ({
      encode: window.__pphub.capabilities.screenEncode,
      ok: window.__pphub.screenReach.ok,
    }))
    if (!reach.encode) throw new Error('该 Chromium 无 WebCodecs 编码能力，测不了中继屏幕共享')
    if (reach.ok !== 1) throw new Error(`预检误判可达节点数：ok=${reach.ok}`)
    ok('共享前预检：中继对端被判定为可接收画面')

    const started = await a.evaluate(() => window.__pphub.startShare('all'))
    if (!started) {
      const why = await a.evaluate(() => window.__pphub.lastError)
      throw new Error(`A 共享未启动：${why}`)
    }
    await until(b, () => window.__pphub.sharers.length === 1, 'B 感知到共享')
    await until(b, () => window.__pphub.remoteScreens.size === 1, 'B 解出画面', 30000)
    ok('screen 通道：A 自编码的画面在 B 端解码成 MediaStream')

    await b.evaluate(() => window.__pphub.setView('screen'))
    await until(
      b,
      () => {
        const v = document.querySelector('.stage video')
        return v && v.videoWidth === 640 && v.videoHeight === 360
      },
      'B 画面尺寸',
    )
    ok('B 端画面为原始的 640×360，可直接进入既有渲染 / 批注链路')

    const moving = await b.evaluate(async () => {
      const v = document.querySelector('.stage video')
      const c = document.createElement('canvas')
      c.width = 8
      c.height = 8
      const ctx = c.getContext('2d')
      const sample = () => {
        ctx.drawImage(v, 0, 0, 8, 8)
        return ctx.getImageData(0, 0, 8, 8).data.join()
      }
      const first = sample()
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (sample() !== first) return true
      }
      return false
    })
    if (!moving) throw new Error('B 端画面静止：只解出了首帧，编码流没有持续')
    ok('画面持续更新（非单帧），编解码流水线在中继上稳定运行')

    // —— 8. 解不了码的对端不应出现「永远黑屏」的条目 ——
    const c = await join(browser, 'charlie', { noDecoder: true })
    await until(c, () => window.__pphub.connectedPeers.length === 2, 'C 连上 A/B')
    // C 入网后 A 会自动补挂共享，此时才会给 C 发 screen-start。
    await until(c, () => (window.__pphub.lastError ?? '').includes('WebCodecs'), 'C 收到明确提示')
    const phantom = await c.evaluate(() => window.__pphub.sharers.length)
    if (phantom !== 0) throw new Error(`C 出现了收不到画面的共享条目：${phantom} 个`)
    ok('无解码能力的节点：给出原因提示，且不生成永远黑屏的画面条目')

    // —— 9. 停止共享的收尾 ——
    await a.evaluate(() => window.__pphub.stopShare())
    await until(
      b,
      () => window.__pphub.sharers.length === 0 && window.__pphub.remoteScreens.size === 0,
      'B 画面撤下',
    )
    ok('停止共享后对端画面与解码器一并释放')

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
