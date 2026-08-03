<script setup lang="ts">
// 你画我猜（桌内联机）。同步模型见 utils/drawguess.ts：
// 一轮之内当前出题人是唯一写方（画笔/裁决/公布/翻页），谜底只留在出题人本地，
// 猜测走 game-chat（全桌可见），命中由出题人本地比对后回填。
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoomStore } from '@/stores/room'
import type { GameTable } from '@/core/games'
import AppIcon from './AppIcon.vue'
import {
  initDrawGuess,
  beginDrawing,
  settleWin,
  settleTimeout,
  nextRound,
  reassignDrawer,
  isDrawGuessState,
  pickWords,
  normalizeGuess,
  DG_W,
  DG_H,
  ROUND_END_SECONDS,
  type DrawGuessState,
} from '@/utils/drawguess'

const props = defineProps<{ table: GameTable }>()
const store = useRoomStore()

// 座位以开局冻结的 roster 为准（离席回座不错位），回退当前 players。
const seatsBase = computed(() =>
  props.table.roster && props.table.roster.length ? props.table.roster : props.table.players,
)
const isHost = computed(() => props.table.hostId === store.myId)

const existing = store.gameStates.get(props.table.tableId)
const gs = ref<DrawGuessState | null>(isDrawGuessState(existing) ? existing : null)

// 桌主开局播种（只有一端初始化，保证各端一致）。
watch(
  () => props.table.state,
  (s) => {
    if (s === 'playing' && isHost.value && !gs.value) {
      const initial = initDrawGuess(seatsBase.value)
      gs.value = initial
      store.sendGameMove(props.table.tableId, initial)
    }
  },
  { immediate: true },
)

// 消费远端状态：game-move → gameStates，ver 单调递增才采纳（自己的回灌 ver 相等被跳过）。
watch(
  () => store.gameStates.get(props.table.tableId),
  (remote) => {
    if (!isDrawGuessState(remote)) return
    if (gs.value && remote.ver <= gs.value.ver) return
    gs.value = remote
  },
  { deep: true },
)

const seats = computed(() => gs.value?.seats ?? seatsBase.value)
const mySeat = computed(() => seats.value.indexOf(store.myId))
const iAmPlayer = computed(() => mySeat.value >= 0)
const isDrawer = computed(() => !!gs.value && gs.value.drawerId === store.myId)
const phase = computed(() => gs.value?.phase ?? null)

function nick(peerId: string): string {
  return store.displayName(peerId)
}

// —— 计时与出题人/桌主的推进逻辑（每 250ms 一拍）——
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
const advanceAt = ref(0) // 结算展示到期时间（仅出题人本地用于翻页）
let drawerGoneSince = 0 // 出题人离席起始时刻（仅桌主兜底用）

const secLeft = computed(() => {
  const g = gs.value
  if (!g || g.phase !== 'drawing' || !g.roundEndsAt) return 0
  return Math.max(0, Math.ceil((g.roundEndsAt - now.value) / 1000))
})

function tick(): void {
  now.value = Date.now()
  const g = gs.value
  if (!g) return

  // 出题人：作画超时且无人猜中 → 公布谜底。
  if (isDrawer.value && g.phase === 'drawing' && g.roundEndsAt && now.value > g.roundEndsAt && !g.winnerId && myWord.value) {
    const ns = settleTimeout(g, myWord.value)
    gs.value = ns
    store.sendGameMove(props.table.tableId, ns)
    advanceAt.value = now.value + ROUND_END_SECONDS * 1000
    return
  }

  // 出题人：结算展示若干秒后翻到下一位。
  if (isDrawer.value && g.phase === 'roundend' && advanceAt.value && now.value > advanceAt.value) {
    const ns = nextRound(g, new Set(props.table.players))
    gs.value = ns
    store.sendGameMove(props.table.tableId, ns)
    advanceAt.value = 0
    myWord.value = ''
    return
  }

  // 桌主兜底：出题人离席过久则把出题权转交在座者，避免整局卡死。
  if (isHost.value && (g.phase === 'picking' || g.phase === 'drawing')) {
    if (!props.table.players.includes(g.drawerId)) {
      if (!drawerGoneSince) {
        drawerGoneSince = now.value
      } else if (now.value - drawerGoneSince > 8000) {
        const ns = reassignDrawer(g, new Set(props.table.players))
        if (ns !== g) {
          gs.value = ns
          store.sendGameMove(props.table.tableId, ns)
        }
        drawerGoneSince = 0
      }
    } else {
      drawerGoneSince = 0
    }
  }
}

onMounted(() => {
  timer = setInterval(tick, 250)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (bcTimer) clearTimeout(bcTimer)
})

// —— 出题人本地：候选词与谜底 ——
const myWord = ref('') // 本地谜底，绝不进入同步状态
const choices = ref<string[]>([])

watch(
  [isDrawer, phase],
  () => {
    if (isDrawer.value && phase.value === 'picking') {
      if (choices.value.length === 0) choices.value = pickWords(3)
    } else {
      choices.value = []
      if (phase.value !== 'drawing') myWord.value = '' // 离开作画阶段清空本地谜底
    }
  },
  { immediate: true },
)

function pick(w: string): void {
  const g = gs.value
  if (!g || !isDrawer.value || phase.value !== 'picking') return
  myWord.value = w
  choices.value = []
  const ns = beginDrawing(g, w, Date.now())
  gs.value = ns
  store.sendGameMove(props.table.tableId, ns)
  // 只裁决作画开始之后的猜测。
  lastGuessIdx = chats.value.length
}

// —— 画布：仅出题人在作画阶段可画 ——
const PALETTE = ['#111111', '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#ffffff']
const drawColor = ref('#111111')
const drawSize = ref(6)
const canDraw = computed(() => isDrawer.value && phase.value === 'drawing')
const svgRef = ref<SVGSVGElement | null>(null)
let drawingNow = false

// —— 广播节流：作画高频，最多 ~12fps 全量广播；提交/清空立即广播 ——
let bcTimer: ReturnType<typeof setTimeout> | null = null
let lastBc = 0
function scheduleBroadcast(): void {
  if (bcTimer) return
  const wait = Math.max(0, 80 - (Date.now() - lastBc))
  bcTimer = setTimeout(() => {
    bcTimer = null
    flushBroadcast()
  }, wait)
}
function flushBroadcast(): void {
  if (bcTimer) {
    clearTimeout(bcTimer)
    bcTimer = null
  }
  if (!gs.value) return
  lastBc = Date.now()
  gs.value.ver++
  store.sendGameMove(props.table.tableId, gs.value)
}

function toLogical(ev: PointerEvent): [number, number] {
  const svg = svgRef.value
  if (!svg) return [0, 0]
  const r = svg.getBoundingClientRect()
  const x = ((ev.clientX - r.left) / r.width) * DG_W
  const y = ((ev.clientY - r.top) / r.height) * DG_H
  return [Math.max(0, Math.min(DG_W, Math.round(x))), Math.max(0, Math.min(DG_H, Math.round(y)))]
}

function onDown(ev: PointerEvent): void {
  if (!canDraw.value || !gs.value) return
  drawingNow = true
  ;(ev.target as Element).setPointerCapture?.(ev.pointerId)
  const [x, y] = toLogical(ev)
  gs.value.live = { color: drawColor.value, size: drawSize.value, points: [x, y] }
  scheduleBroadcast()
}
function onMove(ev: PointerEvent): void {
  if (!drawingNow || !canDraw.value || !gs.value?.live) return
  const [x, y] = toLogical(ev)
  const pts = gs.value.live.points
  // 去抖：与上一点重合则忽略，避免点堆积。
  if (pts.length >= 2 && pts[pts.length - 2] === x && pts[pts.length - 1] === y) return
  pts.push(x, y)
  scheduleBroadcast()
}
function onUp(): void {
  if (!drawingNow || !gs.value) return
  drawingNow = false
  const live = gs.value.live
  if (live && live.points.length >= 2) {
    gs.value.strokes.push(live)
  }
  gs.value.live = null
  flushBroadcast()
}

function undo(): void {
  if (!canDraw.value || !gs.value || gs.value.strokes.length === 0) return
  gs.value.strokes.pop()
  flushBroadcast()
}
function clearBoard(): void {
  if (!canDraw.value || !gs.value) return
  gs.value.strokes = []
  gs.value.live = null
  flushBroadcast()
}

/** 笔画点集 → SVG polyline points 串。 */
function ptsStr(points: number[]): string {
  let s = ''
  for (let i = 0; i + 1 < points.length; i += 2) s += `${points[i]},${points[i + 1]} `
  return s.trim()
}

// —— 猜测：走 game-chat（全桌可见）；出题人本地比对命中裁决 ——
const chats = computed(() => store.gameChats.get(props.table.tableId) ?? [])
const guessInput = ref('')
function sendGuess(): void {
  const t = guessInput.value.trim()
  if (!t) return
  store.sendGameChat(props.table.tableId, t)
  guessInput.value = ''
}

let lastGuessIdx = 0
watch(
  () => chats.value.length,
  () => {
    const g = gs.value
    if (!isDrawer.value || phase.value !== 'drawing' || !g || !myWord.value) {
      lastGuessIdx = chats.value.length
      return
    }
    const list = chats.value
    const target = normalizeGuess(myWord.value)
    for (let i = lastGuessIdx; i < list.length; i++) {
      const m = list[i]
      if (!m || m.from === store.myId || m.role !== 'player') continue
      if (g.winnerId) break
      if (normalizeGuess(m.text) === target) {
        const ns = settleWin(g, m.from, myWord.value)
        gs.value = ns
        store.sendGameMove(props.table.tableId, ns)
        advanceAt.value = Date.now() + ROUND_END_SECONDS * 1000
        break
      }
    }
    lastGuessIdx = list.length
  },
)

// 最近猜测流（倒序显示最新的在上）。
const guessFeed = computed(() => chats.value.slice(-30).reverse())

// 计分榜（按分数降序）。
const scoreboard = computed(() => {
  const g = gs.value
  if (!g) return []
  return g.seats
    .map((peerId) => ({ peerId, score: g.scores[peerId] ?? 0 }))
    .sort((a, b) => b.score - a.score)
})

function restart(): void {
  if (!isHost.value) return
  const present = props.table.players.length ? props.table.players : seatsBase.value
  const ns = initDrawGuess(present)
  gs.value = ns
  store.sendGameMove(props.table.tableId, ns)
  myWord.value = ''
  advanceAt.value = 0
}
</script>

<template>
  <div class="drawguess">
    <!-- 顶部状态条 -->
    <header class="dg-head">
      <div class="dg-round">第 {{ gs?.round ?? 1 }}/{{ gs?.totalRounds ?? 1 }} 轮</div>
      <div class="dg-status">
        <template v-if="phase === 'picking'">
          <span v-if="isDrawer">轮到你出题，请选词 ✏️</span>
          <span v-else>等待 <b>{{ nick(gs?.drawerId || '') }}</b> 选词…</span>
        </template>
        <template v-else-if="phase === 'drawing'">
          <span v-if="isDrawer">你画的是：<b class="dg-word">{{ myWord }}</b></span>
          <span v-else><b>{{ nick(gs?.drawerId || '') }}</b> 正在画 · 提示：{{ gs?.hint }}</span>
        </template>
        <template v-else-if="phase === 'roundend'">
          <span v-if="gs?.winnerId">🎉 <b>{{ nick(gs.winnerId) }}</b> 猜中了！答案：<b class="dg-word">{{ gs?.revealedWord }}</b></span>
          <span v-else>⏰ 无人猜中，答案：<b class="dg-word">{{ gs?.revealedWord }}</b></span>
        </template>
        <template v-else-if="phase === 'gameover'">
          <span>🏁 游戏结束</span>
        </template>
      </div>
      <div v-if="phase === 'drawing'" class="dg-timer" :class="{ urgent: secLeft <= 10 }">⏱ {{ secLeft }}s</div>
    </header>

    <div class="dg-body">
      <!-- 画布区 -->
      <div class="dg-canvas-wrap">
        <svg
          ref="svgRef"
          class="dg-canvas"
          :class="{ drawable: canDraw }"
          :viewBox="`0 0 ${DG_W} ${DG_H}`"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointerleave="onUp"
        >
          <rect x="0" y="0" :width="DG_W" :height="DG_H" fill="#ffffff" />
          <polyline
            v-for="(st, i) in gs?.strokes ?? []"
            :key="i"
            :points="ptsStr(st.points)"
            fill="none"
            :stroke="st.color"
            :stroke-width="st.size"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <polyline
            v-if="gs?.live"
            :points="ptsStr(gs.live.points)"
            fill="none"
            :stroke="gs.live.color"
            :stroke-width="gs.live.size"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>

        <!-- 选词遮罩（仅出题人） -->
        <div v-if="phase === 'picking' && isDrawer" class="dg-overlay">
          <div class="dg-pick">
            <h3>选择你要画的词</h3>
            <div class="dg-choices">
              <button v-for="w in choices" :key="w" class="dg-choice" @click="pick(w)">{{ w }}</button>
            </div>
          </div>
        </div>
        <!-- 等待出题遮罩 -->
        <div v-else-if="phase === 'picking' && !isDrawer" class="dg-overlay soft">
          <div class="dg-wait">等待 {{ nick(gs?.drawerId || '') }} 选词…</div>
        </div>
        <!-- 结束遮罩 -->
        <div v-else-if="phase === 'gameover'" class="dg-overlay">
          <div class="dg-final">
            <h3>🏁 最终得分</h3>
            <ol class="dg-final-list">
              <li v-for="row in scoreboard" :key="row.peerId">
                <span>{{ nick(row.peerId) }}</span><b>{{ row.score }}</b>
              </li>
            </ol>
            <button v-if="isHost" class="dg-restart" @click="restart">再来一局</button>
            <p v-else class="dg-hint">等待桌主开始下一局…</p>
          </div>
        </div>

        <!-- 出题人画笔工具条 -->
        <div v-if="canDraw" class="dg-tools">
          <button
            v-for="c in PALETTE"
            :key="c"
            class="dg-swatch"
            :class="{ active: drawColor === c }"
            :style="{ background: c }"
            @click="drawColor = c"
          />
          <input v-model.number="drawSize" type="range" min="2" max="24" class="dg-size" />
          <button class="dg-tool" title="撤销" @click="undo"><AppIcon name="undo" :size="16" /></button>
          <button class="dg-tool" title="清空" @click="clearBoard"><AppIcon name="trash" :size="16" /></button>
        </div>
      </div>

      <!-- 右侧：计分榜 + 猜测 -->
      <aside class="dg-side">
        <div class="dg-scores">
          <h4>计分榜</h4>
          <ul>
            <li v-for="row in scoreboard" :key="row.peerId" :class="{ me: row.peerId === store.myId, drawer: row.peerId === gs?.drawerId }">
              <span class="dg-name">{{ nick(row.peerId) }}</span>
              <span v-if="row.peerId === gs?.drawerId" class="dg-badge">✏️</span>
              <span class="dg-score">{{ row.score }}</span>
            </li>
          </ul>
        </div>

        <div class="dg-guesses">
          <h4>猜测</h4>
          <div class="dg-feed">
            <div
              v-for="(m, i) in guessFeed"
              :key="i"
              class="dg-guess"
              :class="{ correct: m.from === gs?.winnerId && !!gs?.winnerId }"
            >
              <b>{{ nick(m.from) }}</b>：{{ m.text }}
            </div>
          </div>
          <div v-if="iAmPlayer && !isDrawer && phase === 'drawing'" class="dg-guess-input">
            <input v-model="guessInput" type="text" placeholder="输入你的猜测…" @keydown.enter="sendGuess" />
            <button :disabled="!guessInput.trim()" @click="sendGuess">猜</button>
          </div>
          <p v-else-if="isDrawer && phase === 'drawing'" class="dg-hint">你在出题，静候大家来猜～</p>
          <p v-else-if="!iAmPlayer" class="dg-hint">你在旁观，可在下方聊天区互动</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.drawguess {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
}

.dg-head {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  background: var(--panel);
  border-radius: var(--radius);
}
.dg-round {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
}
.dg-status {
  flex: 1;
  font-size: 15px;
  color: var(--text);
}
.dg-word {
  color: var(--accent-strong);
}
.dg-timer {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--accent-strong);
}
.dg-timer.urgent {
  color: #e53935;
}

.dg-body {
  flex: 1;
  display: flex;
  gap: 12px;
  min-height: 0;
}

.dg-canvas-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dg-canvas {
  width: 100%;
  max-height: 100%;
  aspect-ratio: 1000 / 700;
  background: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  touch-action: none;
}
.dg-canvas.drawable {
  cursor: crosshair;
}

.dg-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
  border-radius: var(--radius);
}
.dg-overlay.soft {
  background: rgba(255, 255, 255, 0.55);
}
.dg-pick {
  background: var(--panel);
  padding: 20px 24px;
  border-radius: var(--radius);
  text-align: center;
}
.dg-pick h3 {
  margin: 0 0 14px;
}
.dg-choices {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}
.dg-choice {
  padding: 12px 20px;
  font-size: 16px;
  font-weight: 600;
  border: 2px solid var(--accent);
  background: var(--accent-weak);
  color: var(--text);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s;
}
.dg-choice:hover {
  background: var(--accent);
  color: #fff;
}
.dg-wait {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.dg-final {
  background: var(--panel);
  padding: 20px 28px;
  border-radius: var(--radius);
  text-align: center;
  min-width: 220px;
}
.dg-final h3 {
  margin: 0 0 12px;
}
.dg-final-list {
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.dg-final-list li {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.dg-restart {
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.dg-tools {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--panel);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-pop);
}
.dg-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--border);
  cursor: pointer;
  padding: 0;
}
.dg-swatch.active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.dg-size {
  width: 80px;
}
.dg-tool {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  background: var(--bg);
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--text);
}
.dg-tool:hover {
  background: var(--accent-weak);
}

.dg-side {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.dg-scores {
  background: var(--panel);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.dg-scores h4,
.dg-guesses h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted);
}
.dg-scores ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.dg-scores li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.dg-scores li.me .dg-name {
  color: var(--accent-strong);
  font-weight: 600;
}
.dg-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dg-badge {
  font-size: 12px;
}
.dg-score {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dg-guesses {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.dg-feed {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column-reverse;
  gap: 4px;
  font-size: 13px;
}
.dg-guess {
  color: var(--text);
}
.dg-guess.correct {
  color: var(--success);
  font-weight: 600;
}
.dg-guess-input {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.dg-guess-input input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}
.dg-guess-input button {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.dg-guess-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dg-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
