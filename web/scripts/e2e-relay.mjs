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

async function main() {
  const server = spawn(
    path.join(ROOT, 'target/debug/pphub'),
    ['-H', '127.0.0.1', '-p', String(PORT)],
    { stdio: 'ignore' },
  )
  const browser = await chromium.launch({ executablePath: CHROMIUM })
  try {
    await new Promise((r) => setTimeout(r, 800))

    const pages = []
    for (const name of ['alpha', 'bravo']) {
      const ctx = await browser.newContext()
      // 在任何脚本执行前打开强制中继开关：本机两端本来能直连，
      // 不强制就测不到降级路径。
      await ctx.addInitScript(() => {
        localStorage.setItem('pphub:force:relay', 'true')
      })
      const p = await ctx.newPage()
      await p.goto(BASE)
      await until(p, () => window.__pphub && window.__pphub.status !== 'connecting', `${name} 就绪`)
      await p.evaluate((n) => {
        window.__pphub.setNick(n)
        return window.__pphub.connectTo('e2e-relay-room')
      }, name)
      pages.push(p)
    }
    const [a, b] = pages

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
