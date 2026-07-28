// 网络视图 + 名片 + 单播/广播 + 强制/懒发送（多源下载）E2E 冒烟。
//
// 场景（三端 A/B/C 口令房组网）：
//   1. 网络视图：节点数、连边渲染
//   2. 名片：A 改昵称/头像 → B/C 网络视图同步显示
//   3. 私聊：A→B 单播消息，C 不可见
//   4. 强制发送单播：A→B 直发文件，C 无记录
//   5. 懒发送广播：A 挂共享 → B 下载成功（A 供块）
//   6. 多源下载：B 完成后成为新源，C 下载时 B/A 均可供块（sources ≥ 1）
//   7. 私有白板：A↔B 画板同步，C 公共板不受污染
//
// 前置：cargo build && npm run build。运行：node scripts/e2e-network.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const PORT = 18091
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

async function until(page, fn, name, timeout = 20000) {
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

/** 通过隐藏 input 注入文件并触发发送。 */
async function injectFiles(page, files, mode, target) {
  await page.evaluate(
    ({ files, mode, target }) => {
      const store = window.__pphub
      const fs = files.map(
        (f) => new File([new Uint8Array(f.bytes)], f.name, { type: 'application/octet-stream' }),
      )
      store.dispatchFiles(fs, mode, target)
    },
    { files, mode, target },
  )
}

function randBytes(n) {
  const a = new Array(n)
  for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) % 256
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

    // —— 三端进同一口令房 ——
    const pages = []
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const ctx = await browser.newContext()
      const p = await ctx.newPage()
      await p.goto(BASE)
      await until(p, () => window.__pphub && window.__pphub.status !== 'connecting', `${name} 就绪`)
      await p.evaluate((n) => {
        window.__pphub.setNick(n)
        return window.__pphub.connectTo('e2e-net-room')
      }, name)
      pages.push(p)
    }
    const [a, b, c] = pages
    for (const [p, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
      await until(p, () => window.__pphub.connectedPeers.length === 2, `${name} 全连通`)
    }
    ok('三端口令房组网，全网状互连')

    // —— 1. 网络视图 ——
    await until(a, () => document.querySelectorAll('.stage .node').length === 3, 'A 网络视图节点')
    await until(
      a,
      () => document.querySelectorAll('.stage .wire.on').length >= 2,
      'A 连边高亮',
    )
    ok('网络视图：3 节点 + 直连边渲染')

    // link-state gossip：B↔C 的边也应出现在 A 的视图（共 3 条 on 边）。
    await until(
      a,
      () => document.querySelectorAll('.stage .wire.on').length >= 3,
      'A 看到 B↔C 边（gossip）',
    )
    ok('网络视图：对端↔对端连边经 link-state 同步')

    // —— 2. 名片同步 ——
    await a.evaluate(() => {
      window.__pphub.setNick('队长')
      window.__pphub.setAvatar({ kind: 'emoji', value: '🚀', color: '#e5484d' })
    })
    await until(
      b,
      () => document.body.innerText.includes('队长'),
      'B 看到 A 新昵称',
    )
    await until(
      b,
      () => [...document.querySelectorAll('.stage .node .avatar')].some((el) => el.textContent.includes('🚀')),
      'B 看到 A 新头像',
    )
    ok('名片：昵称 + emoji 头像实时同步到对端网络视图')

    // —— 3. 私聊（单播消息）——
    const aId = await a.evaluate(() => window.__pphub.myId)
    const bId = await b.evaluate(() => window.__pphub.myId)
    await a.evaluate((to) => window.__pphub.sendChat('悄悄话', to), bId)
    await until(
      b,
      () => window.__pphub.messages.some((m) => m.text === '悄悄话' && m.channel !== 'all'),
      'B 收到私聊',
    )
    const cSaw = await c.evaluate(() => window.__pphub.messages.some((m) => m.text === '悄悄话'))
    if (cSaw) throw new Error('私聊泄漏给了 C')
    ok('私聊：A→B 单播送达，C 不可见')

    // 群聊广播对照。
    await a.evaluate(() => window.__pphub.sendChat('大家好', 'all'))
    for (const [p, name] of [[b, 'B'], [c, 'C']]) {
      await until(p, () => window.__pphub.messages.some((m) => m.text === '大家好' && m.channel === 'all'), `${name} 收到群聊`)
    }
    ok('群聊：广播送达全网')

    // —— 4. 强制发送（单播）——
    await injectFiles(a, [{ name: 'force.bin', bytes: randBytes(96 * 1024) }], 'force', bId)
    await until(
      b,
      () => window.__pphub.transfers.some((t) => t.name === 'force.bin' && t.state === 'done'),
      'B 收完 force.bin',
    )
    const cGot = await c.evaluate(() => window.__pphub.transfers.length)
    if (cGot > 0) throw new Error('单播强制发送泄漏给了 C')
    ok('强制发送（单播）：A→B 立即推送完成，C 无记录')

    // —— 5. 懒发送（广播）+ 下载 ——
    await injectFiles(a, [{ name: 'lazy.bin', bytes: randBytes(300 * 1024) }], 'lazy', 'all')
    // A 端不应产生任何上行传输，只有共享登记。
    const aShares = await a.evaluate(() => window.__pphub.shareList.filter((s) => s.local).length)
    if (aShares !== 1) throw new Error('A 共享登记异常')
    for (const [p, name] of [[b, 'B'], [c, 'C']]) {
      await until(p, () => window.__pphub.shareList.some((s) => s.name === 'lazy.bin' && !s.local), `${name} 看到共享`)
    }
    ok('懒发送：只登记共享，全网可见，未推送字节')

    const fileId = await b.evaluate(
      () => window.__pphub.shareList.find((s) => s.name === 'lazy.bin').fileId,
    )
    await b.evaluate((id) => window.__pphub.downloadShare(id), fileId)
    await until(
      b,
      () => window.__pphub.shareList.find((s) => s.name === 'lazy.bin')?.state === 'done',
      'B 下载完成',
    )
    ok('懒发送：B 按需下载成功（A 供块）')

    // A 的供块计数应该增长。
    await until(a, () => window.__pphub.shareList.find((s) => s.local)?.served > 0, 'A 供块计数')
    ok('共享方 A 记录到供块活动')

    // —— 6. 多源：B 下载完成后成为源，C 再下载 ——
    await c.evaluate((id) => window.__pphub.downloadShare(id), fileId)
    await until(
      c,
      () => window.__pphub.shareList.find((s) => s.name === 'lazy.bin')?.state === 'done',
      'C 下载完成',
    )
    const cSources = await c.evaluate(
      () => window.__pphub.shareList.find((s) => s.name === 'lazy.bin').sources,
    )
    if (cSources < 2) throw new Error(`C 只发现 ${cSources} 个源，预期 ≥2（A+B）`)
    ok(`多源下载：C 从 ${cSources} 个源并行拉块（B 下载后自动成为新源）`)

    // —— 7. 私有白板 ——
    await a.evaluate((to) => window.__pphub.actionBoard(to), bId)
    await a.evaluate((to) => {
      const s = window.__pphub
      const boardId = s.dmBoardId(to)
      const id = s.beginStroke(boardId, 'pen', '#ff0000', 3, 0.2, 0.2)
      s.extendStroke(boardId, id, [0.4, 0.4, 0.6, 0.6])
      s.endStroke(boardId, id)
    }, bId)
    await until(
      b,
      () => {
        const s = window.__pphub
        // 找到含自己 id 的私板且有笔画。
        for (const m of s.memberList) {
          if (s.getBoard(s.dmBoardId(m.peerId)).length > 0) return true
        }
        return false
      },
      'B 私板同步',
      20000,
    )
    ok('私有白板：A→B 笔画同步')
    const cWb = await c.evaluate(() => window.__pphub.getBoard('wb').length)
    if (cWb > 0) throw new Error('私有白板泄漏到公共板')
    ok('私有白板：内容不出现在 C 的公共白板')

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
