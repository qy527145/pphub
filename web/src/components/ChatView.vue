<script setup lang="ts">
// 聊天：左侧频道列表（群聊 + 每个节点的私聊），右侧消息流。
// 私聊经 control 通道只发给对方；群聊广播给全网。
// 文件/截图三种进入方式：选择、粘贴（Ctrl/Cmd+V）、拖拽（含文件夹，自动打包 zip）。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoomStore, type ChatEntry } from '@/stores/room'
import { fmtBytes, fmtTime } from '@/utils/format'
import { copyText } from '@/utils/clipboard'
import { collectDropped } from '@/utils/fs'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import GomokuPanel from './GomokuPanel.vue'

const store = useRoomStore()

const draft = ref('')
const logEl = ref<HTMLElement | null>(null)
const copiedId = ref<number | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

/** 表情回应的候选（点开即发，再点撤销）。 */
const REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '👏']

const channelMessages = computed(() =>
  store.messages.filter((m) => m.channel === store.activeChannel),
)

const channelName = computed(() =>
  store.activeChannel === 'all' ? '群聊（全网）' : store.displayName(store.activeChannel),
)

const isDm = computed(() => store.activeChannel !== 'all')

/** 私聊对象是否在线可达。 */
const channelReachable = computed(
  () =>
    store.activeChannel === 'all'
      ? store.connectedPeers.length > 0
      : store.members.get(store.activeChannel)?.state === 'connected',
)

/** 当前私聊频道的五子棋对局（若有）。 */
const dmGame = computed(() => (isDm.value ? store.gomoku.get(store.activeChannel) : undefined))

watch(
  () => [channelMessages.value.length, store.activeChannel] as const,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

function send() {
  if (!draft.value.trim()) return
  store.sendChat(draft.value)
  draft.value = ''
}

function pickFile() {
  fileInput.value?.click()
}

/** 懒发送：挂共享，对方在接收页下载；scope 跟随当前频道（私聊=单播，群聊=广播）。 */
function shareToChannel(files: File[]) {
  const target = store.activeChannel === 'all' ? 'all' : store.activeChannel
  void store.shareFiles(files, target)
}

function onFilePicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (!input.files?.length) return
  shareToChannel([...input.files])
  input.value = ''
}

/** 粘贴文件/截图直接发送；纯文本仍走输入框默认粘贴。 */
function onPaste(ev: ClipboardEvent) {
  const files = ev.clipboardData?.files
  if (!files?.length) return
  ev.preventDefault()
  if (!channelReachable.value) {
    store.lastError = '对方不可达，暂不能发送文件'
    return
  }
  shareToChannel([...files])
}

onMounted(() => window.addEventListener('paste', onPaste))
onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  stopRecord(true)
})

// —— 拖拽发送（文件 / 文件夹，文件夹自动打包 zip）——
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)

function dragHasFiles(ev: DragEvent): boolean {
  return [...(ev.dataTransfer?.types ?? [])].includes('Files')
}

function onDragEnter(ev: DragEvent) {
  if (dragHasFiles(ev)) dragDepth.value++
}

function onDragLeave(ev: DragEvent) {
  if (dragHasFiles(ev) && dragDepth.value > 0) dragDepth.value--
}

async function onDrop(ev: DragEvent) {
  dragDepth.value = 0
  if (!ev.dataTransfer) return
  if (!channelReachable.value) {
    store.lastError = '对方不可达，暂不能发送文件'
    return
  }
  const payload = await collectDropped(ev.dataTransfer)
  if (payload.files.length === 0 && payload.folders.length === 0) return
  const target = store.activeChannel === 'all' ? 'all' : store.activeChannel
  void store.dispatchPayload(payload, 'lazy', target)
}

// —— 图片灯箱 ——
const lightbox = ref<{ url: string; name: string; fileId: string; full: boolean } | null>(null)

function openImage(msg: ChatEntry) {
  const f = msg.file
  if (!f?.thumb) return
  const share = store.shares.get(f.fileId)
  const fullUrl = share?.state === 'done' ? share.url : undefined
  lightbox.value = {
    url: fullUrl ?? f.thumb,
    name: f.name,
    fileId: f.fileId,
    full: !!fullUrl,
  }
}

/** 灯箱里点「下载原图」：走多源下载，完成后自动换成原图。 */
function downloadOriginal() {
  const lb = lightbox.value
  if (!lb) return
  store.downloadShare(lb.fileId)
}

// 正在看的图下载完成 → 无缝换原图。
watch(
  () => lightbox.value && store.shares.get(lightbox.value.fileId)?.url,
  (url) => {
    if (lightbox.value && url && !lightbox.value.full) {
      lightbox.value = { ...lightbox.value, url, full: true }
    }
  },
)

// —— 语音消息（按住录音，松开发送）——
const recording = ref(false)
const recordMs = ref(0)
let recorder: MediaRecorder | null = null
let recChunks: Blob[] = []
let recTimer: ReturnType<typeof setInterval> | null = null
let recStart = 0
let recCanceled = false
let pressing = false

const canRecord = computed(
  () => store.capabilities.userMedia && typeof MediaRecorder !== 'undefined',
)

function pickRecordMime(): string | undefined {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

async function startRecord(ev: PointerEvent) {
  if (recording.value || !canRecord.value || !channelReachable.value) return
  pressing = true
  ;(ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId)
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    store.lastError = '无法访问麦克风（未授权或被占用）'
    pressing = false
    return
  }
  // 等授权期间用户已松手：不开始录音。
  if (!pressing) {
    for (const t of stream.getTracks()) t.stop()
    return
  }
  const mime = pickRecordMime()
  try {
    recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined,
    )
  } catch {
    recorder = new MediaRecorder(stream)
  }
  recChunks = []
  recCanceled = false
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) recChunks.push(e.data)
  }
  recorder.onstop = () => {
    for (const t of stream.getTracks()) t.stop()
    const dur = Date.now() - recStart
    recording.value = false
    if (recTimer !== null) {
      clearInterval(recTimer)
      recTimer = null
    }
    if (recCanceled || dur < 400 || recChunks.length === 0) return
    const blob = new Blob(recChunks, { type: recorder?.mimeType || mime || 'audio/webm' })
    void store.sendVoiceNote(blob, Math.min(dur, 60_000))
  }
  recStart = Date.now()
  recordMs.value = 0
  recording.value = true
  recTimer = setInterval(() => {
    recordMs.value = Date.now() - recStart
    if (recordMs.value >= 60_000) stopRecord(false) // 上限 60s 自动截断发送
  }, 200)
  recorder.start()
}

function stopRecord(cancel: boolean) {
  pressing = false
  if (!recorder || recorder.state === 'inactive') return
  recCanceled = cancel
  recorder.stop()
}

// —— 语音播放（同一时刻只播一条）——
const playingId = ref<number | null>(null)
const playPos = ref(0)
let player: HTMLAudioElement | null = null

function toggleVoice(msg: ChatEntry) {
  if (!msg.voice) return
  if (playingId.value === msg.id) {
    player?.pause()
    playingId.value = null
    return
  }
  player?.pause()
  player = new Audio(msg.voice.url)
  playingId.value = msg.id
  playPos.value = 0
  player.ontimeupdate = () => {
    playPos.value = (player?.currentTime ?? 0) * 1000
  }
  player.onended = () => {
    playingId.value = null
  }
  void player.play().catch(() => {
    playingId.value = null
    store.lastError = '语音播放失败'
  })
}

function fmtDur(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}″`
}

// —— 表情回应 ——
/** 我是否已用该 emoji 回应过这条消息。 */
function reactedByMe(msg: ChatEntry, emoji: string): boolean {
  return msg.reactions?.[emoji]?.includes(store.myId) ?? false
}

/** 回应 chips 的悬浮提示（谁回应的）。 */
function reactTitle(msg: ChatEntry, emoji: string): string {
  return (msg.reactions?.[emoji] ?? []).map((p) => store.displayName(p)).join('、')
}

async function copyMessage(id: number, text: string) {
  if (!(await copyText(text))) {
    store.lastError = '复制失败，请手动选中文本复制'
    return
  }
  copiedId.value = id
  setTimeout(() => (copiedId.value = null), 1200)
}

function pickChannel(ch: 'all' | string) {
  store.openChat(ch)
}

/** 私聊里点「五子棋」：有对局就打开棋盘，否则发出邀请。 */
function gomokuEntry() {
  const peer = store.activeChannel
  if (peer === 'all') return
  if (store.gomoku.has(peer)) {
    store.gomokuOpen = peer
  } else {
    store.inviteGomoku(peer)
  }
}
</script>

<template>
  <div class="chatpage">
    <!-- 频道列表 -->
    <aside class="channels">
      <button
        class="channel"
        :class="{ on: store.activeChannel === 'all' }"
        @click="pickChannel('all')"
      >
        <span class="cicon"><AppIcon name="hub" :size="17" /></span>
        <span class="cname">群聊（全网）</span>
        <span v-if="(store.unread.get('all') ?? 0) > 0" class="badge">
          {{ store.unread.get('all') }}
        </span>
      </button>
      <div class="chdivider">私聊</div>
      <button
        v-for="m in store.memberList"
        :key="m.peerId"
        class="channel"
        :class="{ on: store.activeChannel === m.peerId }"
        @click="pickChannel(m.peerId)"
      >
        <PeerAvatar :avatar="m.profile?.avatar" :seed="m.peerId" :size="26" />
        <span class="cname">{{ store.displayName(m.peerId) }}</span>
        <span v-if="(store.unread.get(m.peerId) ?? 0) > 0" class="badge">
          {{ store.unread.get(m.peerId) }}
        </span>
      </button>
      <p v-if="store.memberList.length === 0" class="chempty">暂无其它节点</p>
    </aside>

    <!-- 消息区 -->
    <div
      class="main"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <header class="head">
        <h1><AppIcon name="chat" :size="20" /> {{ channelName }}</h1>
        <span class="sub">
          {{
            store.activeChannel === 'all'
              ? store.connectedPeers.length > 0
                ? `${store.connectedPeers.length} 个节点在线 · 端到端直传`
                : '未连接节点'
              : channelReachable
                ? '一对一加密直传 · 其他节点不可见'
                : '对方暂不可达'
          }}
        </span>
        <button
          v-if="isDm"
          class="ghost gamebtn"
          :disabled="!channelReachable && !dmGame"
          :title="dmGame ? '打开棋盘' : '邀请对方下五子棋'"
          @click="gomokuEntry"
        >
          <AppIcon name="dice" :size="16" />
          {{ dmGame ? (dmGame.state === 'active' ? '对局中' : '五子棋') : '五子棋' }}
        </button>
      </header>

      <!-- 五子棋邀请横幅（私聊内） -->
      <div v-if="dmGame?.state === 'invite-in'" class="gbanner">
        <AppIcon name="dice" :size="16" />
        {{ store.displayName(dmGame.opponent) }} 邀请你下五子棋
        <button class="primary" @click="store.respondGomoku(dmGame.opponent, true)">接受</button>
        <button class="ghost" @click="store.respondGomoku(dmGame.opponent, false)">婉拒</button>
      </div>

      <div ref="logEl" class="log">
        <div v-if="channelMessages.length === 0" class="empty">
          <AppIcon name="chat" :size="36" />
          <p>
            {{
              store.activeChannel === 'all'
                ? '消息与长文本在设备间加密直传，刷新即焚，不留痕迹。'
                : '与该节点的私聊只在你们两台设备间直传。'
            }}
          </p>
        </div>
        <div
          v-for="msg in channelMessages"
          :key="msg.id"
          class="msg"
          :class="{ mine: msg.self }"
        >
          <div class="meta">
            <span class="who">{{ msg.fromNick }}</span>
            <span class="time">{{ fmtTime(msg.ts) }}</span>
          </div>
          <!-- 图片卡片（内联缩略图，点击放大） -->
          <div v-if="msg.file?.thumb" class="bubble-row">
            <button class="imgcard" title="点击查看大图" @click="openImage(msg)">
              <img :src="msg.file.thumb" :alt="msg.file.name" />
              <span class="imgmeta">{{ fmtBytes(msg.file.size) }}</span>
            </button>
          </div>
          <!-- 文件卡片 -->
          <div v-else-if="msg.file" class="bubble file-card" :class="{ 'mine-bubble': msg.self }">
            <AppIcon :name="msg.file.name.endsWith('.zip') ? 'folder' : 'file'" :size="20" />
            <div class="fc-info">
              <span class="fc-name">{{ msg.file.name }}</span>
              <span class="fc-size">{{ fmtBytes(msg.file.size) }}</span>
            </div>
            <button
              v-if="!msg.self"
              class="ghost fc-dl"
              title="下载"
              @click="store.downloadShare(msg.file.fileId)"
            >
              <AppIcon name="download" :size="15" />
            </button>
          </div>
          <!-- 语音消息 -->
          <div v-else-if="msg.voice" class="bubble-row">
            <button
              class="bubble voice"
              :class="{ 'mine-bubble': msg.self, playing: playingId === msg.id }"
              @click="toggleVoice(msg)"
            >
              <AppIcon :name="playingId === msg.id ? 'pause' : 'play'" :size="15" />
              <span class="vwave" :class="{ anim: playingId === msg.id }"><i /><i /><i /><i /></span>
              <span class="vdur">
                {{ playingId === msg.id ? fmtDur(playPos) + ' / ' : '' }}{{ fmtDur(msg.voice.dur) }}
              </span>
            </button>
            <div v-if="msg.msgId" class="reactbar">
              <button
                v-for="e in REACT_EMOJIS"
                :key="e"
                class="remoji"
                @click="store.toggleReact(msg, e)"
              >{{ e }}</button>
            </div>
          </div>
          <!-- 普通文本气泡 -->
          <div v-else class="bubble-row">
            <div class="bubble">{{ msg.text }}</div>
            <div class="rowtools">
              <button
                class="copy"
                :title="copiedId === msg.id ? '已复制' : '复制'"
                @click="copyMessage(msg.id, msg.text)"
              >
                <AppIcon :name="copiedId === msg.id ? 'check' : 'copy'" :size="14" />
              </button>
              <div v-if="msg.msgId" class="reactbar">
                <button
                  v-for="e in REACT_EMOJIS"
                  :key="e"
                  class="remoji"
                  @click="store.toggleReact(msg, e)"
                >{{ e }}</button>
              </div>
            </div>
          </div>
          <!-- 表情回应 chips -->
          <div v-if="msg.reactions && Object.keys(msg.reactions).length" class="reacts">
            <button
              v-for="(who, e) in msg.reactions"
              :key="e"
              class="rchip"
              :class="{ mine: reactedByMe(msg, String(e)) }"
              :title="reactTitle(msg, String(e))"
              @click="store.toggleReact(msg, String(e))"
            >
              {{ e }} <span v-if="who.length > 1">{{ who.length }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="composer">
        <button
          v-if="canRecord"
          class="ghost clip"
          :class="{ rec: recording }"
          :disabled="!channelReachable"
          :title="recording ? '松开发送，上限 60 秒' : '按住说一段语音'"
          @pointerdown.prevent="startRecord($event)"
          @pointerup="stopRecord(false)"
          @pointercancel="stopRecord(true)"
        >
          <AppIcon name="mic" :size="18" />
        </button>
        <button
          class="ghost clip"
          title="发送文件（懒发送，对方在接收页下载；也可粘贴或拖拽文件/文件夹）"
          :disabled="!channelReachable"
          @click="pickFile"
        >
          <AppIcon name="upload" :size="18" />
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="onFilePicked" />
        <input
          v-model="draft"
          :placeholder="
            recording
              ? `录音中 ${fmtDur(recordMs)}（松开发送）…`
              : channelReachable
                ? '输入消息，回车发送；文件可粘贴或拖入…'
                : '对方不可达，暂不能发送'
          "
          :disabled="!channelReachable"
          @keyup.enter="send"
        />
        <button class="primary" :disabled="!draft.trim() || !channelReachable" @click="send">
          <AppIcon name="send" :size="15" /> 发送
        </button>
      </div>

      <!-- 打包提示 -->
      <div v-if="store.packing > 0" class="packing">正在打包文件夹…</div>

      <!-- 拖拽遮罩 -->
      <div v-if="dragging" class="dropmask">
        <AppIcon name="upload" :size="40" />
        <p>松开即发送到「{{ channelName }}」</p>
        <span>支持多文件与文件夹（自动打包 zip）</span>
      </div>
    </div>

    <!-- 图片灯箱 -->
    <div v-if="lightbox" class="lightbox" @click.self="lightbox = null">
      <img :src="lightbox.url" :alt="lightbox.name" />
      <div class="lbbar">
        <span class="lbname">{{ lightbox.name }}</span>
        <span v-if="!lightbox.full" class="lbhint">预览为缩略图</span>
        <button
          v-if="!lightbox.full && !store.shares.get(lightbox.fileId)?.local"
          class="primary"
          :disabled="store.shares.get(lightbox.fileId)?.state === 'downloading'"
          @click="downloadOriginal"
        >
          {{
            store.shares.get(lightbox.fileId)?.state === 'downloading'
              ? '下载中…'
              : '下载原图'
          }}
        </button>
        <button class="ghost" @click="lightbox = null"><AppIcon name="x" :size="15" /></button>
      </div>
    </div>

    <!-- 五子棋棋盘 -->
    <GomokuPanel v-if="store.gomokuOpen" :peer-id="store.gomokuOpen" />
  </div>
</template>

<style scoped>
.chatpage {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* —— 频道列表 —— */
.channels {
  width: 200px;
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 12px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.channel {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  text-align: left;
  color: var(--text-2);
}

.channel:hover {
  background: var(--panel-2);
  color: var(--text);
}

.channel.on {
  background: var(--accent-weak);
  color: var(--accent-strong);
  font-weight: 600;
}

.cicon {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent-weak);
  color: var(--accent);
}

.cname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  background: var(--danger);
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 6px;
}

.chdivider {
  font-size: 11px;
  color: var(--faint);
  padding: 10px 10px 4px;
}

.chempty {
  font-size: 12px;
  color: var(--faint);
  padding: 4px 10px;
  margin: 0;
}

/* —— 消息区 —— */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
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

.gamebtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.gbanner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 24px 0;
  padding: 9px 14px;
  font-size: 13px;
  border: 1px solid var(--accent);
  background: var(--accent-weak);
  color: var(--accent-strong);
  border-radius: var(--radius-sm);
}

.gbanner .primary,
.gbanner .ghost {
  padding: 4px 12px;
  font-size: 12.5px;
}

.gbanner .primary {
  margin-left: auto;
}

.log {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.empty {
  margin: auto;
  color: var(--muted);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 40ch;
}

.msg {
  max-width: 70%;
  align-self: flex-start;
}

.msg.mine {
  align-self: flex-end;
}

.meta {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
  display: flex;
  gap: 8px;
}

.msg.mine .meta {
  justify-content: flex-end;
}

.bubble-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.msg.mine .bubble-row {
  flex-direction: row-reverse;
}

.bubble {
  display: inline-block;
  padding: 9px 13px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: var(--shadow-soft);
}

/* —— 图片卡片 —— */
.imgcard {
  position: relative;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
  box-shadow: var(--shadow-soft);
  cursor: zoom-in;
  line-height: 0;
}

.imgcard img {
  max-width: 260px;
  max-height: 200px;
  display: block;
  object-fit: cover;
}

.imgmeta {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: 10.5px;
  line-height: 1;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 6px;
  padding: 3px 6px;
}

.file-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 13px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  min-width: 200px;
  max-width: 280px;
  color: var(--accent);
}

.file-card.mine-bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.fc-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fc-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.file-card.mine-bubble .fc-name {
  color: var(--on-accent);
}

.fc-size {
  font-size: 11px;
  color: var(--muted);
}

.file-card.mine-bubble .fc-size {
  color: color-mix(in srgb, var(--on-accent) 70%, transparent);
}

.fc-dl {
  padding: 4px 6px;
  flex: none;
}

/* —— 语音气泡 —— */
.bubble.voice {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  min-width: 120px;
  color: var(--accent-strong);
}

.bubble.voice.mine-bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.msg.mine .bubble.voice {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.vwave {
  display: inline-flex;
  align-items: center;
  gap: 2.5px;
  height: 14px;
}

.vwave i {
  width: 2.5px;
  height: 6px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.75;
}

.vwave i:nth-child(2) {
  height: 12px;
}

.vwave i:nth-child(3) {
  height: 8px;
}

.vwave i:nth-child(4) {
  height: 11px;
}

.vwave.anim i {
  animation: vbounce 0.9s ease-in-out infinite;
}

.vwave.anim i:nth-child(2) {
  animation-delay: 0.15s;
}

.vwave.anim i:nth-child(3) {
  animation-delay: 0.3s;
}

.vwave.anim i:nth-child(4) {
  animation-delay: 0.45s;
}

@keyframes vbounce {
  0%,
  100% {
    transform: scaleY(0.6);
  }

  50% {
    transform: scaleY(1.4);
  }
}

.vdur {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* —— 表情回应 —— */
.rowtools {
  display: flex;
  align-items: center;
  gap: 4px;
}

.msg.mine .rowtools {
  flex-direction: row-reverse;
}

.reactbar {
  display: inline-flex;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 2px 5px;
  box-shadow: var(--shadow-soft);
  opacity: 0;
  transition: opacity 0.15s;
}

.bubble-row:hover .reactbar {
  opacity: 1;
}

.remoji {
  border: none;
  background: transparent;
  font-size: 13px;
  padding: 2px 3px;
  border-radius: 6px;
  line-height: 1;
}

.remoji:hover {
  background: var(--accent-weak);
  transform: scale(1.2);
}

.reacts {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.msg.mine .reacts {
  justify-content: flex-end;
}

.rchip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--panel);
}

.rchip.mine {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.rchip span {
  font-size: 10.5px;
  color: var(--muted);
}

.msg .bubble {
  border-bottom-left-radius: 5px;
}

.msg.mine .bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  border-bottom-left-radius: 14px;
  border-bottom-right-radius: 5px;
}

.copy {
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.bubble-row:hover .copy {
  opacity: 1;
}

.copy:hover {
  color: var(--accent);
}

.composer {
  display: flex;
  gap: 10px;
  padding: 14px 24px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.composer input {
  flex: 1;
}

.composer .primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.clip {
  padding: 8px 10px;
  touch-action: none;
}

.clip.rec {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  animation: recpulse 1.2s ease-in-out infinite;
}

@keyframes recpulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 45%, transparent);
  }

  50% {
    box-shadow: 0 0 0 6px transparent;
  }
}

.packing {
  position: absolute;
  left: 50%;
  bottom: 76px;
  transform: translateX(-50%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-pop);
  font-size: 12.5px;
  color: var(--muted);
  padding: 7px 16px;
}

.dropmask {
  position: absolute;
  inset: 8px;
  z-index: 10;
  border: 2.5px dashed var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent-weak) 85%, transparent);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--accent-strong);
  pointer-events: none;
}

.dropmask p {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.dropmask span {
  font-size: 12px;
  color: var(--muted);
}

/* —— 图片灯箱 —— */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: rgba(8, 6, 20, 0.82);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  cursor: zoom-out;
}

.lightbox img {
  max-width: min(92vw, 1400px);
  max-height: 82vh;
  border-radius: 10px;
  box-shadow: var(--shadow-pop);
  cursor: default;
}

.lbbar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 8px 10px 8px 18px;
  cursor: default;
}

.lbname {
  font-size: 13px;
  font-weight: 600;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lbhint {
  font-size: 11.5px;
  color: var(--muted);
}

.lbbar .primary,
.lbbar .ghost {
  padding: 5px 12px;
  font-size: 12.5px;
}

@media (max-width: 700px) {
  .channels {
    width: 60px;
  }

  .cname,
  .chdivider,
  .chempty {
    display: none;
  }

  .channel {
    justify-content: center;
    padding: 8px 0;
  }
}
</style>
