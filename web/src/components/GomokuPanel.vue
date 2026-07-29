<script setup lang="ts">
// 五子棋棋盘（一对一对局的弹层）。状态在 store（两端镜像、各自校验），
// 这里只负责渲染与点击落子。SVG 网格：15×15 交叉点，坐标即格点。
import { computed } from 'vue'
import { useRoomStore } from '@/stores/room'
import { GOMOKU_SIZE } from '@/utils/gomoku'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'

const props = defineProps<{ peerId: string }>()

const store = useRoomStore()
const game = computed(() => store.gomoku.get(props.peerId))

// 视图几何：格距 32，边缘留一格，棋盘视口 16 格宽。
const CELL = 32
const PAD = CELL
const SIZE = CELL * (GOMOKU_SIZE - 1) + PAD * 2

const opponent = computed(() => store.displayName(props.peerId))
const myTurn = computed(
  () => game.value?.state === 'active' && game.value.turn === game.value.myColor,
)

/** 星位（天元 + 四角星），装饰用。 */
const STARS = [3, 7, 11].flatMap((y) => [3, 7, 11].map((x) => ({ x, y })))

const stones = computed(() => {
  const g = game.value
  if (!g) return []
  const out: { idx: number; x: number; y: number; color: number }[] = []
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] !== 0) {
      out.push({ idx: i, x: i % GOMOKU_SIZE, y: Math.floor(i / GOMOKU_SIZE), color: g.cells[i] })
    }
  }
  return out
})

const winSet = computed(() => new Set(game.value?.winLine ?? []))

const statusText = computed(() => {
  const g = game.value
  if (!g) return ''
  if (g.state === 'invite-out') return '等待对方接受邀请…'
  if (g.state === 'invite-in') return '对方邀请你对局'
  if (g.state === 'active') {
    return myTurn.value ? '轮到你落子' : `等待 ${opponent.value} 落子…`
  }
  if (g.result === 'win') return `你赢了 🎉（${g.reason}）`
  if (g.result === 'loss') return `你输了（${g.reason}）`
  return `平局（${g.reason}）`
})

function clickBoard(ev: MouseEvent): void {
  const g = game.value
  if (!g || g.state !== 'active' || !myTurn.value) return
  const svg = ev.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  // 视口坐标 → SVG 逻辑坐标 → 最近的交叉点。
  const lx = ((ev.clientX - rect.left) / rect.width) * SIZE
  const ly = ((ev.clientY - rect.top) / rect.height) * SIZE
  const gx = Math.round((lx - PAD) / CELL)
  const gy = Math.round((ly - PAD) / CELL)
  if (gx < 0 || gx >= GOMOKU_SIZE || gy < 0 || gy >= GOMOKU_SIZE) return
  store.moveGomoku(props.peerId, gy * GOMOKU_SIZE + gx)
}
</script>

<template>
  <div v-if="game" class="mask" @click.self="store.gomokuOpen = null">
    <div class="panel">
      <header class="phead">
        <h3>五子棋</h3>
        <div class="vs">
          <span class="side" :class="{ turn: game.state === 'active' && game.turn === game.myColor }">
            <i class="stone black" v-if="game.myColor === 1" /><i class="stone white" v-else />
            我
          </span>
          <span class="dim">vs</span>
          <span class="side" :class="{ turn: game.state === 'active' && game.turn !== game.myColor }">
            <i class="stone black" v-if="game.myColor === 2" /><i class="stone white" v-else />
            <PeerAvatar
              :avatar="store.members.get(peerId)?.profile?.avatar"
              :seed="peerId"
              :size="18"
            />
            {{ opponent }}
          </span>
        </div>
        <button class="ghost close" title="收起（对局保留）" @click="store.gomokuOpen = null">
          <AppIcon name="x" :size="15" />
        </button>
      </header>

      <p class="status" :class="{ mine: myTurn }">{{ statusText }}</p>

      <svg
        class="board"
        :viewBox="`0 0 ${SIZE} ${SIZE}`"
        :class="{ clickable: myTurn }"
        @click="clickBoard"
      >
        <rect x="0" y="0" :width="SIZE" :height="SIZE" class="wood" rx="10" />
        <g class="grid">
          <line
            v-for="i in GOMOKU_SIZE"
            :key="`h${i}`"
            :x1="PAD"
            :y1="PAD + (i - 1) * CELL"
            :x2="SIZE - PAD"
            :y2="PAD + (i - 1) * CELL"
          />
          <line
            v-for="i in GOMOKU_SIZE"
            :key="`v${i}`"
            :x1="PAD + (i - 1) * CELL"
            :y1="PAD"
            :x2="PAD + (i - 1) * CELL"
            :y2="SIZE - PAD"
          />
        </g>
        <circle
          v-for="(s, i) in STARS"
          :key="`star${i}`"
          :cx="PAD + s.x * CELL"
          :cy="PAD + s.y * CELL"
          r="3"
          class="star"
        />
        <g>
          <circle
            v-for="s in stones"
            :key="s.idx"
            :cx="PAD + s.x * CELL"
            :cy="PAD + s.y * CELL"
            :r="CELL * 0.42"
            class="piece"
            :class="[s.color === 1 ? 'p-black' : 'p-white', { win: winSet.has(s.idx) }]"
          />
          <circle
            v-if="game.last !== undefined && game.state === 'active'"
            :cx="PAD + (game.last % GOMOKU_SIZE) * CELL"
            :cy="PAD + Math.floor(game.last / GOMOKU_SIZE) * CELL"
            r="5"
            class="lastdot"
          />
        </g>
      </svg>

      <footer class="pfoot">
        <template v-if="game.state === 'invite-in'">
          <button class="primary" @click="store.respondGomoku(peerId, true)">接受对局</button>
          <button class="ghost" @click="store.respondGomoku(peerId, false)">婉拒</button>
        </template>
        <template v-else-if="game.state === 'invite-out'">
          <button class="ghost" @click="store.closeGomoku(peerId)">撤回邀请</button>
        </template>
        <template v-else-if="game.state === 'active'">
          <span class="movecount">第 {{ game.moves }} 手</span>
          <button class="ghost danger" @click="store.resignGomoku(peerId)">认输</button>
        </template>
        <template v-else>
          <button class="primary" @click="store.closeGomoku(peerId); store.inviteGomoku(peerId)">
            再来一局
          </button>
          <button class="ghost" @click="store.closeGomoku(peerId)">关闭</button>
        </template>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 24, 0.45);
  display: grid;
  place-items: center;
  z-index: 40;
}

.panel {
  width: min(480px, calc(100vw - 40px));
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.phead {
  display: flex;
  align-items: center;
  gap: 12px;
}

.phead h3 {
  margin: 0;
  font-size: 15px;
  color: var(--accent-strong);
}

.vs {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  min-width: 0;
}

.side {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
  white-space: nowrap;
}

.side.turn {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.dim {
  color: var(--faint);
  font-size: 11px;
}

.stone {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
}

.stone.black {
  background: #262626;
  border: 1px solid #000;
}

.stone.white {
  background: #fafafa;
  border: 1px solid #999;
}

.close {
  padding: 4px 7px;
}

.status {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
}

.status.mine {
  color: var(--accent-strong);
  font-weight: 600;
}

.board {
  width: 100%;
  aspect-ratio: 1;
  display: block;
  user-select: none;
}

.board.clickable {
  cursor: crosshair;
}

.wood {
  fill: #e8c88f;
}

.grid line {
  stroke: #8a6b3d;
  stroke-width: 1;
}

.star {
  fill: #8a6b3d;
}

.piece.p-black {
  fill: #1d1d1f;
  stroke: #000;
}

.piece.p-white {
  fill: #fdfdfd;
  stroke: #9a9a9a;
}

.piece.win {
  stroke: var(--danger);
  stroke-width: 3;
}

.lastdot {
  fill: var(--danger);
  pointer-events: none;
}

.pfoot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.movecount {
  margin-right: auto;
  font-size: 12px;
  color: var(--muted);
}

.ghost.danger {
  color: var(--danger);
}
</style>
