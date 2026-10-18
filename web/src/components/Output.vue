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
                <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                    <button @click="download" :class="btnClass">download json</button>

                    <button
                        type="button"
                        @click="view = view === 'table' ? 'json' : 'table'"
                        class="cursor-pointer text-comment transition hover:text-primary"
                    >
                        // {{ view === 'table' ? 'показать как JSON' : 'показать записи' }}
                    </button>

                    <template v-if="view === 'table'">
                        <label class="flex cursor-pointer items-center gap-1.5 text-comment">
                            <input
                                type="checkbox"
                                v-model="onlyLow"
                                class="h-3.5 w-3.5 accent-yellow-500"
                            />
                            только низкий confidence (&lt; {{ LOW_CONF }})
                        </label>

                        <span class="text-comment">
                            записей: {{ rows.length }}<template v-if="lowCount">, с низким confidence: {{ lowCount }}</template>
                        </span>

                        <button
                            v-if="editedCount"
                            type="button"
                            @click="reset"
                            class="cursor-pointer text-comment transition hover:text-destructive"
                        >
                            // отменить правки ({{ editedCount }})
                        </button>
                    </template>
                </div>

                <pre v-if="view === 'json'" class="overflow-x-auto text-xs font-mono"><code v-html="highlightedJson"></code></pre>

                <div v-else class="flex flex-col gap-2">
                    <div
                        v-for="row in visibleRows"
                        :key="row.uid"
                        class="rounded border p-2.5 transition"
                        :class="isLow(row.rec.confidence)
                            ? 'border-yellow-500/30 bg-yellow-500/5'
                            : 'border-border/50'"
                    >
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span class="text-comment">#{{ row.uid + 1 }}</span>

                            <label class="flex items-center gap-1.5">
                                <span class="text-comment">conf</span>
                                <input
                                    v-model="row.rec.confidence"
                                    :class="[cellClass, confClass, isDirty(row, 'confidence') ? 'border-primary/70' : '']"
                                    title="confidence — можно править"
                                />
                            </label>

                            <span class="text-muted-foreground">id: {{ row.rec.id ?? '—' }}</span>

                            <span
                                class="min-w-0 flex-1 truncate font-mono text-foreground/80"
                                :title="String(row.rec.raw_address ?? '')"
                            >
                                {{ row.rec.raw_address ?? '—' }}
                            </span>

                            <span
                                v-if="isLow(row.rec.confidence)"
                                class="rounded-sm bg-yellow-500/15 px-1.5 py-0.5 text-yellow-500"
                            >
                                низкий confidence
                            </span>
                        </div>

                        <div class="mt-2 flex flex-wrap gap-1.5">
                            <label
                                v-for="field in EDITABLE"
                                :key="field"
                                class="flex flex-col gap-0.5"
                            >
                                <span class="text-[10px] leading-none text-comment">{{ field }}</span>

                                <input
                                    v-model="row.rec[field]"
                                    :class="[cellClass, isDirty(row, field) ? 'border-primary/70' : '']"
                                    :title="isDirty(row, field) ? 'изменено вручную' : field"
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
    'w-24 rounded border border-border bg-background px-1.5 py-1 text-xs font-mono text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring';

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
