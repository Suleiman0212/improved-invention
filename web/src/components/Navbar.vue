<template>
  <header class="border-b border-border bg-card px-6 py-3 font-mono text-sm sm:px-6">
    <div class="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-6">

        <RouterLink to="/" class="font-bold text-primary hover:underline">~/jana-address$</RouterLink>
          
        <nav class="flex flex-wrap items-center gap-4 text-muted-foreground">

          <RouterLink to="/parse" class="transition hover:text-primary" active-class="text-primary font-bold">
            parseAddress()  
          </RouterLink>

          <RouterLink to="/batch" class="transition hover:text-primary" active-class="text-primary font-bold">
            batchAddress() 
          </RouterLink> 

          <RouterLink to="/file" class="transition hover:text-primary" active-class="text-primary font-bold">
            sendFile() 
          </RouterLink> 

        </nav>
      </div>
    </div>
  </header>
</template>

<script setup>
import { RouterLink } from 'vue-router';
</script>