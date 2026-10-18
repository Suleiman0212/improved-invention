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
                <div class="mb-3 flex flex-wrap items-center gap-3 text-xs">
                    <button @click="download" :class="btnClass">download json</button>

                    <button
                        type="button"
                        @click="view = view === 'table' ? 'json' : 'table'"
                        class="cursor-pointer text-comment transition hover:text-primary"
                    >
                        // {{ view === 'table' ? 'показать как JSON' : 'показать таблицу' }}
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

                <div v-else class="overflow-x-auto">
                    <table class="w-full min-w-max border-collapse text-xs">
                        <thead>
                            <tr class="border-b border-border text-left text-comment">
                                <th class="px-2 py-1.5 font-normal">#</th>
                                <th class="px-2 py-1.5 font-normal">conf</th>
                                <th class="px-2 py-1.5 font-normal">id</th>
                                <th class="px-2 py-1.5 font-normal">raw_address</th>
                                <th
                                    v-for="field in EDITABLE"
                                    :key="field"
                                    class="px-2 py-1.5 font-normal"
                                >
                                    {{ field }}
                                </th>
                            </tr>
                        </thead>

                        <tbody>
                            <tr
                                v-for="(row, i) in visibleRows"
                                :key="i"
                                class="border-b border-border/50 align-top"
                                :class="isLow(row.rec.confidence) ? 'bg-yellow-500/5' : ''"
                            >
                                <td class="px-2 py-1.5 text-comment">{{ rowNumber(row) }}</td>

                                <td class="px-2 py-1.5">
                                    <span
                                        class="rounded-sm px-1.5 py-0.5 font-mono"
                                        :class="isLow(row.rec.confidence)
                                            ? 'bg-yellow-500/15 text-yellow-500'
                                            : 'bg-primary/10 text-primary'"
                                    >
                                        {{ Number(row.rec.confidence ?? 0).toFixed(2) }}
                                    </span>
                                </td>

                                <td class="px-2 py-1.5 font-mono text-muted-foreground">{{ row.rec.id ?? '—' }}</td>

                                <td
                                    class="max-w-xs truncate px-2 py-1.5 font-mono text-foreground/80"
                                    :title="String(row.rec.raw_address ?? '')"
                                >
                                    {{ row.rec.raw_address ?? '—' }}
                                </td>

                                <td v-for="field in EDITABLE" :key="field" class="px-1 py-1">
                                    <input
                                        v-model="row.rec[field]"
                                        :class="[cellClass, isDirty(row, field) ? 'border-primary/70' : '']"
                                        :title="isDirty(row, field) ? 'изменено вручную' : field"
                                    />
                                </td>
                            </tr>
                        </tbody>
                    </table>
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
    'w-28 rounded border border-border bg-background px-1.5 py-1 text-xs font-mono text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring';

const rows = ref([]);
const view = ref('table');
const onlyLow = ref(false);

const isSingle = computed(() => props.data !== null && !Array.isArray(props.data));

const cloneRecords = () => {
    const list = isSingle.value ? [props.data] : (Array.isArray(props.data) ? props.data : []);
    const clean = list.map((rec) => {
        const out = { ...rec };
        // пустую строку экспортируем обратно в null, как отвечает API
        for (const field of ['province', 'city', 'district', 'living_area', 'street_type',
            'street_name', 'house', 'apartment', 'entrance', 'floor', 'landmark']) {
            if (out[field] == null) out[field] = '';
        }
        return out;
    });

    return clean.map((rec) => ({ rec, orig: JSON.parse(JSON.stringify(rec)) }));
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
    rows.value.reduce((n, row) => n + EDITABLE.filter((f) => isDirty(row, f)).length, 0)
);

const rowNumberMap = computed(() => {
    const map = new WeakMap();
    rows.value.forEach((row, i) => map.set(row, i + 1));
    return map;
});

const rowNumber = (row) => rowNumberMap.value.get(row);

const reset = () => {
    rows.value = rows.value.map((row) => ({ rec: JSON.parse(JSON.stringify(row.orig)), orig: row.orig }));
};

const toExport = (rec) => {
    const out = { ...rec };
    for (const field of EDITABLE) {
        if (out[field] === '') out[field] = null;
    }
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
