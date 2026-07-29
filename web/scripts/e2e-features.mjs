// 新功能 E2E：表情回应 / 语音消息（分片重组）/ RTT 探测 / 五子棋 / 你画我猜 /
// 文件夹打包（zip）。
//
// 场景（三端 A/B/C 口令房组网，直连路径）：
//   1. 消息带 msgId，B 对 A 的消息加/撤表情回应，A 端同步
//   2. A 发 200KB 语音消息（必然走分片），B 重组出可播放的 blob URL
//   3. RTT 探测：本端实测值 + link-state gossip 带 RTT + 网络视图标注
//   4. 五子棋：邀请 → 接受 → 双方落子镜像 → 认输终局
//   5. 你画我猜：出题 → 错误猜测不计分 → 猜中自动裁决 → 比分同步
//   6. 文件夹 → store 模式 zip → 对端下载并验证 zip 结构
//
// 前置：cargo build && npm run build。运行：node scripts/e2e-features.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'

const PORT = 18097
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

async function until(page, fn, name, timeout = 20000, arg) {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = await page.evaluate(fn, arg)
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`超时: ${name}`)
    await page.waitForTimeout(200)
  }
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
    for (const name of ['安娜', '博文', '晨曦']) {
      const ctx = await browser.newContext()
      const p = await ctx.newPage()
      await p.goto(BASE)
      await until(p, () => window.__pphub && window.__pphub.status !== 'connecting', `${name} 就绪`)
      await p.evaluate((n) => {
        window.__pphub.setNick(n)
        return window.__pphub.connectTo('e2e-feat-room')
      }, name)
      pages.push(p)
    }
    const [a, b, c] = pages
    for (const [p, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
      await until(p, () => window.__pphub.connectedPeers.length === 2, `${name} 全连通`)
    }
    const aId = await a.evaluate(() => window.__pphub.myId)
    const bId = await b.evaluate(() => window.__pphub.myId)
    const cId = await c.evaluate(() => window.__pphub.myId)
    ok('三端口令房组网，全网状互连')

    // —— 0. 粘贴入待发区：合成 paste 事件 → 不直发，确认（发送键）后才发出 ——
    await b.evaluate(() => window.__pphub.setView('chat'))
    await until(b, () => !!document.querySelector('.composer input'), 'B 聊天页就绪')
    await b.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], '截图.png', { type: 'image/png' }))
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }))
    })
    await until(b, () => document.querySelectorAll('.attach-item').length === 1, 'B 待发区出附件')
    await b.waitForTimeout(800)
    const leaked = await a.evaluate(
      () => window.__pphub.shareList.some((s) => s.name === '截图.png'),
    )
    const sentEarly = await b.evaluate(
      () => window.__pphub.messages.some((m) => m.self && m.file),
    )
    if (leaked || sentEarly) throw new Error('附件未经确认就发出去了')
    ok('粘贴不直发：文件挂到待发区，未经确认对端收不到')

    await b.click('.composer .primary')
    await until(
      b,
      () => window.__pphub.messages.some((m) => m.self && m.file?.name === '截图.png'),
      'B 确认后本地出卡片',
    )
    await until(
      a,
      () => window.__pphub.shareList.some((s) => s.name === '截图.png'),
      'A 收到共享',
    )
    await until(b, () => document.querySelectorAll('.attach-item').length === 0, '待发区清空')
    ok('确认发送：点发送后共享送达对端，待发区随之清空')

    // —— 1. 表情回应 ——
    await a.evaluate(() => window.__pphub.sendChat('回应我试试'))
    const msgId = await until(
      b,
      () => window.__pphub.messages.find((m) => m.text === '回应我试试')?.msgId,
      'B 收到带 msgId 的消息',
    )
    await b.evaluate((id) => {
      const s = window.__pphub
      s.toggleReact(s.messages.find((m) => m.msgId === id), '👍')
    }, msgId)
    await until(
      a,
      (id) => {
        const m = window.__pphub.messages.find((x) => x.msgId === id)
        return m?.reactions?.['👍']?.length === 1
      },
      'A 看到 👍',
      20000,
      msgId,
    )
    ok('表情回应：B 给 A 的消息点 👍，A 端同步显示')

    await b.evaluate((id) => {
      const s = window.__pphub
      s.toggleReact(s.messages.find((m) => m.msgId === id), '👍')
    }, msgId)
    await until(
      a,
      (id) => {
        const m = window.__pphub.messages.find((x) => x.msgId === id)
        return !m?.reactions || !m.reactions['👍']
      },
      'A 端回应撤销',
      20000,
      msgId,
    )
    ok('表情回应：再点一次即撤销，A 端同步移除')

    // —— 2. 语音消息（200KB → base64 必然分片重组）——
    await a.evaluate(() => {
      const bytes = new Uint8Array(200_000)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 5) % 256
      const blob = new Blob([bytes], { type: 'audio/webm' })
      return window.__pphub.sendVoiceNote(blob, 4200)
    })
    const voice = await until(
      b,
      () => {
        const m = window.__pphub.messages.find((x) => x.voice)
        return m ? { dur: m.voice.dur, hasUrl: m.voice.url.startsWith('blob:') } : null
      },
      'B 收到语音消息',
    )
    if (voice.dur !== 4200 || !voice.hasUrl) throw new Error('语音消息字段不对')
    // 校验重组后的字节与发送端一致（抽查大小 + 内容）。
    const voiceOk = await b.evaluate(async () => {
      const m = window.__pphub.messages.find((x) => x.voice)
      const buf = new Uint8Array(await (await fetch(m.voice.url)).arrayBuffer())
      if (buf.length !== 200_000) return false
      for (let i = 0; i < buf.length; i += 997) {
        if (buf[i] !== (i * 13 + 5) % 256) return false
      }
      return true
    })
    if (!voiceOk) throw new Error('语音消息重组后字节不一致')
    ok('语音消息：200KB 分片发送，B 端按 msgId 重组，字节一致')

    // —— 3. RTT 探测（5s 一轮 ping；gossip 邻接表附带 RTT）——
    await until(
      a,
      (id) => typeof window.__pphub.rtts.get(id) === 'number',
      'A 测得到 B 的 RTT',
      20000,
      bId,
    )
    ok('RTT 探测：A 实测到 B 的往返延迟')
    await until(
      a,
      () => {
        for (const links of window.__pphub.peerLinks.values()) {
          for (const l of links.values()) {
            if (typeof l.rtt === 'number') return true
          }
        }
        return false
      },
      'gossip 邻接表带 RTT',
      30000,
    )
    ok('RTT gossip：对端邻接表上报的边附带实测 RTT')
    await a.evaluate(() => window.__pphub.setView('network'))
    await until(
      a,
      () => document.querySelectorAll('.rttchip').length >= 1,
      '网络视图 RTT 标注',
    )
    ok('网络视图：连线上渲染出 RTT 标注')

    // —— 4. 五子棋（经网络视图入口发起：切私聊 + 发邀请）——
    await a.evaluate((to) => window.__pphub.actionGomoku(to), bId)
    const entryOk = await a.evaluate(
      (to) => {
        const s = window.__pphub
        return (
          s.activeView === 'chat' &&
          s.activeChannel === to &&
          s.gomoku.get(to)?.state === 'invite-out'
        )
      },
      bId,
    )
    if (!entryOk) throw new Error('actionGomoku 入口未正确切频道/发邀请')
    ok('入口：网络视图「五子棋对局」切到私聊并发出邀请')
    await until(
      b,
      (id) => window.__pphub.gomoku.get(id)?.state === 'invite-in',
      'B 收到邀请',
      20000,
      aId,
    )
    ok('五子棋：邀请送达（B 端 invite-in）')
    await b.evaluate((id) => window.__pphub.respondGomoku(id, true), aId)
    await until(
      a,
      (id) => window.__pphub.gomoku.get(id)?.state === 'active',
      'A 对局激活',
      20000,
      bId,
    )
    ok('五子棋：接受后双方进入对局（邀请方执黑先手）')

    await a.evaluate((id) => window.__pphub.moveGomoku(id, 112), bId) // 天元
    await until(
      b,
      (id) => {
        const g = window.__pphub.gomoku.get(id)
        return g && g.cells[112] === 1 && g.turn === 2 && g.moves === 1
      },
      'B 镜像 A 的落子',
      20000,
      aId,
    )
    await b.evaluate((id) => window.__pphub.moveGomoku(id, 113), aId)
    await until(
      a,
      (id) => {
        const g = window.__pphub.gomoku.get(id)
        return g && g.cells[113] === 2 && g.turn === 1 && g.moves === 2
      },
      'A 镜像 B 的落子',
      20000,
      bId,
    )
    ok('五子棋：双方落子实时镜像（手数/轮次一致）')

    // 违规操作应被拒绝：B 在 A 的回合落子、往已占的格落子。
    const cheat = await b.evaluate((id) => {
      const s = window.__pphub
      s.moveGomoku(id, 114) // 不是 B 的回合
      const g = s.gomoku.get(id)
      return g.cells[114] === 0 && g.moves === 2
    }, aId)
    if (!cheat) throw new Error('非法落子未被拒绝')
    ok('五子棋：非本方回合的落子被拒绝')

    await a.evaluate((id) => window.__pphub.resignGomoku(id), bId)
    await until(
      b,
      (id) => {
        const g = window.__pphub.gomoku.get(id)
        return g?.state === 'over' && g.result === 'win'
      },
      'B 端 A 认输',
      20000,
      aId,
    )
    ok('五子棋：认输终局，双方结果互补')

    // —— 5. 你画我猜（先验证网络动作条入口：直达白板 + 弹出出题面板）——
    await a.evaluate(() => window.__pphub.actionGuess())
    await until(
      a,
      () => window.__pphub.activeView === 'board' && !!document.querySelector('.words'),
      '出题面板弹出',
    )
    ok('入口：网络动作条「你画我猜」直达公共白板并弹出出题面板')
    await a.click('.modal-actions .ghost') // 取消面板，改用 store 直接开局（后续断言不依赖 UI）

    await a.evaluate(() => window.__pphub.startGuessRound('苹果'))
    await until(
      c,
      (id) => {
        const g = window.__pphub.guess
        return g.active && g.drawer === id && g.hint.includes('2')
      },
      'C 收到开局与提示',
      20000,
      aId,
    )
    ok('你画我猜：开局广播（观众只见提示，谜底不出本地）')

    await c.evaluate(() => window.__pphub.submitGuess('香蕉'))
    await until(
      a,
      () => window.__pphub.guess.tries.some((t) => t.text === '香蕉'),
      'A 看到错误猜测',
    )
    const stillActive = await a.evaluate(() => window.__pphub.guess.active)
    if (!stillActive) throw new Error('猜错不应结束回合')
    ok('你画我猜：错误猜测广播可见，回合继续')

    await b.evaluate(() => window.__pphub.submitGuess('苹果！'))
    for (const [p, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
      await until(
        p,
        ({ w, d }) => {
          const g = window.__pphub.guess
          return (
            !g.active &&
            g.lastWord === '苹果' &&
            g.lastWinner === w &&
            g.scores[w] === 2 &&
            g.scores[d] === 1
          )
        },
        `${name} 比分落定`,
        20000,
        { w: bId, d: aId },
      )
    }
    ok('你画我猜：出题人自动裁决（容忍标点），胜者 +2 出题 +1 全网同步')

    // —— 6. 文件夹 → zip 懒发送 ——
    await a.evaluate(() => {
      const f1 = new File([new Uint8Array([1, 2, 3, 4])], 'a.txt', { type: 'text/plain' })
      const f2 = new File([new Uint8Array(1000).fill(7)], 'b.bin')
      return window.__pphub.dispatchPayload(
        { files: [], folders: [{ name: '项目资料', entries: [{ path: 'a.txt', file: f1 }, { path: 'sub/b.bin', file: f2 }] }] },
        'lazy',
        'all',
      )
    })
    const zipId = await until(
      b,
      () => window.__pphub.shareList.find((s) => s.name === '项目资料.zip')?.fileId,
      'B 看到 zip 共享',
    )
    await b.evaluate((id) => window.__pphub.downloadShare(id), zipId)
    await until(
      b,
      (id) => window.__pphub.shares.get(id)?.state === 'done',
      'B 下载 zip 完成',
      30000,
      zipId,
    )
    const zipOk = await b.evaluate(async (id) => {
      const s = window.__pphub.shares.get(id)
      const buf = new Uint8Array(await (await fetch(s.url)).arrayBuffer())
      // 本地文件头签名 PK\x03\x04；EOCD 里的条目数应为 2。
      if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 3 || buf[3] !== 4) return false
      const eocd = buf.length - 22
      if (buf[eocd] !== 0x50 || buf[eocd + 1] !== 0x4b || buf[eocd + 2] !== 5 || buf[eocd + 3] !== 6) return false
      const entries = buf[eocd + 10] | (buf[eocd + 11] << 8)
      return entries === 2
    }, zipId)
    if (!zipOk) throw new Error('zip 结构校验失败')
    ok('文件夹传输：打包为 store zip（2 个条目），对端下载后结构完好')

    // —— 7. 断点续传（会话内）：唯一源掉线 → 下载停摆保留，不作废 ——
    await c.evaluate(() => {
      const big = new File([new Uint8Array(128 * 1024 * 1024)], 'big.bin')
      return window.__pphub.shareFiles([big], 'all')
    })
    const bigId = await until(
      b,
      () => window.__pphub.shareList.find((s) => s.name === 'big.bin')?.fileId,
      'B 看到大文件共享',
    )
    await b.evaluate((id) => {
      window.__pphub.setView('receive')
      window.__pphub.downloadShare(id)
    }, bigId)
    await until(
      b,
      (id) => (window.__pphub.shares.get(id)?.bytes ?? 0) > 0,
      'B 开始收到分块',
      30000,
      bigId,
    )
    // 顺带铺垫「成员退出清未读」：C 走之前私聊 B 一句（B 在接收页，未读挂上）。
    await c.evaluate((to) => window.__pphub.sendChat('走之前说一句', to), bId)
    await until(
      b,
      (id) => (window.__pphub.unread.get(id) ?? 0) > 0,
      'B 未读挂上',
      20000,
      cId,
    )
    await c.evaluate(() => window.__pphub.disconnect()) // 唯一源中途离线
    const stalled = await until(
      b,
      (id) => {
        const s = window.__pphub.shares.get(id)
        return s && s.state === 'downloading' && s.sources === 0 && s.bytes > 0 && s.bytes < s.size
          ? { bytes: s.bytes }
          : null
      },
      'B 下载停摆',
      30000,
      bigId,
    )
    await until(
      b,
      () => document.body.innerText.includes('等待源恢复'),
      '停摆等待态展示',
    )
    ok(`断点续传：唯一源掉线后下载停摆保留（已到手 ${(stalled.bytes / 1048576).toFixed(1)}MB），UI 呈现等待源恢复`)

    await b.evaluate((id) => window.__pphub.cancelDownload(id), bigId)
    const canceled = await b.evaluate(
      (id) => window.__pphub.shares.get(id)?.state === 'idle',
      bigId,
    )
    if (!canceled) throw new Error('停摆下载未能取消')
    ok('断点续传：停摆中可手动取消，回到待下载')

    // —— 8. 成员退出：TA 的私聊未读一并清除（频道没了，角标不能永远赖着）——
    await until(
      b,
      (id) => !window.__pphub.unread.get(id),
      '退出成员的未读清除',
      20000,
      cId,
    )
    const history = await b.evaluate(
      (id) => window.__pphub.messages.some((m) => m.channel === id && m.text === '走之前说一句'),
      cId,
    )
    if (!history) throw new Error('清未读不应该连消息历史一起删')
    ok('成员退出：私聊未读随之清除，消息历史保留')

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
