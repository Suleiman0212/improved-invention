<template>
  <div class="rounded-md border border-border bg-card p-5 font-mono">
    <div class="mb-4 flex items-center gap-2 border-b border-border pb-3 text-xs text-muted-foreground">
      <span class="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
      <span class="inline-block h-2.5 w-2.5 rounded-full bg-yellow-500" />
      <span class="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
      <span class="ml-2 text-comment">{{ title }}</span>
    </div>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  title: String,
});
</script>