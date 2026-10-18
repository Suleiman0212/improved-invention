// Справочник КАТО: восстановление области/района и кода КАТО по городу,
// населённому пункту или названию района.
//
// Данные готовятся офлайн скриптом scripts/build_kato.js в data/kato/reference.json.
// Здесь — только быстрый синхронный поиск в памяти (сеть не используется).
//
// Формат reference.json:
//   provinceByPrefix : { "10": "Абайская область", ... }
//   provinceNames    : { "<key>": "<каноническая область>" }
//   places           : { "<key>": [ { p, d, k, t, n, dk } ] }  p=область, d=район,
//                                                              k=код КАТО, t=тип
//   districts        : { "<key>": [ { p, k, t, n } ] }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITY_MAP, normalizeKey } from './lexicon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(__dirname, '..', 'data', 'kato', 'reference.json');

let cache = null;
let cachePath = null;

// Загрузка справочника (ленивая, с кэшем). Если файла нет — возвращает null,
// и разбор продолжает работать без обогащения.
export function loadReference(file = DEFAULT_FILE) {
  if (cache && cachePath === file) return cache;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    cache = JSON.parse(raw);
    cachePath = file;
  } catch {
    cache = null;
    cachePath = file;
  }
  return cache;
}

export function hasReference() {
  return loadReference() != null;
}

export function referenceMeta() {
  return loadReference()?.meta ?? null;
}

// Среди нескольких кандидатов выбираем значение только если оно однозначно.
function pick(list) {
  if (!list || !list.length) return null;
  const provinces = [...new Set(list.map((e) => e.p))];
  const districts = [...new Set(list.map((e) => e.d ?? null))];
  const province = provinces.length === 1 ? provinces[0] : null;
  const district = province && districts.length === 1 ? districts[0] : null;
  const kato = province && districts.length === 1 ? list[0].k : null;
  return { province, district, kato };
}

// Подбирает кандидатов города с учётом известной из словаря области
// (снимает неоднозначность одноимённых сёл в разных регионах).
function cityCandidates(city, ref) {
  let cands = ref.places[normalizeKey(city)];
  if (!cands || !cands.length) return null;
  const known = CITY_MAP.get(String(city).trim().toLowerCase())?.province;
  if (known && cands.length > 1) {
    const filtered = cands.filter((c) => c.p === known);
    if (filtered.length) cands = filtered;
  }
  return cands;
}

// Основная функция обогащения. Принимает уже разобранные поля, возвращает
// дополненные province/district/kato (существующие значения не перетираются).
export function resolveAdmin(fields = {}, ref = loadReference()) {
  const out = {
    province: fields.province ?? null,
    district: fields.district ?? null,
    kato: fields.kato ?? null,
  };
  if (!ref || !ref.places) return out;

  const districtFromInput = fields.district != null && fields.district !== '';
  let cityKato = null;

  // 1) Город/населённый пункт → область + район + КАТО.
  if (fields.city) {
    const cands = cityCandidates(fields.city, ref);
    if (cands) {
      const p = pick(cands);
      if (p) {
        if (!out.province && p.province) out.province = p.province;
        if (!out.district && p.district) out.district = p.district;
        cityKato = p.kato;
      }
    }
  }

  // 2) Район → область (если область неизвестна и район однозначен).
  if (!out.province && out.district) {
    const cands = ref.districts[normalizeKey(out.district)];
    if (cands) {
      const provinces = [...new Set(cands.map((e) => e.p))];
      if (provinces.length === 1) out.province = provinces[0];
    }
  }

  // 3) Код КАТО: если район задан в строке — код района (точнее по адресу),
  //    иначе код самого населённого пункта.
  if (districtFromInput && out.district) {
    const cands = (ref.districts[normalizeKey(out.district)] ?? []).filter(
      (c) => !out.province || c.p === out.province,
    );
    if (cands.length === 1) out.kato = cands[0].k;
  }
  if (!out.kato && cityKato) out.kato = cityKato;

  // 4) Канонизация области (например, «Абай» → «Абайская область»).
  if (out.province) {
    const canonical = ref.provinceNames[normalizeKey(out.province)];
    if (canonical) out.province = canonical;
  }

  return out;
}

// Публичные примитивы для UI/API: что известно о названии.
export function lookupPlace(name, ref = loadReference()) {
  if (!ref || !ref.places || !name) return null;
  const cands = cityCandidates(name, ref);
  if (!cands) return null;
  return {
    candidates: cands,
    resolved: pick(cands),
    ambiguous: new Set(cands.map((c) => c.p)).size > 1,
  };
}

export function lookupDistrict(name, ref = loadReference()) {
  if (!ref || !ref.districts || !name) return null;
  const cands = ref.districts[normalizeKey(name)];
  if (!cands) return null;
  return {
    candidates: cands,
    province: new Set(cands.map((c) => c.p)).size === 1 ? cands[0].p : null,
  };
}

export { normalizeKey };
