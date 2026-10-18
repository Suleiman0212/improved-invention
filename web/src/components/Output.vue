<template>
    <div v-if="loading || error || data" class="mt-6">
        <Panel :title="isSingle ? 'output: record' : 'output: records'">
            <div v-if="loading" class="text-sm text-comment">
                Loading...
            </div>

            <div v-else-if="error" class="text-sm font-bold text-destructive">
                Error: {{ error }}
            </div>

            <template v-else-if="data">
                <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 p-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="rounded bg-secondary px-2.5 py-1 text-xs text-secondary-foreground">
                            {{ rows.length }} {{ isSingle ? 'запись' : 'записей' }}
                        </span>
                        <span
                            v-if="lowCount"
                            class="rounded bg-yellow-500/10 px-2.5 py-1 text-xs text-yellow-400"
                        >
                            {{ lowCount }} с низкой уверенностью
                        </span>
                        <label
                            v-if="view === 'table'"
                            class="flex cursor-pointer items-center gap-2 rounded border border-border/70 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-yellow-500/40 hover:text-foreground"
                        >
                            <input
                                type="checkbox"
                                v-model="onlyLow"
                                class="h-3.5 w-3.5 accent-yellow-500"
                            />
                            Только низкий confidence (&lt; {{ LOW_CONF }})
                        </label>
                    </div>

                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            @click="view = view === 'table' ? 'json' : 'table'"
                            class="cursor-pointer rounded border border-border px-3 py-2 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                        >
                            {{ view === 'table' ? 'Показать JSON' : 'Показать записи' }}
                        </button>
                        <button @click="download" :class="btnClass">Скачать JSON</button>

                        <button
                            v-if="view === 'table' && editedCount"
                            type="button"
                            @click="reset"
                            class="cursor-pointer rounded border border-destructive/30 px-3 py-2 text-xs text-destructive transition hover:border-destructive hover:bg-destructive/10"
                        >
                            Сбросить изменения ({{ editedCount }})
                        </button>
                    </div>
                </div>

                <pre v-if="view === 'json'" class="overflow-x-auto text-xs font-mono"><code v-html="highlightedJson"></code></pre>

                <div
                    v-else-if="onlyLow && visibleRows.length === 0"
                    class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
                >
                    Записей с низкой уверенностью не найдено.
                </div>

                <div v-else class="flex flex-col gap-3">
                    <div
                        v-for="row in visibleRows"
                        :key="row.uid"
                        class="rounded-md border p-4 transition"
                        :class="isLow(row.rec.confidence)
                            ? 'border-yellow-500/40 bg-yellow-500/[0.04]'
                            : 'border-border/70 bg-card/70 hover:border-primary/30'"
                    >
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="rounded bg-secondary px-2 py-1 text-xs font-bold text-secondary-foreground">
                                    Запись #{{ row.uid + 1 }}
                                </span>
                                <span class="text-xs text-muted-foreground">
                                    ID <span class="font-mono text-foreground">{{ row.rec.id ?? '—' }}</span>
                                </span>
                                <span
                                    v-if="isLow(row.rec.confidence)"
                                    class="rounded bg-yellow-500/10 px-2 py-1 text-xs text-yellow-400"
                                >
                                    Низкая уверенность
                                </span>
                            </div>

                            <label class="flex items-center gap-2 rounded border border-border/70 px-2.5 py-1.5 text-xs">
                                <span class="text-muted-foreground">Уверенность</span>
                                <input
                                    v-model="row.rec.confidence"
                                    :class="[cellClass, confClass, isDirty(row, 'confidence') ? 'border-primary/70' : '']"
                                    title="Уверенность — можно изменить"
                                />
                            </label>
                        </div>

                        <div class="mt-3 rounded bg-background/60 px-3 py-2.5">
                            <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Исходный адрес</div>
                            <div
                                class="break-words text-sm text-foreground"
                                :title="String(row.rec.raw_address ?? '')"
                            >
                                {{ row.rec.raw_address ?? '—' }}
                            </div>
                        </div>

                        <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                            <label
                                v-for="field in EDITABLE"
                                :key="field"
                                class="flex min-w-0 flex-col gap-1"
                            >
                                <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ field.replaceAll('_', ' ') }}</span>

                                <input
                                    v-model="row.rec[field]"
                                    :class="[cellClass, isDirty(row, field) ? 'border-primary/70' : '']"
                                    :title="isDirty(row, field) ? 'изменено вручную' : field"
                                    :placeholder="field"
                                />
                            </label>
                        </div>
                    </div>
                </div>
            </template>
        </Panel>
    </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';

import Panel from './Panel.vue';
import { btnClass } from './TerminalComponents.vue';

const props = defineProps({
    data: [Object, Array, String, Number, Boolean],
    error: String,
    loading: Boolean,
});

const LOW_CONF = 0.7;

// поля, которые можно править руками (порядок как в ответе API)
const EDITABLE = [
    'province', 'city', 'district', 'living_area', 'street_type',
    'street_name', 'house', 'apartment', 'entrance', 'floor', 'landmark',
];

const cellClass =
    'w-full min-w-0 rounded border border-border bg-background px-2.5 py-2 text-xs font-mono text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-ring';

const confClass = 'w-16 text-center';

const rows = ref([]);
const view = ref('table');
const onlyLow = ref(false);

const isSingle = computed(() => props.data !== null && !Array.isArray(props.data));

const cloneRecords = () => {
    const list = isSingle.value ? [props.data] : (Array.isArray(props.data) ? props.data : []);
    // пустую строку экспортируем обратно в null, как отвечает API
    const toEditable = (rec) => {
        const out = { ...rec };
        for (const field of EDITABLE) {
            if (out[field] == null) out[field] = '';
        }
        return out;
    };

    return list.map((rec, i) => {
        const editable = toEditable(rec);
        return { uid: i, rec: editable, orig: JSON.parse(JSON.stringify(editable)) };
    });
};

watch(() => props.data, () => {
    rows.value = cloneRecords();
    onlyLow.value = false;
}, { immediate: true, deep: true });

const isLow = (conf) => Number(conf ?? 0) < LOW_CONF;

const lowCount = computed(() => rows.value.filter((r) => isLow(r.rec.confidence)).length);

const visibleRows = computed(() =>
    onlyLow.value ? rows.value.filter((r) => isLow(r.rec.confidence)) : rows.value
);

const isDirty = (row, field) => row.rec[field] !== row.orig[field];

const editedCount = computed(() =>
    rows.value.reduce((n, row) => n + EDITABLE.filter((f) => isDirty(row, f)).length
        + (isDirty(row, 'confidence') ? 1 : 0), 0)
);

const reset = () => {
    rows.value = rows.value.map((row) => ({ uid: row.uid, rec: JSON.parse(JSON.stringify(row.orig)), orig: row.orig }));
};

const toExport = (rec) => {
    const out = { ...rec };
    for (const field of EDITABLE) {
        if (out[field] === '') out[field] = null;
    }

    const conf = Number(out.confidence);
    out.confidence = Number.isFinite(conf) ? conf : 0;

    return out;
};

const download = () => {
    const payload = isSingle.value
        ? toExport(rows.value[0]?.rec ?? {})
        : rows.value.map((row) => toExport(row.rec));

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = isSingle.value ? 'jana-address-record.json' : 'jana-address-records.json';
    a.click();

    URL.revokeObjectURL(url);
};

const highlightedJson = computed(() => {
    const exportData = isSingle.value
        ? toExport(rows.value[0]?.rec ?? {})
        : rows.value.map((row) => toExport(row.rec));

    const json = JSON.stringify(exportData, null, 2);

    const escaped = json.replace(/[&<>]/g, (char) => {
        const entities = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
        };

        return entities[char];
    });

    return escaped.replace(
        /("(?:\\.|[^"\\])*")(\s*:)?|(\bnull\b|\btrue\b|\bfalse\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],:])/g,
        (match, string, colon, boolean, number, punctuation) => {
            let color = 'text-primary';

            if (string) {
                // ключ объекта - строка, после которой идёт двоеточие
                if (colon) {
                    return `<span class="text-keyword">${string}</span>${colon}`;
                }

                // обычное строковое значение
                return `<span class="text-primary">${string}</span>`;
            }

            if (boolean) {
                color = 'text-purple-400';
            }
            else if (number) {
                color = 'text-orange-400';
            }
            else if (punctuation) {
                color = 'text-comment';
            }

            return `<span class="${color}">${match}</span>`;
        }
    );
});

</script>
