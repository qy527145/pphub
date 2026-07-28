// 三端 E2E 冒烟：屏幕共享（伪造 getDisplayMedia 走完整媒体轨路径）+
// 观看端批注回显 + 远程指针 + 白板双向同步 + 迟到者全量同步 + 停止共享收尾。
//
// 前置：cargo build && npm run build（脚本直接跑 target/debug/pphub）。
// 运行：node scripts/e2e-media.mjs
//
// getDisplayMedia 在无头环境无真实桌面可采，注入 canvas.captureStream 假流；
// WebRTC 协商、媒体轨传输、DataChannel 全部走真实路径。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const PORT = 18090
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHROMIUM = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

const FAKE_DISPLAY = `
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640; canvas.height = 360
    const ctx = canvas.getContext('2d')
    let hue = 0
    setInterval(() => {
      hue = (hue + 7) % 360
      ctx.fillStyle = 'hsl(' + hue + ' 70% 50%)'
      ctx.fillRect(0, 0, 640, 360)
    }, 100)
    return canvas.captureStream(10)
  }
`

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

/** 轮询 page.evaluate(fn) 直到真值。 */
async function until(page, fn, name, timeout = 15000) {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn)
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`超时: ${name}`)
    await page.waitForTimeout(200)
  }
}

/** 叠加层笔画 canvas 是否有不透明像素。 */
const hasInk = () => {
  const c = document.querySelector('.drawlayer canvas')
  if (!c) return false
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true
  return false
}

/** 在 .drawlayer 上用真实鼠标事件画一笔斜线。 */
async function drawStroke(page) {
  const box = await page.locator('.drawlayer').boundingBox()
  const x0 = box.x + box.width * 0.3
  const y0 = box.y + box.height * 0.3
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x0 + i * box.width * 0.05, y0 + i * box.height * 0.05)
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
}

async function main() {
  const server = spawn(path.join(ROOT, 'target/debug/pphub'), ['-H', '127.0.0.1', '-p', String(PORT)], {
    stdio: 'ignore',
  })
  const browser = await chromium.launch({ executablePath: CHROMIUM })
  try {
    await new Promise((r) => setTimeout(r, 800))

    // —— A：开监听并拿短码；B：短码直连 ——
    const ctxA = await browser.newContext()
    const a = await ctxA.newPage()
    await a.addInitScript(FAKE_DISPLAY)
    await a.goto(BASE)
    const code = await until(a, () => sessionStorage.getItem('pphub.myCode'), 'A 短码')

    const ctxB = await browser.newContext()
    const b = await ctxB.newPage()
    await b.goto(`${BASE}/?c=${code}`)

    for (const [p, name] of [[a, 'A'], [b, 'B']]) {
      await p.locator('.nav-item', { hasText: '屏幕共享' }).click()
      await until(p, () => document.body.innerText.includes('还没有人共享屏幕'), `${name} 互连`)
    }
    ok('A/B 短码互连，进入屏幕共享页')

    // —— A 开始共享（假流），B 应收到真实媒体帧 ——
    await a.locator('button', { hasText: '共享我的屏幕' }).first().click()
    await until(a, () => !!document.querySelector('.stage video'), 'A 本地预览')
    ok('A 开始共享，本地预览出现')

    await until(b, () => {
      const v = document.querySelector('.stage video')
      return v && v.videoWidth === 640 && v.videoHeight === 360
    }, 'B 收到媒体流')
    ok('B 收到 640×360 屏幕画面（WebRTC 媒体轨直传）')

    // —— B 批注：画笔画一笔，A 预览应回显；B 光标出现在 A 侧 ——
    await b.getByTitle('画笔').click()
    await drawStroke(b)
    await until(a, hasInk, 'A 端批注回显')
    ok('B 在共享画面上批注，A 预览同步显示')
    await until(a, () => !!document.querySelector('.drawlayer .cursor'), 'A 端远程光标')
    ok('B 的远程指针显示在 A 端')

    // —— 白板：A 画，B 应同步 ——
    for (const p of [a, b]) await p.locator('.nav-item', { hasText: '互动白板' }).click()
    await until(a, () => !!document.querySelector('.drawlayer'), 'A 白板就绪')
    await drawStroke(a)
    await until(b, hasInk, 'B 白板同步')
    ok('白板笔画 A → B 实时同步')

    // —— C 迟到加入：应通过 draw-state 拿到全量白板 ——
    const ctxC = await browser.newContext()
    const c = await ctxC.newPage()
    await c.goto(`${BASE}/?c=${code}`)
    await c.locator('.nav-item', { hasText: '互动白板' }).click()
    await until(c, hasInk, 'C 迟到者全量同步', 20000)
    ok('迟到加入的 C 收到白板全量状态')

    // —— A 停止共享，B 画面撤下 ——
    await a.locator('.nav-item', { hasText: '屏幕共享' }).click()
    await a.getByRole('button', { name: '停止共享' }).click()
    await b.locator('.nav-item', { hasText: '屏幕共享' }).click()
    await until(b, () => document.body.innerText.includes('还没有人共享屏幕'), 'B 画面撤下')
    ok('A 停止共享，B 端画面正确撤下')

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
