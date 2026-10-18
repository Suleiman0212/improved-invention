<template>
    <div class="mx-auto max-w-3xl px-4 py-12">
        <PageHeader fn="parseAddress" endpoint="/parse" desc="Разбор одного адреса" />

        <Panel title="input: raw_address">
            <form @submit.prevent="run" class="flex flex-col gap-3 sm:flex-row">
                <input v-model="raw" type="text" placeholder="город Алматы, Мкр Аксай 3а, 59, кв 70" :class="fieldClass" />

                <button :disabled="loading" :class="btnClass" class="w-full sm:w-auto">send</button>
            </form>

            <div class="mt-4 flex flex-wrap gap-2 text-xs">
                <button
                    v-for="x in examples"
                    :key="x"
                    type="button"
                    @click="raw = x"
                    class="cursor-pointer rounded-sm border border-border px-2 py-1 text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                    "{{ x }}"
                </button>
            </div>
        </Panel>

        <Output :data="data" :error="error" :loading="loading" />
    </div>
</template>

<script setup>
import { ref } from 'vue';

import { parseAddress } from '@/axios/axios';

import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import Output from '@/components/Output.vue';

import { fieldClass, btnClass } from '@/components/TerminalComponents.vue';

const examples = [
    'Астана, Есильский район, ЖК Томирис, ул. Кабанбай батыра 15, подъезд 2, этаж 7, кв 44',
    'город Алматы, Медеуский район, ул. Кунаева 55, 4 подъезд, 9 этаж, кв 12',
    'Туран 55/6 магазин береке 4подъезд 9этаж',
];

const raw = ref('');
const data = ref(null);
const error = ref(null);
const loading = ref(false);

const run = async () => {
    if (!raw.value.trim()) return;

    loading.value = true;
    error.value = null;

    try {
        data.value = await parseAddress(raw.value);
    }
    catch (e) {
        error.value = e.message;
        data.value = null;
    }
    finally {
        loading.value = false;
    }
};
</script>
