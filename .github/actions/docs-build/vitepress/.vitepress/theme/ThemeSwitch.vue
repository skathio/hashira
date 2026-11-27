<script lang="ts" setup>
// Takes the place of VitePress 1.6.4's VPSwitchAppearance (config.mts aliases it), so the docs
// header, its "..." menu and the phone menu get the landing pages' three-state theme control
// instead of a light/dark switch that can never return to auto. It steps through site-kit
// theme.js's cycle: auto -> the opposite of the system theme -> the system theme -> auto, and
// stores the choice under the shared `theme` localStorage key.
//
// VitePress still applies the theme: its useDark reads vitepress-theme-appearance through
// vueuse's useStorage, which listens for `storage` events. Writing that key and dispatching the
// event makes VitePress apply light, dark or auto (following the system) at once, with its
// transitions off. With storage blocked the class is set here and lasts for the page.
import { computed, onMounted, onUnmounted, ref } from 'vue'

type Theme = 'auto' | 'light' | 'dark'
const KEY = 'theme'
const VP_KEY = 'vitepress-theme-appearance'
const LABEL: Record<Theme, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' }

const current = ref<Theme>('auto')

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'auto'
  } catch {
    return 'auto'
  }
}

const system = (): 'light' | 'dark' => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

function following(v: Theme): Theme {
  const sys = system()
  if (v === 'auto') return sys === 'dark' ? 'light' : 'dark'
  return v === sys ? 'auto' : sys
}

function apply(v: Theme, store: boolean) {
  current.value = v
  try {
    if (store) localStorage.setItem(KEY, v)
    const oldValue = localStorage.getItem(VP_KEY)
    localStorage.setItem(VP_KEY, v)
    window.dispatchEvent(new StorageEvent('storage', { key: VP_KEY, oldValue, newValue: v, storageArea: localStorage }))
  } catch {
    document.documentElement.classList.toggle('dark', v === 'auto' ? system() === 'dark' : v === 'dark')
  }
}

// The landing page in another tab changed the choice, or another copy of this control (the
// header, its "..." menu and the phone menu each hold one) applied a new one.
function onStorage(e: StorageEvent) {
  if (e.key === KEY) apply(read(), false)
  else if (e.key === VP_KEY) current.value = read()
}

onMounted(() => {
  current.value = read()
  window.addEventListener('storage', onStorage)
})
onUnmounted(() => window.removeEventListener('storage', onStorage))

const label = computed(() => `Theme: ${LABEL[current.value]}`)
</script>

<template>
  <button
    type="button"
    class="VPSwitchAppearance site-theme-switch"
    :aria-label="label"
    :title="label"
    @click="apply(following(current), true)"
  >
    <span v-if="current === 'light'" class="vpi-sun icon" aria-hidden="true" />
    <span v-else-if="current === 'dark'" class="vpi-moon icon" aria-hidden="true" />
    <svg v-else class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" />
    </svg>
  </button>
</template>

<style scoped>
.site-theme-switch {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  color: var(--vp-c-text-2);
}

.site-theme-switch:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-default-soft);
}

.site-theme-switch:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.icon {
  display: block;
  width: 18px;
  height: 18px;
}
</style>
