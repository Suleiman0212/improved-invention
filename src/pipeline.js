// Общий конвейер обработки записей: используется CLI и REST API,
// чтобы формат ответа совпадал в обоих интерфейсах.

import { parseAddress } from './enrich.js';

// Извлекает исходную строку из записи любого поддерживаемого формата.
export function getRaw(rec) {
  if (typeof rec === 'string') return rec;
  return rec?.raw_address ?? rec?.address ?? rec?.raw ?? rec?.address_str ?? '';
}

// Одна запись → результат по спецификации ТЗ.
export function parseRecord(rec, options) {
  const raw = getRaw(rec);
  const parsed = parseAddress(raw, options);
  return {
    id: (rec && typeof rec === 'object' && rec.id != null) ? rec.id : null,
    raw_address: raw,
    ...parsed,
  };
}

export function parseRecords(records, options) {
  return records.map((rec) => parseRecord(rec, options));
}
