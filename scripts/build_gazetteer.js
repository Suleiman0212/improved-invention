#!/usr/bin/env node
// Сборка уличного справочника из данных OpenStreetMap в компактный JSON-индекс.
//
//   node scripts/build_gazetteer.js
//
// Вход:  data/osm/<город>.json  — собранные scripts/fetch_osm.js (улицы + места)
//        data/manual/*.json     — ручные уточнения (необязательно)
// Выход: data/gazetteer.json    — { meta, streets, living }
//
// Назначение: восстановление city / province / district / street_type по
// названию улицы, микрорайона или жилого массива, когда в строке адреса
// административные поля не указаны.
//
// Источник: OpenStreetMap contributors, ODbL (https://osm.org/copyright).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKey, stemKey, CITY_MAP } from '../src/lexicon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OSM_DIR = path.join(ROOT, 'data', 'osm');
const MANUAL_DIR = path.join(ROOT, 'data', 'manual');
const KATO_FILE = path.join(ROOT, 'data', 'kato', 'reference.json');
const OUT_FILE = path.join(ROOT, 'data', 'gazetteer.json');

// Справочник КАТО — источник канонических названий районов.
const KATO = fs.existsSync(KATO_FILE)
  ? JSON.parse(fs.readFileSync(KATO_FILE, 'utf8'))
  : { districts: {} };
const KATO_DISTRICTS = KATO.districts ?? {};

// «Ауэзовский район» -> «Ауэзовский», «район Есиль» -> «Есиль».
function stripDistrictMarker(s) {
  return String(s)
    .replace(/^\s*(городской\s+)?район\s+/i, '')
    .replace(/\s+(городской\s+)?район\s*$/i, '')
    .replace(/\s+ауданы\s*$/i, '')
    .replace(/\s+аудан\s*$/i, '')
    .trim();
}

// Канонизация названия района по КАТО (с фильтром по области/городу).
// OSM пишет «Ауэзовский район», «район Есиль», в КАТО — «Ауэзовский»,
// «Есиль»; приводим к написанию КАТО, иначе возвращаем имя без маркера.
function canonDistrict(raw, province) {
  if (!raw) return null;
  const cleaned = stripDistrictMarker(raw);
  const keys = [normalizeKey(raw), normalizeKey(cleaned), stemKey(cleaned)];
  for (const key of keys) {
    const arr = KATO_DISTRICTS[key];
    if (!arr) continue;
    const hit = province
      ? arr.find((h) => h.p === province)
      : arr.length === 1 ? arr[0] : null;
    if (hit) return hit.n;
  }
  return cleaned || raw;
}

// Типы улиц: канон -> варианты написания (RU/KZ).
const STREET_TYPES = [
  ['проспект', ['проспект', 'просп', 'пр-т', 'пр.', 'пр', 'даңғыл', 'даңғылы', 'дангыл']],
  ['микрорайон', ['микрорайон', 'мікроаудан', 'мкр-н', 'мкрн', 'мкр', 'шағын аудан', 'шағын']],
  ['квартал', ['квартал', 'кв-л', 'кварт', 'тоқсан', 'тоқсаны']],
  ['переулок', ['переулок', 'пер-к', 'пер.', 'пер', 'тұйық', 'туйык']],
  ['проезд', ['проезд', 'пр-д']],
  ['шоссе', ['шоссе']],
  ['бульвар', ['бульвар', 'б-р', 'бул.']],
  ['площадь', ['площадь', 'пл.', 'алаң']],
  ['тупик', ['тупик', 'туп.']],
  ['аллея', ['аллея', 'алл.']],
  ['набережная', ['набережная', 'наб.']],
  ['тракт', ['тракт']],
  ['разъезд', ['разъезд', 'рзд.']],
  ['станция', ['станция']],
  ['улица', ['улица', 'ул.', 'ул', 'көше', 'көшесі', 'коше', 'көш.']],
];

const TYPE_BY_VARIANT = new Map();
for (const [canon, variants] of STREET_TYPES) {
  for (const v of variants) TYPE_BY_VARIANT.set(normalizeKey(v), canon);
}

// Разбор «проспект Абая» / «Абай даңғылы» -> { type, base }.
function splitType(name) {
  const n = String(name).replace(/\s+/g, ' ').trim();
  const toks = n.split(' ');
  if (toks.length >= 2) {
    const first = TYPE_BY_VARIANT.get(normalizeKey(toks[0].replace(/\.$/, '')));
    if (first) return { type: first, base: toks.slice(1).join(' ').trim() };
    const lastT = TYPE_BY_VARIANT.get(normalizeKey(toks[toks.length - 1].replace(/\.$/, '')));
    if (lastT) return { type: lastT, base: toks.slice(0, -1).join(' ').trim() };
  }
  return { type: null, base: n };
}

// Область для города по словарю (КАТО/справочник известных городов).
function provinceOfCity(city) {
  return CITY_MAP.get(String(city).trim().toLowerCase())?.province ?? null;
}

function bump(map, key, candidate) {
  if (!key) return;
  const list = (map[key] ??= []);
  const found = list.find(
    (c) => c.c === candidate.c && c.n === candidate.n && (c.d ?? '') === (candidate.d ?? ''),
  );
  if (found) {
    found.cnt += candidate.cnt;
    if (!found.t && candidate.t) found.t = candidate.t;
  } else {
    list.push(candidate);
  }
}

function isSaneName(base) {
  if (!base) return false;
  const k = normalizeKey(base);
  if (!k || k.length < 3) return false;
  if (/^\d+$/.test(k)) return false;
  return true;
}

function loadManual() {
  const streets = {};
  const living = {};
  if (!fs.existsSync(MANUAL_DIR)) return { streets, living };
  for (const file of fs.readdirSync(MANUAL_DIR)) {
    if (!file.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(MANUAL_DIR, file), 'utf8'));
    const items = Array.isArray(data) ? data : (data.items ?? []);
    for (const it of items) {
      if (!it?.name) continue;
      const aliases = [it.name, ...(it.aliases ?? [])];
      if (it.kind === 'street') {
        for (const a of aliases) {
          bump(streets, normalizeKey(a), {
            c: it.city ?? null, p: it.province ?? provinceOfCity(it.city), d: it.district ?? null,
            t: it.street_type ?? null, cnt: 1000, n: it.name,
          });
        }
      } else if (it.kind === 'living_area') {
        for (const a of aliases) {
          bump(living, normalizeKey(a), {
            c: it.city ?? null, p: it.province ?? provinceOfCity(it.city), d: it.district ?? null,
            kind: 'manual', cnt: 1000, rank: 0, n: it.name,
          });
        }
      }
    }
  }
  return { streets, living };
}

function main() {
  if (!fs.existsSync(OSM_DIR)) {
    console.error('Нет data/osm — сначала запустите: node scripts/fetch_osm.js');
    process.exit(1);
  }

  const streets = {};
  const living = {};
  const cities = [];

  for (const file of fs.readdirSync(OSM_DIR).sort()) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(OSM_DIR, file), 'utf8'));
    const city = data.city ?? file.replace(/\.json$/, '');
    const province = provinceOfCity(city);
    cities.push(city);

    // Улицы: имя -> base (без типа) + тип.
    for (const st of data.streets ?? []) {
      const variants = [st.name, st.name_ru, st.name_kk].filter(Boolean);
      const seenKeys = new Set();
      for (const variant of variants) {
        const { type, base } = splitType(variant);
        if (!isSaneName(base)) continue;
        const key = normalizeKey(base);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        bump(streets, key, { c: city, p: province, d: canonDistrict(st.district, province), t: type, cnt: 1, n: base });
      }
    }

    // Места: suburb / neighbourhood / quarter / микрорайоны -> жилые массивы.
    for (const pl of data.places ?? []) {
      const variants = [pl.name, pl.name_ru, pl.name_kk].filter(Boolean);
      const seenKeys = new Set();
      for (const variant of variants) {
        const { base } = splitType(variant);
        if (!isSaneName(base)) continue;
        const key = normalizeKey(base);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        bump(living, key, {
          c: city, p: province, d: canonDistrict(pl.district, province), kind: pl.place ?? 'residential', cnt: 1, rank: 1, n: base,
        });
      }
    }
  }

  // Ручные уточнения имеют приоритет (cnt=1000).
  const manual = loadManual();
  for (const [k, list] of Object.entries(manual.streets)) for (const c of list) bump(streets, k, c);
  for (const [k, list] of Object.entries(manual.living)) for (const c of list) bump(living, k, c);

  // Сортировка кандидатов: сначала по количеству сегментов (популярности).
  for (const key of Object.keys(streets)) streets[key].sort((a, b) => b.cnt - a.cnt);
  for (const key of Object.keys(living)) {
    living[key].sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1) || b.cnt - a.cnt);
  }

  // Индекс усечённых ключей — fallback для падежных различий.
  const streetStems = {};
  const livingStems = {};
  for (const [k, list] of Object.entries(streets)) {
    const s = stemKey(k);
    if (s !== k) streetStems[s] = (streetStems[s] ?? []).concat(list);
  }
  for (const [k, list] of Object.entries(living)) {
    const s = stemKey(k);
    if (s !== k) livingStems[s] = (livingStems[s] ?? []).concat(list);
  }

  const out = {
    meta: {
      source: 'OpenStreetMap (Overpass API) + ручные уточнения',
      license: 'ODbL 1.0 (© OpenStreetMap contributors)',
      builtAt: new Date().toISOString(),
      cities,
      streets: Object.keys(streets).length,
      living: Object.keys(living).length,
    },
    streets,
    living,
    streetStems,
    livingStems,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf8');
  const size = fs.statSync(OUT_FILE).size;
  console.log(
    `Готово: ${path.relative(ROOT, OUT_FILE)} (${(size / 1024 / 1024).toFixed(1)} МБ)\n` +
      `  городов: ${cities.length}, улиц (ключей): ${out.meta.streets}, ` +
      `жилых массивов (ключей): ${out.meta.living}\n` +
      `  усечённых ключей: улиц ${Object.keys(streetStems).length}, жилых ${Object.keys(livingStems).length}`,
  );
}

main();
