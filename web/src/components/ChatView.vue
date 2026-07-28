<script setup lang="ts">
// 聊天：左侧频道列表（群聊 + 每个节点的私聊），右侧消息流。
// 私聊经 control 通道只发给对方；群聊广播给全网。
import { computed, nextTick, ref, watch } from 'vue'
import { useRoomStore } from '@/stores/room'
import { fmtTime } from '@/utils/format'
import AppIcon from './AppIcon.vue'
import PeerAvatar from './PeerAvatar.vue'

const store = useRoomStore()

const draft = ref('')
const logEl = ref<HTMLElement | null>(null)
const copiedId = ref<number | null>(null)

const channelMessages = computed(() =>
  store.messages.filter((m) => m.channel === store.activeChannel),
)

const channelName = computed(() =>
  store.activeChannel === 'all' ? '群聊（全网）' : store.displayName(store.activeChannel),
)

/** 私聊对象是否在线可达。 */
const channelReachable = computed(
  () =>
    store.activeChannel === 'all'
      ? store.connectedPeers.length > 0
      : store.members.get(store.activeChannel)?.state === 'connected',
)

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

/** 一键剪贴板互传（降级版）：点击读取本机剪贴板并直接发出。 */
async function sendClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (text.trim()) store.sendChat(text)
  } catch {
    store.lastError = '无法读取剪贴板（需 https 且授予权限）'
  }
}

async function copyMessage(id: number, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedId.value = id
    setTimeout(() => (copiedId.value = null), 1200)
  } catch {
    /* ignore */
  }
}

function pickChannel(ch: 'all' | string) {
  store.openChat(ch)
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
    <div class="main">
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
      </header>

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
          <div class="bubble-row">
            <div class="bubble">{{ msg.text }}</div>
            <button
              class="copy"
              :title="copiedId === msg.id ? '已复制' : '复制'"
              @click="copyMessage(msg.id, msg.text)"
            >
              <AppIcon :name="copiedId === msg.id ? 'check' : 'copy'" :size="14" />
            </button>
          </div>
        </div>
      </div>

      <div class="composer">
        <button
          class="ghost clip"
          title="发送剪贴板内容"
          :disabled="!channelReachable"
          @click="sendClipboard"
        >
          <AppIcon name="clipboard" :size="18" />
        </button>
        <input
          v-model="draft"
          :placeholder="channelReachable ? '输入消息或粘贴长文本，回车发送…' : '对方不可达，暂不能发送'"
          :disabled="!channelReachable"
          @keyup.enter="send"
        />
        <button class="primary" :disabled="!draft.trim() || !channelReachable" @click="send">
          <AppIcon name="send" :size="15" /> 发送
        </button>
      </div>
    </div>
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
