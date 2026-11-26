<script lang="ts" setup>
// VitePress 1.6.4's VPLink, which config.mts puts in its place, with one change: a link with
// target="_self" keeps its href as config.mts built it. Those are the header's landing links
// (/site/blog/, /elsewhere/), which normalizeLink would put under the docs base. Every other
// link is normalized as VitePress does it.
import { computed } from 'vue'
import { normalizeLink } from 'vitepress/dist/client/theme-default/support/utils.js'
import { EXTERNAL_URL_RE } from 'vitepress/dist/client/shared.js'

const props = defineProps<{
  tag?: string
  href?: string
  noIcon?: boolean
  target?: string
  rel?: string
}>()

const tag = computed(() => props.tag ?? (props.href ? 'a' : 'span'))
const isExternal = computed(
  () =>
    (props.href && EXTERNAL_URL_RE.test(props.href)) ||
    props.target === '_blank'
)
const link = computed(() => {
  if (!props.href) return undefined
  return props.target === '_self' ? props.href : normalizeLink(props.href)
})
</script>

<template>
  <component
    :is="tag"
    class="VPLink"
    :class="{
      link: href,
      'vp-external-link-icon': isExternal,
      'no-icon': noIcon
    }"
    :href="link"
    :target="target ?? (isExternal ? '_blank' : undefined)"
    :rel="rel ?? (isExternal ? 'noreferrer' : undefined)"
  >
    <slot />
  </component>
</template>
