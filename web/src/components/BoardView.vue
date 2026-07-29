<script setup lang="ts">
// 互动白板：固定 16:9 逻辑画板（坐标归一化，各端显示尺寸无关），
// 笔画经 control 通道实时同步；新入房设备自动收到全量状态。
// 支持两类画板：'wb' 公共白板（全网同步）与 wb:<a>~<b> 私有白板（仅两端）。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import { containRect, renderStrokes } from '@/core/draw'
import type { DrawMode } from '@/core/messages'
import { pickWords } from '@/utils/words'
import { fmtTime } from '@/utils/format'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import DrawLayer from './DrawLayer.vue'
import DrawToolbar from './DrawToolbar.vue'

/** 导出 PNG 的像素尺寸。 */
const EXPORT_W = 1920
const EXPORT_H = 1080

const store = useRoomStore()

/** 当前画板：跟随 store.activeBoard（网络视图「私有白板」入口设置）。 */
const board = computed(() => store.activeBoard)
const isPrivate = computed(() => board.value.startsWith('wb:'))
/** 私有画板的对方节点。 */
const dmPeer = computed(() => {
  if (!isPrivate.value) return null
  return board.value.slice(3).split('~').find((p) => p !== store.myId) ?? null
})

const tool = ref<'pointer' | DrawMode>('pen')
const color = ref('#6c4bf4')
const size = ref(3)
const polylineArrow = ref(false)
const layerRef = ref<InstanceType<typeof DrawLayer> | null>(null)
const selectedCount = computed(() => layerRef.value?.selectedCount ?? 0)

// 切工具时把粗细切到该工具的量纲上，避免出现 36px 的画笔或 3px 的橡皮。
function setTool(newTool: 'pointer' | DrawMode): void {
  tool.value = newTool
  if (newTool === 'eraser') {
    size.value = 36
  } else if (newTool === 'text') {
    size.value = 24
  } else if (newTool !== 'pointer' && newTool !== 'select' && newTool !== 'image') {
    size.value = 3
  }
}

// —— 16:9 letterbox 几何 ——
const wrapEl = ref<HTMLDivElement | null>(null)
const wrapW = ref(0)
const wrapH = ref(0)
const rect = computed(() => containRect(wrapW.value, wrapH.value, 16, 9))

let resizeObs: ResizeObserver | null = null

onMounted(() => {
  resizeObs = new ResizeObserver(() => {
    if (!wrapEl.value) return
    wrapW.value = wrapEl.value.clientWidth
    wrapH.value = wrapEl.value.clientHeight
  })
  if (wrapEl.value) resizeObs.observe(wrapEl.value)
})

onBeforeUnmount(() => resizeObs?.disconnect())

function clear(): void {
  if (store.getBoard(board.value).length === 0) return
  if (!window.confirm('清空白板？将同时清掉参与者的画面。')) return
  store.clearBoard(board.value)
}

/** 导出当前白板为 PNG（白底）。 */
function exportPng(): void {
  const canvas = document.createElement('canvas')
  canvas.width = EXPORT_W
  canvas.height = EXPORT_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, EXPORT_W, EXPORT_H)
  // renderStrokes 会 clearRect，导出时先画笔画再垫白底。
  const strokesLayer = document.createElement('canvas')
  strokesLayer.width = EXPORT_W
  strokesLayer.height = EXPORT_H
  const sctx = strokesLayer.getContext('2d')
  if (!sctx) return
  renderStrokes(sctx, store.getBoard(board.value), EXPORT_W, EXPORT_H)
  ctx.drawImage(strokesLayer, 0, 0)
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `whiteboard-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }, 'image/png')
}

const syncHint = computed(() => {
  if (isPrivate.value) {
    const peer = dmPeer.value
    const reachable = peer && store.members.get(peer)?.state === 'connected'
    return reachable
      ? `与 ${store.displayName(peer)} 的私有白板 · 其他节点不可见`
      : '对方暂不可达（笔画会先留在本地）'
  }
  const n = store.connectedPeers.length
  return n > 0 ? `与 ${n} 个节点实时同步` : '未连接节点（先本地起草，组网后自动同步）'
})

// —— 你画我猜（公共白板专属）——
const game = computed(() => store.guess)
/** 猜词进行中且我不是出题人：锁定绘制，只留激光笔围观。 */
const drawLocked = computed(() => !isPrivate.value && game.value.active && !store.amDrawer)
const effectiveTool = computed(() => (drawLocked.value ? 'pointer' : tool.value))
/** 游戏面板出现的条件：进行中，或有比分/上一轮结果可看。 */
const gameVisible = computed(
  () =>
    !isPrivate.value &&
    (game.value.active || game.value.round > 0 || Object.keys(game.value.scores).length > 0),
)

const showStart = ref(false)
const wordChoices = ref<string[]>([])
const customWord = ref('')
const guessDraft = ref('')
const triesEl = ref<HTMLElement | null>(null)

function openStart(): void {
  wordChoices.value = pickWords(3)
  customWord.value = ''
  showStart.value = true
}

function startWith(word: string): void {
  if (!word.trim()) return
  store.startGuessRound(word)
  showStart.value = false
}

function sendGuess(): void {
  if (!guessDraft.value.trim()) return
  store.submitGuess(guessDraft.value)
  guessDraft.value = ''
}

const scoreList = computed(() =>
  Object.entries(game.value.scores)
    .map(([pid, score]) => ({ pid, score, name: store.displayName(pid) }))
    .sort((a, b) => b.score - a.score),
)

watch(
  () => game.value.tries.length,
  async () => {
    await nextTick()
    if (triesEl.value) triesEl.value.scrollTop = triesEl.value.scrollHeight
  },
)
</script>

<template>
  <div class="boardpage">
    <header class="head">
      <h1><AppIcon name="pen" :size="20" /> 互动白板</h1>
      <span class="sub">{{ syncHint }}</span>
      <button
        v-if="!isPrivate"
        class="ghost gamebtn"
        :disabled="store.connectedPeers.length === 0 || game.active"
        :title="game.active ? '本轮进行中' : '出题开一轮你画我猜'"
        @click="openStart"
      >
        <AppIcon name="dice" :size="16" /> 你画我猜
      </button>
      <button class="ghost" title="导出 PNG" @click="exportPng">
        <AppIcon name="image" :size="16" /> 导出
      </button>
    </header>

    <!-- 画板切换：公共 + 各私有板 -->
    <div v-if="store.memberList.length > 0" class="tabs">
      <button
        class="tab"
        :class="{ on: !isPrivate }"
        @click="store.actionBoard('all')"
      >
        <AppIcon name="hub" :size="14" /> 公共白板
      </button>
      <button
        v-for="m in store.memberList"
        :key="m.peerId"
        class="tab"
        :class="{ on: isPrivate && dmPeer === m.peerId }"
        @click="store.actionBoard(m.peerId)"
      >
        <PeerAvatar :avatar="m.profile?.avatar" :seed="m.peerId" :size="16" />
        与 {{ store.displayName(m.peerId) }}
      </button>
    </div>

    <!-- 你画我猜：状态条 -->
    <div v-if="gameVisible" class="gamebar">
      <template v-if="game.active">
        <span class="round">第 {{ game.round }} 轮</span>
        <template v-if="store.amDrawer">
          <span class="secret">谜底：<b>{{ game.word }}</b>（画出来，别打字）</span>
          <button class="ghost small" @click="store.revealAnswer()">无人猜中，公布答案</button>
        </template>
        <template v-else>
          <span>
            <b>{{ store.displayName(game.drawer) }}</b> 正在画 · 提示：<b>{{ game.hint }}</b>
          </span>
          <span class="lockhint">围观模式（激光笔可用）</span>
        </template>
      </template>
      <template v-else>
        <span v-if="game.lastWord" class="result">
          上一轮谜底「<b>{{ game.lastWord }}</b>」{{
            game.lastWinner ? `，${store.displayName(game.lastWinner)} 猜中` : '，无人猜中'
          }}
        </span>
        <button class="ghost small" :disabled="store.connectedPeers.length === 0" @click="openStart">
          我来出题
        </button>
      </template>
      <span class="scores">
        <span v-for="s in scoreList" :key="s.pid" class="score">
          {{ s.name }} <b>{{ s.score }}</b>
        </span>
      </span>
      <button class="ghost small end" title="结束游戏并清空计分" @click="store.endGuess()">
        结束游戏
      </button>
    </div>

    <div class="tools">
      <span v-if="drawLocked" class="locked">
        <AppIcon name="cursor" :size="14" /> 猜词回合，画笔已锁定——把答案打在右侧猜词框里
      </span>
      <DrawToolbar
        v-else
        :tool="tool"
        :color="color"
        :size="size"
        :polyline-arrow="polylineArrow"
        :selected-count="selectedCount"
        pointer-label="激光笔（位置实时投给参与者）"
        @update:tool="setTool"
        @update:color="color = $event"
        @update:size="size = $event"
        @update:polyline-arrow="polylineArrow = $event"
        @undo="store.undoStroke(board)"
        @clear="clear"
        @delete-selection="layerRef?.deleteSelection()"
      />
    </div>

    <div class="playarea">
      <div ref="wrapEl" class="wrap">
        <div
          class="board"
          :style="{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }"
        >
          <DrawLayer
            v-if="rect.width > 0"
            ref="layerRef"
            :key="board"
            :board="board"
            :tool="effectiveTool"
            :color="color"
            :size="size"
            :polyline-arrow="polylineArrow"
            :width="rect.width"
            :height="rect.height"
          />
        </div>
      </div>

      <!-- 你画我猜：猜词面板 -->
      <aside v-if="game.active || game.tries.length > 0" class="guessing">
        <div class="ghead">猜词记录</div>
        <div ref="triesEl" class="tries">
          <p v-if="game.tries.length === 0" class="gempty">还没有人猜，快抢首猜！</p>
          <div
            v-for="(t, i) in game.tries"
            :key="i"
            class="try"
            :class="{ hit: t.correct }"
          >
            <span class="tnick">{{ t.nick }}</span>
            <span class="ttext">{{ t.text }}</span>
            <span class="ttime">{{ fmtTime(t.ts) }}</span>
            <button
              v-if="store.amDrawer && game.active && !t.correct && t.round === game.round"
              class="judge"
              title="判定 TA 猜中"
              @click="store.judgeCorrect(t)"
            >
              <AppIcon name="check" :size="13" />
            </button>
            <span v-if="t.correct" class="hitmark">✓ 猜中</span>
          </div>
        </div>
        <div v-if="game.active && !store.amDrawer" class="ginput">
          <input
            v-model="guessDraft"
            placeholder="输入你的答案，回车提交"
            maxlength="30"
            @keyup.enter="sendGuess"
          />
          <button class="primary" :disabled="!guessDraft.trim()" @click="sendGuess">猜</button>
        </div>
        <div v-else-if="game.active" class="ginput drawerhint">大家的猜测会出现在上方，可手动判对</div>
      </aside>
    </div>

    <!-- 出题弹层 -->
    <div v-if="showStart" class="modal-mask" @click.self="showStart = false">
      <div class="modal">
        <h3><AppIcon name="dice" :size="18" /> 出题 · 你画我猜</h3>
        <p class="mhint">选一个词开始画，其他人来猜。谜底只在你本地，猜中自动判定（+2 分，出题人 +1 分）。</p>
        <div class="words">
          <button v-for="w in wordChoices" :key="w" class="word" @click="startWith(w)">{{ w }}</button>
          <button class="ghost refresh" title="换一批" @click="wordChoices = pickWords(3)">
            <AppIcon name="refresh" :size="15" />
          </button>
        </div>
        <div class="custom">
          <input
            v-model="customWord"
            placeholder="或自拟词（不会发给任何人）"
            maxlength="12"
            @keyup.enter="startWith(customWord)"
          />
          <button class="primary" :disabled="!customWord.trim()" @click="startWith(customWord)">
            开始
          </button>
        </div>
        <div class="modal-actions">
          <button class="ghost" @click="showStart = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.boardpage {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.head h1 {
  margin: 0;
  font-size: 17px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-strong);
}

.sub {
  font-size: 12px;
  color: var(--muted);
  flex: 1;
}

.tabs {
  display: flex;
  gap: 6px;
  padding: 10px 24px 0;
  flex-wrap: wrap;
}

.tab {
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.head .ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tools {
  display: flex;
  justify-content: center;
  padding: 12px 24px 0;
}

.gamebtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

/* —— 你画我猜 —— */
.gamebar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 10px 24px 0;
  padding: 8px 14px;
  font-size: 13px;
  border: 1px solid var(--accent);
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-sm);
}

.gamebar .round {
  font-weight: 700;
  font-size: 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
}

.gamebar .secret b {
  letter-spacing: 2px;
}

.gamebar .lockhint,
.gamebar .result {
  color: var(--text-2);
}

.gamebar .small {
  padding: 4px 10px;
  font-size: 12px;
}

.gamebar .scores {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}

.gamebar .score {
  font-size: 11.5px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 3px 9px;
  color: var(--text-2);
}

.gamebar .score b {
  color: var(--accent-strong);
}

.gamebar .end {
  color: var(--muted);
}

.locked {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--muted);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 7px 16px;
}

.playarea {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 14px;
  margin: 12px 24px 20px;
}

.wrap {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
}

.guessing {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.ghead {
  padding: 10px 14px;
  font-size: 12.5px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

.tries {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gempty {
  margin: auto;
  font-size: 12px;
  color: var(--faint);
}

.try {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12.5px;
  padding: 5px 7px;
  border-radius: 8px;
}

.try.hit {
  background: var(--ok-weak, var(--accent-weak));
}

.tnick {
  color: var(--muted);
  font-size: 11px;
  flex: none;
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ttext {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.ttime {
  font-size: 10px;
  color: var(--faint);
  flex: none;
}

.judge {
  flex: none;
  border: 1px solid var(--ok);
  color: var(--ok);
  background: transparent;
  border-radius: 6px;
  padding: 1px 6px;
}

.judge:hover {
  background: var(--ok);
  color: #fff;
}

.hitmark {
  flex: none;
  color: var(--ok);
  font-size: 11px;
  font-weight: 700;
}

.ginput {
  display: flex;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}

.ginput input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  padding: 7px 10px;
}

.ginput .primary {
  padding: 6px 14px;
}

.drawerhint {
  font-size: 11.5px;
  color: var(--faint);
  justify-content: center;
}

/* 出题弹层 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 24, 0.45);
  display: grid;
  place-items: center;
  z-index: 30;
}

.modal {
  width: min(380px, calc(100vw - 48px));
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  padding: 20px 22px;
}

.modal h3 {
  margin: 0 0 8px;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-strong);
}

.mhint {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 14px;
  line-height: 1.6;
}

.words {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.word {
  flex: 1;
  min-width: 72px;
  padding: 10px 8px;
  font-size: 14px;
  font-weight: 600;
  border-radius: var(--radius-sm);
}

.word:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.refresh {
  padding: 8px;
  flex: none;
}

.custom {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.custom input {
  flex: 1;
  min-width: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
}

.board {
  position: absolute;
  background: var(--canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}
</style>
