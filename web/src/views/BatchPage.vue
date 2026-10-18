<template>
    <div class="mx-auto max-w-3xl px-4 py-12">
        <PageHeader fn="batchAddress" endpoint="/parse/batch" desc="Пакетная обработка JSON-массива" />

        <Panel title="input: [raw_address]">
            <textarea v-model="text" rows="10" :placeholder="sample" :class="fieldClass"></textarea>

            <div class="mt-3 flex items-center gap-3">
                <button @click="run" :disabled="loading" :class="btnClass">send</button>

                <button
                    type="button"
                    @click="text = sample"
                    class="cursor-pointer text-xs text-comment transition hover:text-primary"
                >
                    // вставить пример
                </button>
            </div>
        </Panel>

        <Output :data="data" :error="error" :loading="loading" />
    </div>
</template>

<script setup>
import { ref } from 'vue';

import { batchAddress } from '@/axios/axios';

import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import Output from '@/components/Output.vue';

import { fieldClass, btnClass } from '@/components/TerminalComponents.vue';

const sample = JSON.stringify(
    [
        { id: 'rec_00417', raw_address: 'город Алматы/Алматы қаласы, Мкр Аксай За, 59, кв 70' },
        { id: 'rec_00418', raw_address: '66квартал 12дом 69квартира' },
    ],
    null,
    2
);

const text = ref('');
const data = ref(null);
const error = ref(null);
const loading = ref(false);

const run = async () => {
    if (!text.value.trim()) return;

    let parsed;

    try {
        parsed = JSON.parse(text.value);
    }
    catch {
        error.value = 'Введённый текст не является валидным JSON';
        data.value = null;
        return;
    }

    loading.value = true;
    error.value = null;

    try {
        data.value = await batchAddress(parsed);
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
