<script setup lang="ts">
import { ref } from 'vue'
import { useRoomStore } from '@/stores/room'
import AppIcon from './AppIcon.vue'

const emit = defineEmits<{
  close: []
}>()

const store = useRoomStore()

const tableNumber = ref('')
const password = ref('')
const showPassword = ref(false)
const loading = ref(false)

function handleJoin() {
  const number = tableNumber.value.trim().replace(/^#/, '') // 去掉 # 前缀

  if (!number) {
    store.lastError = '请输入桌号'
    return
  }

  if (!/^\d{4,6}$/.test(number)) {
    store.lastError = '桌号格式错误，应为 4-6 位数字'
    return
  }

  loading.value = true

  // 尝试加入
  const success = store.joinGameTableByNumber(number, password.value || undefined)

  loading.value = false

  if (success) {
    emit('close')
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    handleJoin()
  } else if (e.key === 'Escape') {
    emit('close')
  }
}
</script>

<template>
  <div class="dialog-mask" @click.self="$emit('close')" @keydown="handleKeydown">
    <div class="dialog">
      <header class="dialog-header">
        <h3>加入游戏桌</h3>
        <button class="btn-close" @click="$emit('close')">
          <AppIcon name="x" :size="16" />
        </button>
      </header>

      <div class="dialog-body">
        <div class="form-group">
          <label for="table-number">桌号</label>
          <input
            id="table-number"
            v-model="tableNumber"
            type="text"
            placeholder="输入 4-6 位数字，如 1234"
            maxlength="7"
            autofocus
            @keydown.enter="handleJoin"
          />
          <p class="hint">可以输入 #1234 或 1234</p>
        </div>

        <div class="form-group">
          <label for="password">密码（可选）</label>
          <div class="password-input">
            <input
              id="password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              placeholder="如果是加密桌，请输入密码"
              @keydown.enter="handleJoin"
            />
            <button
              class="btn-toggle-password"
              type="button"
              @click="showPassword = !showPassword"
            >
              <AppIcon :name="showPassword ? 'eye-off' : 'eye'" :size="16" />
            </button>
          </div>
        </div>

        <div v-if="store.lastError" class="error-message">
          {{ store.lastError }}
        </div>
      </div>

      <footer class="dialog-footer">
        <button class="btn-cancel" @click="$emit('close')">取消</button>
        <button class="btn-confirm" :disabled="loading" @click="handleJoin">
          {{ loading ? '加入中...' : '加入游戏桌' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: 100;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dialog {
  width: min(450px, calc(100vw - 40px));
  background: var(--panel);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
  color: var(--text);
}

.btn-close {
  padding: 6px;
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: all 0.2s;
}

.btn-close:hover {
  background: var(--hover);
  color: var(--text);
}

.dialog-body {
  padding: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.form-group input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  transition: all 0.2s;
}

.form-group input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}

.hint {
  margin: 6px 0 0 0;
  font-size: 12px;
  color: var(--muted);
}

.password-input {
  position: relative;
}

.password-input input {
  padding-right: 40px;
}

.btn-toggle-password {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  padding: 6px;
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: all 0.2s;
}

.btn-toggle-password:hover {
  background: var(--hover);
  color: var(--text);
}

.error-message {
  padding: 12px;
  background: var(--error-weak);
  border: 1px solid var(--error);
  border-radius: var(--radius);
  color: var(--error);
  font-size: 13px;
  margin-top: 16px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border);
}

.btn-cancel,
.btn-confirm {
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel {
  background: var(--hover);
  color: var(--text);
}

.btn-cancel:hover {
  background: var(--muted-weak);
}

.btn-confirm {
  background: var(--accent);
  color: white;
}

.btn-confirm:hover:not(:disabled) {
  background: var(--accent-strong);
}

.btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
