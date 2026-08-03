<script setup lang="ts">
// 网络视图：把「已连接列表」升级为一张网 —— 本机居中，其余节点环形分布，
// 节点间按真实 P2P 连通性连边（本端直连 + 各端上报的邻接表 gossip）。
// 所有操作内化于此：点对端节点唤出「私聊 / 发文件 / 共享屏幕 / 私有白板 /
// 指纹核验」，点中心自己的节点编辑名片，底部动作条面向全网（群聊 / 群发 /
// 共享屏幕 / 公共白板）。
import { computed, ref } from 'vue'
import { renderSVG } from 'uqr'
import { useRoomStore, type Member } from '@/stores/room'
import { AVATAR_COLORS, AVATAR_EMOJIS } from '@/core/profile'
import { copyText } from '@/utils/clipboard'
import { collectDropped } from '@/utils/fs'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'

const store = useRoomStore()

// 非安全上下文（局域网 http）下多项能力被浏览器禁用，进页面即提示一次。
// 关掉后本次会话不再出现——刷新仍会提示，因为这直接影响能否连上人。
const insecureDismissed = ref(false)
const showInsecureHint = computed(
  () => !store.capabilities.secureContext && !insecureDismissed.value,
)

// —— 画布几何 ——
const VIEW = 640
const CENTER = VIEW / 2
const NODE_R = 34
const SELF_R = 42

interface GraphNode {
  member: Member
  x: number
  y: number
}

/** 对端环形布局（按 peerId 排序保证稳定，不因 Map 顺序抖动）。 */
const nodes = computed<GraphNode[]>(() => {
  const list = [...store.memberList].sort((a, b) => a.peerId.localeCompare(b.peerId))
  const n = list.length
  const radius = n <= 1 ? 190 : Math.min(230, 150 + n * 14)
  // 少于 3 个对端时按 3 等分排布，避免两节点与中心共线遮住互连边。
  const slots = Math.max(n, 3)
  return list.map((member, i) => {
    const angle = (2 * Math.PI * i) / slots - Math.PI / 2
    return {
      member,
      x: CENTER + radius * Math.cos(angle),
      y: CENTER + radius * Math.sin(angle),
    }
  })
})

function nodeAt(peerId: string): GraphNode | undefined {
  return nodes.value.find((n) => n.member.peerId === peerId)
}

interface GraphEdge {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  state: string
  /** 实测往返延迟（ms），标注在边中点。 */
  rtt?: number
}

/** 边集合：本端→各对端（member.state + 本端实测 RTT），对端↔对端（gossip）。 */
const edges = computed<GraphEdge[]>(() => {
  const out: GraphEdge[] = []
  const seen = new Set<string>()
  for (const n of nodes.value) {
    out.push({
      key: `self-${n.member.peerId}`,
      x1: CENTER,
      y1: CENTER,
      x2: n.x,
      y2: n.y,
      state: n.member.state,
      rtt: store.rtts.get(n.member.peerId),
    })
  }
  for (const [from, links] of store.peerLinks) {
    const a = nodeAt(from)
    if (!a) continue
    for (const [to, link] of links) {
      if (to === store.myId) continue
      const b = nodeAt(to)
      if (!b) continue
      const key = [from, to].sort().join('~')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, x1: a.x, y1: a.y, x2: b.x, y2: b.y, state: link.state, rtt: link.rtt })
    }
  }
  return out
})

/** 连通边的 RTT 标签（HTML 定位在边中点，避免非等比 SVG 拉伸文字）。 */
const rttLabels = computed(() =>
  edges.value
    .filter((e) => e.state === 'connected' && e.rtt !== undefined)
    .map((e) => ({
      key: e.key,
      x: (e.x1 + e.x2) / 2,
      y: (e.y1 + e.y2) / 2,
      rtt: e.rtt as number,
    })),
)

function edgeClass(state: string): string {
  if (state === 'connected') return 'on'
  if (state === 'connecting' || state === 'new') return 'pending'
  return 'off'
}

// —— 节点菜单 ——
const menuFor = ref<string | null>(null)
const menuNode = computed(() => (menuFor.value ? nodeAt(menuFor.value) : undefined))

function openMenu(peerId: string): void {
  menuFor.value = menuFor.value === peerId ? null : peerId
  editingSelf.value = false
}

function closeMenus(): void {
  menuFor.value = null
  editingSelf.value = false
}

function menuStyle(node: GraphNode): Record<string, string> {
  // 弹层锚定在节点旁，靠边时翻向内侧。
  const left = (node.x / VIEW) * 100
  const top = (node.y / VIEW) * 100
  const flipX = node.x > VIEW * 0.62
  const flipY = node.y > VIEW * 0.6
  return {
    left: `${left}%`,
    top: `${top}%`,
    transform: `translate(${flipX ? 'calc(-100% - 14px)' : '46px'}, ${flipY ? 'calc(-100% + 20px)' : '-20px'})`,
  }
}

function act(action: 'chat' | 'file' | 'screen' | 'board' | 'gomoku' | 'verify', peerId: string): void {
  menuFor.value = null
  switch (action) {
    case 'chat':
      store.openChat(peerId)
      break
    case 'file':
      store.actionSendFile(peerId)
      break
    case 'screen':
      void store.actionShareScreen(peerId)
      break
    case 'board':
      store.actionBoard(peerId)
      break
    case 'gomoku':
      store.actionGomoku(peerId)
      break
    case 'verify':
      verifyFor.value = peerId
      break
  }
}

// —— SAS 核验弹层 ——
const verifyFor = ref<string | null>(null)
const verifyMember = computed(() =>
  verifyFor.value ? store.members.get(verifyFor.value) : undefined,
)

// —— 名片编辑 ——
const editingSelf = ref(false)
const nickDraft = ref('')
const avatarFile = ref<HTMLInputElement | null>(null)

function openSelfEditor(): void {
  menuFor.value = null
  nickDraft.value = store.myProfile.nick
  editingSelf.value = !editingSelf.value
}

function saveNick(): void {
  store.setNick(nickDraft.value)
}

/** 回车：保存昵称并关闭编辑弹层（头像/底色本就点选即存）。 */
function commitAndClose(): void {
  saveNick()
  editingSelf.value = false
}

function pickEmoji(emoji: string): void {
  store.setAvatar({ ...store.myProfile.avatar, kind: 'emoji', value: emoji })
}

function pickColor(color: string): void {
  store.setAvatar({ ...store.myProfile.avatar, color })
}

function onAvatarFile(ev: Event): void {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void store.setAvatarImage(file)
  input.value = ''
}

// —— 连接面板（无对端时展示引导；有对端时折叠为小按钮）——
const showConnect = ref(false)
const peerCode = ref('')
const roomName = ref('')
const copiedCode = ref(false)
const copiedLink = ref(false)

const connectOpen = computed(() => store.peerCount === 0 || showConnect.value)

/** 分享链接二维码（手机扫码即连，免输码）。 */
const qrSvg = computed(() => renderSVG(store.shareLink, { border: 1, ecc: 'M' }))

// —— 拖文件到节点头像：直接发给 TA（懒发送；文件夹自动打包 zip）——
const dropNode = ref<string | null>(null)

function nodeDragOver(peerId: string, ev: DragEvent) {
  if (![...(ev.dataTransfer?.types ?? [])].includes('Files')) return
  ev.preventDefault()
  dropNode.value = peerId
}

function nodeDragLeave(peerId: string) {
  if (dropNode.value === peerId) dropNode.value = null
}

async function nodeDrop(peerId: string, ev: DragEvent) {
  dropNode.value = null
  if (!ev.dataTransfer) return
  const member = store.members.get(peerId)
  if (!member || member.state !== 'connected') {
    store.lastError = '该节点未连接，无法发送文件'
    return
  }
  const payload = await collectDropped(ev.dataTransfer)
  if (payload.files.length === 0 && payload.folders.length === 0) return
  void store.dispatchPayload(payload, 'lazy', peerId)
}

async function copy(text: string, flag: 'code' | 'link') {
  if (!(await copyText(text))) {
    store.lastError = '复制失败，请手动选中文本复制'
    return
  }
  if (flag === 'code') {
    copiedCode.value = true
    setTimeout(() => (copiedCode.value = false), 1500)
  } else {
    copiedLink.value = true
    setTimeout(() => (copiedLink.value = false), 1500)
  }
}

async function connectByCode() {
  if (!/^\d{4,8}$/.test(peerCode.value.trim())) return
  const ok = await store.connectTo(peerCode.value)
  if (ok) {
    peerCode.value = ''
    showConnect.value = false
  }
}

async function joinNamedRoom() {
  if (!roomName.value.trim()) return
  const ok = await store.connectTo(roomName.value)
  if (ok) showConnect.value = false
}

const STATE_LABEL: Record<string, string> = {
  new: '待连接',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  failed: '连接失败',
  closed: '已关闭',
}

/** 已连接但走服务器中继时，把状态标成「中继」以示区别（屏幕共享不可用）。 */
function stateLabel(m: { state: string; transport: string }): string {
  if (m.transport === 'relay') return '中继'
  return STATE_LABEL[m.state] ?? m.state
}
</script>

<template>
  <div class="page" @click="closeMenus">
    <!-- 顶栏 -->
    <header class="bar" @click.stop>
      <h1><AppIcon name="hub" :size="20" /> 网络</h1>
      <span class="sub">
        {{
          store.peerCount > 0
            ? `${store.peerCount + 1} 个节点互联 · 端到端直连`
            : store.listening
              ? `等待连入 · 短码 ${store.myCode}`
              : '未组网'
        }}
      </span>
      <button v-if="store.peerCount > 0" class="ghost" @click="showConnect = !showConnect">
        <AppIcon name="link" :size="15" /> 邀请
      </button>
      <button v-if="store.peerCount > 0" @click="store.disconnect()">断开</button>
    </header>

    <!-- 错误/能力提示 -->
    <div v-if="!store.capabilities.webrtc" class="banner danger" @click.stop>
      当前浏览器不支持 WebRTC，无法建立 P2P 连接。请换用新版 Chrome / Edge / Firefox / Safari。
    </div>
    <div v-if="showInsecureHint" class="banner warn" @click.stop>
      <span>
        当前以 http 访问（非 localhost），浏览器判定为<b>非安全上下文</b>：
        <b>发起屏幕共享</b>不可用（采集与编码 API 被禁用）。聊天 / 文件 / 白板、
        同网段直连、安全核验（SAS）以及打不通时的<b>服务器中继兜底</b>都照常可用，
        中继载荷仍是端到端加密。但请注意：页面本身经明文 http 送达，
        <b>能篡改流量的攻击者可以替换页面脚本</b>，此时加密与 SAS 都会被绕过。
        在不完全可信的网络里请改用 https。
      </span>
      <button class="ghost close" title="不再提示" @click="insecureDismissed = true">
        <AppIcon name="x" :size="14" />
      </button>
    </div>
    <div v-if="store.lastError" class="banner danger" @click.stop>
      {{ store.lastError }}
      <button class="ghost close" @click="store.lastError = null">
        <AppIcon name="x" :size="14" />
      </button>
    </div>

    <div class="body">
      <!-- 网络画布 -->
      <div class="stage">
        <!-- 连线与节点同用「百分比坐标系」：SVG 拉伸铺满，线宽用
             non-scaling-stroke 保持恒定，与百分比定位的节点严格对齐。 -->
        <svg class="wires" :viewBox="`0 0 ${VIEW} ${VIEW}`" preserveAspectRatio="none">
          <line
            v-for="e in edges"
            :key="e.key"
            class="wire"
            :class="edgeClass(e.state)"
            :x1="e.x1"
            :y1="e.y1"
            :x2="e.x2"
            :y2="e.y2"
          />
        </svg>

        <!-- 连线延迟标注（HTML 定位在边中点，避免 SVG 非等比拉伸文字） -->
        <span
          v-for="l in rttLabels"
          :key="`rtt-${l.key}`"
          class="rttchip"
          :class="{ slow: l.rtt >= 150 }"
          :style="{ left: `${(l.x / VIEW) * 100}%`, top: `${(l.y / VIEW) * 100}%` }"
          title="实测往返延迟（每 5 秒探测一次）"
        >{{ l.rtt }}ms</span>

        <!-- 本机节点（中心） -->
        <div
          class="node self"
          :style="{ left: `${(CENTER / VIEW) * 100}%`, top: `${(CENTER / VIEW) * 100}%` }"
          @click.stop="openSelfEditor"
        >
          <span class="ring" :class="{ online: store.status === 'online' }">
            <PeerAvatar :avatar="store.myProfile.avatar" :seed="store.myId" :size="SELF_R * 2 - 10" />
          </span>
          <span class="name">{{ store.myProfile.nick || '我' }}<i class="me">我</i></span>
        </div>

        <!-- 对端节点 -->
        <div
          v-for="n in nodes"
          :key="n.member.peerId"
          class="node"
          :class="{ droptarget: dropNode === n.member.peerId }"
          :style="{ left: `${(n.x / VIEW) * 100}%`, top: `${(n.y / VIEW) * 100}%` }"
          @click.stop="openMenu(n.member.peerId)"
          @dragover="nodeDragOver(n.member.peerId, $event)"
          @dragleave="nodeDragLeave(n.member.peerId)"
          @drop.prevent.stop="nodeDrop(n.member.peerId, $event)"
        >
          <span class="ring" :class="n.member.state">
            <PeerAvatar
              :avatar="n.member.profile?.avatar"
              :seed="n.member.peerId"
              :size="NODE_R * 2 - 10"
            />
            <i v-if="n.member.sharing" class="live" title="正在共享屏幕">
              <AppIcon name="monitor" :size="11" />
            </i>
            <i v-else-if="store.speaking.has(n.member.peerId)" class="talk" title="正在说话">
              <AppIcon name="mic" :size="11" />
            </i>
            <i v-else-if="n.member.verified" class="ok" title="指纹已核验">
              <AppIcon name="check" :size="11" />
            </i>
          </span>
          <span class="name">{{ store.displayName(n.member.peerId) }}</span>
          <span
            class="state"
            :class="{ relay: n.member.transport === 'relay' }"
            :title="n.member.transport === 'relay' ? '无法 P2P 直连，数据经服务器中继（屏幕共享不可用）' : ''"
          >{{ stateLabel(n.member) }}</span>
          <span
            v-if="(store.unread.get(n.member.peerId) ?? 0) > 0"
            class="nbadge"
          >{{ store.unread.get(n.member.peerId) }}</span>
        </div>

        <!-- 空态 -->
        <div v-if="store.peerCount === 0" class="empty-hint">
          <span v-if="store.listening" class="pulse"></span>
          {{ store.listening ? '正在监听，等待其它节点连入…' : '还没有其它节点' }}
        </div>

        <!-- 节点操作菜单 -->
        <div v-if="menuNode" class="popover" :style="menuStyle(menuNode)" @click.stop>
          <header>
            <PeerAvatar
              :avatar="menuNode.member.profile?.avatar"
              :seed="menuNode.member.peerId"
              :size="30"
            />
            <div class="who">
              <strong>{{ store.displayName(menuNode.member.peerId) }}</strong>
              <span>{{ stateLabel(menuNode.member) }}</span>
            </div>
          </header>
          <button @click="act('chat', menuNode.member.peerId)">
            <AppIcon name="chat" :size="16" /> 私聊
          </button>
          <button @click="act('file', menuNode.member.peerId)">
            <AppIcon name="upload" :size="16" /> 发文件
          </button>
          <button
            :disabled="!store.capabilities.displayMedia || store.sharing"
            @click="act('screen', menuNode.member.peerId)"
          >
            <AppIcon name="monitor" :size="16" /> 共享屏幕给 TA
          </button>
          <button @click="act('board', menuNode.member.peerId)">
            <AppIcon name="pen" :size="16" /> 私有白板
          </button>
          <button
            :disabled="menuNode.member.state !== 'connected'"
            @click="act('gomoku', menuNode.member.peerId)"
          >
            <AppIcon name="dice" :size="16" /> 五子棋对局
          </button>
          <button @click="act('verify', menuNode.member.peerId)">
            <AppIcon name="shield" :size="16" /> 安全核验
            <i v-if="menuNode.member.verified" class="okdot" />
          </button>
        </div>

        <!-- 名片编辑弹层 -->
        <div v-if="editingSelf" class="popover profile" @click.stop>
          <header>
            <PeerAvatar :avatar="store.myProfile.avatar" :size="30" />
            <div class="who"><strong>我的名片</strong><span>昵称与头像会同步给所有节点</span></div>
          </header>
          <label class="fld">
            <span>昵称</span>
            <input
              v-model="nickDraft"
              maxlength="20"
              @blur="saveNick"
              @keyup.enter="commitAndClose"
              @keyup.esc="editingSelf = false"
            />
          </label>
          <div class="fld">
            <span>头像</span>
            <div class="emojis">
              <button
                v-for="e in AVATAR_EMOJIS"
                :key="e"
                class="emoji"
                :class="{ on: store.myProfile.avatar.kind === 'emoji' && store.myProfile.avatar.value === e }"
                @click="pickEmoji(e)"
              >{{ e }}</button>
            </div>
          </div>
          <div class="fld">
            <span>底色</span>
            <div class="colors">
              <button
                v-for="c in AVATAR_COLORS"
                :key="c"
                class="swatch"
                :class="{ on: store.myProfile.avatar.color === c }"
                :style="{ background: c }"
                @click="pickColor(c)"
              />
            </div>
          </div>
          <button class="ghost imgbtn" @click="avatarFile?.click()">
            <AppIcon name="image" :size="15" /> 上传图片头像
          </button>
          <input ref="avatarFile" type="file" accept="image/*" hidden @change="onAvatarFile" />
        </div>

        <!-- SAS 核验弹层 -->
        <div v-if="verifyMember" class="modal-mask" @click.self="verifyFor = null">
          <div class="modal" @click.stop>
            <h3><AppIcon name="shield" :size="18" /> 安全核验 · {{ store.displayName(verifyMember.peerId) }}</h3>
            <template v-if="verifyMember.sas">
              <p class="sas-emoji">{{ verifyMember.sas.emoji.join(' ') }}</p>
              <p class="sas-digits">{{ verifyMember.sas.digits }}</p>
              <p class="hint">
                与对方通过可信渠道（当面/语音）核对上方 emoji 或数字，一致才能排除中间人。
              </p>
              <div class="modal-actions">
                <button v-if="!verifyMember.verified" class="primary" @click="store.markVerified(verifyMember.peerId); verifyFor = null">
                  已核对一致 ✓
                </button>
                <span v-else class="verified-tag"><AppIcon name="check" :size="14" /> 已核验</span>
                <button class="ghost" @click="verifyFor = null">关闭</button>
              </div>
            </template>
            <template v-else>
              <p class="hint">指纹计算中，请稍候（需连接建立完成）…</p>
              <div class="modal-actions">
                <button class="ghost" @click="verifyFor = null">关闭</button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 连接面板 -->
      <aside v-if="connectOpen" class="connect card" @click.stop>
        <div class="card-head">
          <h2><span class="dash">组网 · 三种方式任选</span></h2>
          <button v-if="store.peerCount > 0" class="ghost close" @click="showConnect = false">
            <AppIcon name="x" :size="14" />
          </button>
        </div>

        <div class="method">
          <div class="mhead"><span class="num">01</span> 短码直连</div>
          <div class="row">
            <button class="code-pill" title="点击复制" @click="copy(store.myCode, 'code')">
              {{ store.myCode }}
              <AppIcon :name="copiedCode ? 'check' : 'copy'" :size="14" />
            </button>
            <button
              class="ghost iconbtn"
              title="换一个短码"
              :disabled="store.peerCount > 0"
              @click="store.regenerateCode()"
            >
              <AppIcon name="refresh" :size="15" />
            </button>
            <label class="allow">
              允许连我
              <span class="switch">
                <input
                  type="checkbox"
                  :checked="store.allowIncoming"
                  @change="store.setAllowIncoming(($event.target as HTMLInputElement).checked)"
                />
                <span class="slider"></span>
              </span>
            </label>
          </div>
          <div class="row">
            <input
              v-model="peerCode"
              placeholder="输入对方短码"
              inputmode="numeric"
              maxlength="9"
              @keyup.enter="connectByCode"
            />
            <button
              class="primary"
              :disabled="!/^\d{4,9}$/.test(peerCode.trim()) || store.status === 'connecting'"
              @click="connectByCode"
            >
              {{ store.status === 'connecting' ? '连接中…' : '连接' }}
            </button>
          </div>
        </div>

        <div class="method">
          <div class="mhead"><span class="num">02</span> 分享链接 / 扫码连接</div>
          <div class="row">
            <input :value="store.shareLink" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
            <button class="primary" @click="copy(store.shareLink, 'link')">
              <AppIcon :name="copiedLink ? 'check' : 'link'" :size="15" />
              {{ copiedLink ? '已复制' : '复制' }}
            </button>
          </div>
          <div class="qrrow">
            <div class="qr" v-html="qrSvg"></div>
            <p class="qrhint">手机扫码即连（同一网络下走局域网直连，不同网络自动 P2P 打洞）</p>
          </div>
        </div>

        <div class="method">
          <div class="mhead"><span class="num">03</span> 房间口令（多节点全网状组网）</div>
          <div class="row">
            <input
              v-model="roomName"
              placeholder="自定义口令，如 team-2026"
              spellcheck="false"
              @keyup.enter="joinNamedRoom"
            />
            <button
              class="primary"
              :disabled="!roomName.trim() || store.status === 'connecting'"
              @click="joinNamedRoom"
            >
              {{ store.status === 'connecting' ? '加入中…' : '加入' }}
            </button>
          </div>
        </div>
      </aside>
    </div>

    <!-- 全网动作条 -->
    <footer v-if="store.peerCount > 0" class="allbar" @click.stop>
      <span class="lbl">面向全网 {{ store.peerCount }} 个节点：</span>
      <button class="ghost" @click="store.openChat('all')">
        <AppIcon name="chat" :size="16" /> 群聊
        <i v-if="(store.unread.get('all') ?? 0) > 0" class="bdg">{{ store.unread.get('all') }}</i>
      </button>
      <button class="ghost" @click="store.actionSendFile('all')">
        <AppIcon name="upload" :size="16" /> 发文件
      </button>
      <button
        class="ghost"
        :disabled="!store.capabilities.displayMedia || store.sharing"
        @click="store.actionShareScreen('all')"
      >
        <AppIcon name="monitor" :size="16" /> 共享屏幕
      </button>
      <button class="ghost" @click="store.actionBoard('all')">
        <AppIcon name="pen" :size="16" /> 互动白板
      </button>
      <button
        class="ghost"
        title="在公共白板上开一轮你画我猜"
        :disabled="store.connectedPeers.length === 0"
        @click="store.actionGuess()"
      >
        <AppIcon name="dice" :size="16" /> 你画我猜
      </button>
    </footer>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.bar h1 {
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

.banner {
  margin: 10px 24px 0;
  border-radius: var(--radius-sm);
  padding: 9px 14px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.banner.danger {
  background: var(--danger-weak);
  color: var(--danger-fg);
  border: 1px solid var(--danger);
}

.banner.warn {
  background: var(--warn-weak);
  color: var(--warn-fg);
  border: 1px solid var(--warn);
  line-height: 1.6;
  align-items: flex-start;
}

.banner .close {
  margin-left: auto;
  padding: 2px 6px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  padding: 12px 24px;
}

/* —— 画布 —— */
.stage {
  flex: 1;
  min-width: 0;
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background:
    radial-gradient(circle at 50% 45%, var(--accent-weak) 0%, transparent 55%),
    var(--panel);
  overflow: hidden;
}

.wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.wire {
  stroke: var(--border-strong);
  stroke-width: 1.5;
  stroke-dasharray: 5 6;
  vector-effect: non-scaling-stroke;
}

.wire.on {
  stroke: var(--accent);
  stroke-dasharray: none;
  opacity: 0.55;
}

.wire.pending {
  stroke: var(--warn);
  animation: dash 1.2s linear infinite;
}

.wire.off {
  stroke: var(--danger);
  opacity: 0.5;
}

@keyframes dash {
  to { stroke-dashoffset: -22; }
}

/* —— 连线延迟标注 —— */
.rttchip {
  position: absolute;
  transform: translate(-50%, -50%);
  z-index: 1;
  font-size: 10px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 2px 6px;
  pointer-events: auto;
  white-space: nowrap;
}

.rttchip.slow {
  color: var(--warn-fg, #a05a00);
  border-color: var(--warn);
}

/* —— 节点 —— */
.node {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  z-index: 2;
  max-width: 120px;
}

.node .ring {
  position: relative;
  display: grid;
  place-items: center;
  border-radius: 50%;
  padding: 3px;
  border: 2.5px solid var(--border-strong);
  background: var(--panel);
  transition: border-color var(--dur), box-shadow var(--dur), transform var(--dur);
}

.node:hover .ring {
  transform: scale(1.06);
  box-shadow: var(--shadow-pop);
}

.node .ring.connected {
  border-color: var(--ok);
}

.node .ring.connecting,
.node .ring.new {
  border-color: var(--warn);
}

.node .ring.failed,
.node .ring.disconnected,
.node .ring.closed {
  border-color: var(--danger);
}

.node.self .ring {
  border-color: var(--accent);
}

.node.self .ring.online {
  box-shadow: 0 0 0 5px var(--accent-weak);
}

.node .name {
  font-size: 12.5px;
  font-weight: 600;
  max-width: 116px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.me {
  font-style: normal;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 0 4px;
  flex: none;
}

.node .state {
  font-size: 10.5px;
  color: var(--muted);
}

/* 中继：已连通但绕经服务器，用暖色与直连区分。 */
.node .state.relay {
  color: var(--warn, #d08a2c);
}

.node .live,
.node .ok,
.node .talk {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  border: 2px solid var(--panel);
  font-style: normal;
}

.node .live {
  background: var(--danger);
}

.node .ok {
  background: var(--ok);
}

/* 正在说话：常绿 + 呼吸圈。 */
.node .talk {
  background: var(--accent);
  animation: talkpulse 1.4s ease-out infinite;
}

@keyframes talkpulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  100% { box-shadow: 0 0 0 8px transparent; }
}

/* 拖文件悬停在节点上：高亮示意「松开发给 TA」。 */
.node.droptarget .ring {
  border-color: var(--accent);
  transform: scale(1.14);
  box-shadow: 0 0 0 6px var(--accent-weak);
}

.nbadge {
  position: absolute;
  top: -4px;
  right: 2px;
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 6px;
}

.empty-hint {
  position: absolute;
  left: 50%;
  bottom: 18%;
  transform: translateX(-50%);
  color: var(--muted);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.pulse {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ok);
  animation: pulse 1.6s ease-out infinite;
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 45%, transparent); }
  100% { box-shadow: 0 0 0 9px transparent; }
}

/* —— 弹层 —— */
.popover {
  position: absolute;
  z-index: 5;
  min-width: 190px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.popover header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 6px 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}

.popover .who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}

.popover .who strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popover .who span {
  font-size: 11px;
  color: var(--muted);
}

.popover > button {
  display: flex;
  align-items: center;
  gap: 9px;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  text-align: left;
}

.popover > button:hover:not(:disabled) {
  background: var(--accent-weak);
  color: var(--accent-strong);
}

.okdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  margin-left: auto;
}

/* 名片编辑 */
.popover.profile {
  left: 50%;
  top: 50%;
  transform: translate(-50%, calc(-50% - 60px));
  width: 264px;
}

.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 5px 6px;
  font-size: 12px;
  color: var(--muted);
}

.fld input {
  padding: 7px 10px;
  font-size: 13px;
}

.emojis {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 3px;
}

.emoji {
  padding: 3px 0;
  font-size: 15px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 7px;
}

.emoji.on {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.colors {
  display: flex;
  gap: 6px;
}

.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
}

.swatch.on {
  border-color: var(--text);
}

.imgbtn {
  margin: 2px 6px 4px;
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* SAS 弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 24, 0.45);
  display: grid;
  place-items: center;
  z-index: 30;
}

.modal {
  width: min(400px, calc(100vw - 48px));
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  padding: 20px 22px;
}

.modal h3 {
  margin: 0 0 12px;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-strong);
}

.sas-emoji {
  font-size: 30px;
  letter-spacing: 6px;
  text-align: center;
  margin: 10px 0 4px;
}

.sas-digits {
  font-family: var(--font-mono);
  font-size: 17px;
  letter-spacing: 3px;
  text-align: center;
  color: var(--text-2);
  margin: 0 0 10px;
}

.modal .hint {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 14px;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.verified-tag {
  color: var(--ok);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

/* —— 连接面板 —— */
.connect {
  width: 300px;
  flex: none;
  align-self: flex-start;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 100%;
  overflow-y: auto;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-head h2 {
  margin: 0;
  font-size: 13.5px;
}

.dash {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.dash::before {
  content: '';
  width: 14px;
  height: 2px;
  border-radius: 2px;
  background: var(--brand-grad);
}

.method {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mhead {
  font-size: 12.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 7px;
}

.num {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.row input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  padding: 7px 10px;
}

.code-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 3px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  background: var(--pill);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 5px 8px 5px 13px;
}

.iconbtn {
  padding: 6px 8px;
}

.allow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
}

/* —— 二维码 —— */
.qrrow {
  display: flex;
  align-items: center;
  gap: 12px;
}

.qr {
  width: 116px;
  height: 116px;
  flex: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--border);
  padding: 4px;
}

.qr :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.qrhint {
  margin: 0;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
}

/* —— 全网动作条 —— */
.allbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 24px 14px;
  flex-wrap: wrap;
}

.allbar .lbl {
  font-size: 12.5px;
  color: var(--muted);
  margin-right: 4px;
}

.allbar button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  position: relative;
}

.bdg {
  font-style: normal;
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 6px;
}

@media (max-width: 900px) {
  .body {
    flex-direction: column;
    overflow-y: auto;
  }

  .stage {
    min-height: 380px;
  }

  .connect {
    width: 100%;
  }
}
</style>
