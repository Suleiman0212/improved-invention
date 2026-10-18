<template>
  <div class="mb-6 font-mono">
    <p class="text-xs text-comment">// {{ desc }}</p>
    <h1 class="glow mt-1 text-3xl font-bold text-keyword">
      async function <span class="text-primary">{{ fn }}</span><span class="text-muted-foreground">()</span>
    </h1>
    <span class="mt-2 inline-block rounded bg-terminal px-2 py-0.5 text-xs text-primary border border-border">
      POST {{ endpoint }}
    </span>
  </div>
</template>

<script setup>
defineProps({
  fn: String,
  endpoint: String,
  desc: String,
});
</script>