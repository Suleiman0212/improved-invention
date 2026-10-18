// Справочник улиц / микрорайонов / жилых массивов (OpenStreetMap + ручные данные).
//
// Данные готовятся офлайн скриптами scripts/fetch_osm.js + scripts/build_gazetteer.js
// в data/gazetteer.json. Здесь — только быстрый синхронный поиск в памяти.
//
// Формат gazetteer.json:
//   streets      : { "<key>": [ { n, c, p, d, t, cnt } ] }
//   living       : { "<key>": [ { n, c, p, d, kind, cnt, rank } ] }
//   streetStems  : { "<stem>": [ ... ] }   — fallback по усечённым ключам
//   livingStems  : { "<stem>": [ ... ] }
//
//   n=название, c=город, p=область, d=район, t=тип улицы, cnt=популярность.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKey, stemKey } from './lexicon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(__dirname, '..', 'data', 'gazetteer.json');

let cache = null;
let cachePath = null;

// Ленивая загрузка с кэшем. Если файла нет — работает без уличного обогащения.
export function loadGazetteer(file = DEFAULT_FILE) {
  if (cache && cachePath === file) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    cachePath = file;
  } catch {
    cache = null;
    cachePath = file;
  }
  return cache;
}

export function hasGazetteer() {
  return loadGazetteer() != null;
}

export function gazetteerMeta() {
  return loadGazetteer()?.meta ?? null;
}

// Кандидаты по имени: точный ключ, затем усечённый.
function candidatesFor(gaz, section, stemSection, name) {
  if (!gaz || !name) return [];
  const key = normalizeKey(name);
  if (!key) return [];
  const exact = gaz[section]?.[key];
  if (exact?.length) return exact;
  const stem = stemKey(name);
  if (stem && stem !== key) return gaz[stemSection]?.[stem] ?? [];
  return [];
}

// Выбор кандидата: с приоритетом указанного города; иначе — самый популярный.
// Возвращает { name, city, province, district, type, kind, ambiguous, restorable }.
//
// restorable — можно ли восстанавливать по кандидату город/область (когда их
// нет в строке): только если номинация практически однозначна — весь индекс
// указывает на один город, либо не более двух городов и лидер набирает ≥60%
// сегментов. «Туран» (Астана+Шымкент+...) или «Абая» (вся страна) так не
// подставляются, а «жуалы 19» -> Алматы подставляется.
function pickCandidate(list, city) {
  if (!list?.length) return null;
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const same = city
    ? list.filter((c) => norm(c.c) === norm(city))
    : [];
  if (city && !same.length) return null;
  const pool = city ? same : list;
  const sorted = [...pool].sort(
    (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (b.cnt ?? 0) - (a.cnt ?? 0),
  );
  const best = sorted[0];
  const cities = new Set(pool.map((c) => c.c).filter(Boolean));
  let restorable = true;
  if (!city) {
    const total = pool.reduce((s, c) => s + (c.cnt ?? 0), 0);
    const topShare = total > 0 ? (best.cnt ?? 0) / total : 0;
    restorable = cities.size === 1 || (cities.size <= 2 && topShare >= 0.6);
  }
  return {
    name: best.n ?? null,
    city: best.c ?? null,
    province: best.p ?? null,
    district: best.d ?? null,
    type: best.t ?? null,
    kind: best.kind ?? null,
    ambiguous: cities.size > 1,
    restorable,
  };
}

// Поиск улицы по названию (без типа).
export function findStreet(name, city = null, gaz = loadGazetteer()) {
  return pickCandidate(candidatesFor(gaz, 'streets', 'streetStems', name), city);
}

// Поиск микрорайона / жилого массива по названию.
export function findLivingArea(name, city = null, gaz = loadGazetteer()) {
  return pickCandidate(candidatesFor(gaz, 'living', 'livingStems', name), city);
}

export { normalizeKey, stemKey };
