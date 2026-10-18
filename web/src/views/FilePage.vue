<template>
    <div class="mx-auto max-w-3xl px-4 py-12">
        <PageHeader fn="sendFile" endpoint="/parse/batch" desc="Чтение JSON/JSONL в браузере и пакетная отправка" />

        <Panel title="input: file.json / file.jsonl">
            <div
                @click="triggerFileSelect"
                class="flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-border py-12 text-center transition hover:border-primary"
            >
                <p class="text-sm font-bold text-primary glow">
                    $ select --file *.json / *.jsonl
                </p>

                <p class="mt-2 text-xs text-muted-foreground">
                    {{ selectedFile ? selectedFile.name : 'нажмите, чтобы выбрать файл' }}
                </p>

                <input
                    ref="fileInput"
                    type="file"
                    accept=".json,.jsonl,application/json"
                    class="hidden"
                    @change="onFileChange"
                />
            </div>

            <div class="mt-4">
                <button @click="run" :disabled="loading || !selectedFile" :class="btnClass" class="w-full sm:w-auto">
                    send file
                </button>
            </div>
        </Panel>

        <Output :data="data" :error="error" :loading="loading" />
    </div>
</template>

<script setup>
import { ref } from 'vue';

import { sendFile } from '@/axios/axios';

import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import Output from '@/components/Output.vue';

import { btnClass } from '@/components/TerminalComponents.vue';

const fileInput = ref(null);
const selectedFile = ref(null);

const data = ref(null);
const error = ref(null);
const loading = ref(false);

const triggerFileSelect = () => {
    fileInput.value?.click();
};

const onFileChange = (e) => {
    const file = e.target.files?.[0];

    if (file) {
        selectedFile.value = file;
    }
};

const run = async () => {
    if (!selectedFile.value) return;

    loading.value = true;
    error.value = null;

    try {
        data.value = await sendFile(selectedFile.value);
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
