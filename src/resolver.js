// Шаг восстановления отсутствующих полей по справочнику КАТО.
//
// Принцип: парсер (src/parser.js) отвечает только за извлечение того, что явно
// написано в строке. Если после разбора какие-то административные поля остались
// пустыми (city / province / district) — этот модуль пытается добрать их:
//
//   1) прямо по тексту адреса, отыскивая в нём названия населённых пунктов и
//      районов из КАТО (нужно, когда парсер не распознал город в строке);
//   2) по справочной иерархии: город -> область/район/код, район -> область/код;
//   3) по уличному справочнику OpenStreetMap (data/gazetteer.json): если в строке
//      есть название улицы или микрорайона, но город не распознан — город/область
//      восстанавливаются по ней (напр. «жуалы 19» -> Алматы, «Пришахтинск» -> Караганда).
//
// Уже заполненные поля никогда не перетираются. Модуль не импортируется парсером,
// поэтому парсер остаётся самостоятельным и не знает о справочнике.

import { loadReference, resolveAdmin, lookupPlace } from './reference.js';
import { normalizeKey, REPUBLICAN_CITIES, STOP_TOKENS } from './lexicon.js';
import { loadGazetteer, findStreet, findLivingArea } from './gazetteer.js';

const RECOVERY_STOP_WORDS = new Set([...STOP_TOKENS].map((word) => normalizeKey(word)));

// Нормализованные слова строки (как ключи в КАТО).
function keyWords(text) {
  return normalizeKey(text || '').split(' ').filter(Boolean);
}

// Слова, которые уже «заняты» другими полями, — их нельзя считать названием города.
function occupiedWords(fields) {
  const s = new Set();
  for (const v of [fields.street_name, fields.living_area, fields.landmark, fields.district]) {
    for (const w of keyWords(v)) s.add(w);
  }
  return s;
}

// Все n-граммы (1..4 слов) строки.
function ngrams(raw, maxWords = 4) {
  const w = keyWords(raw);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    for (let n = 1; n <= maxWords && i + n <= w.length; n++) {
      out.push(w.slice(i, i + n));
    }
  }
  return out;
}

function isUsableGram(gram) {
  // Числа (номера домов/квартир) и слишком короткие токены не считаем названиями.
  if (gram.every((w) => /^\d+$/.test(w))) return false;
  return gram.join(' ').length >= 3;
}

// Слова-маркеры административной единицы. «Туркестан облысы» — это область, а не
// город Туркестан; «Сарыагаш ауданы» — район. Такие названия не должны
// подставляться как город.
const AREA_MARKERS = new Set(['облысы', 'облыс', 'область', 'ауданы', 'аудан', 'район']);

// Ключи (1–2 слова), за которыми в строке следует маркер области/района.
function regionMarkedKeys(raw) {
  const words = keyWords(raw);
  const s = new Set();
  for (let i = 1; i < words.length; i++) {
    if (!AREA_MARKERS.has(words[i])) continue;
    for (let k = 1; k <= 2 && i - k >= 0; k++) s.add(words.slice(i - k, i).join(' '));
  }
  return s;
}

// Поиск названия населённого пункта, упомянутого в исходной строке.
function recoverCity(raw, fields, ref) {
  const skip = occupiedWords(fields);
  for (const w of regionMarkedKeys(raw)) skip.add(w);
  const keys = new Set();
  for (const gram of ngrams(raw)) {
    if (!isUsableGram(gram)) continue;
    if (gram.some((w) => skip.has(w) || RECOVERY_STOP_WORDS.has(w))) continue;
    const key = gram.join(' ');
    if (ref.places[key]) keys.add(key);
  }
  if (!keys.size) return null;

  const resolved = [];
  for (const key of [...keys].sort((a, b) => b.length - a.length)) {
    const r = lookupPlace(key, ref);
    if (r?.resolved?.province) resolved.push({ key, r });
  }
  if (!resolved.length) return null;

  // Берём только когда все кандидаты указывают на один регион (иначе риск ошибки).
  const provinces = new Set(resolved.map((x) => x.r.resolved.province));
  if (provinces.size !== 1) return null;

  const best = resolved[0];
  const cand =
    best.r.candidates.find((c) => c.p === best.r.resolved.province) ?? best.r.candidates[0];
  return { city: cand.n || null, admin: best.r.resolved };
}

// Поиск названия района, упомянутого в строке.
function recoverDistrict(raw, fields, ref) {
  const skip = occupiedWords(fields);
  const keys = new Set();
  for (const gram of ngrams(raw)) {
    if (!isUsableGram(gram)) continue;
    if (gram.every((w) => skip.has(w))) continue;
    const key = gram.join(' ');
    if (ref.districts[key]) keys.add(key);
  }
  if (!keys.size) return null;

  const resolved = [];
  for (const key of [...keys].sort((a, b) => b.length - a.length)) {
    const cands = ref.districts[key] ?? [];
    const provinces = [...new Set(cands.map((c) => c.p))];
    if (provinces.length === 1) {
      resolved.push({ key, province: provinces[0], name: cands[0].n || key });
    }
  }
  if (!resolved.length) return null;
  const provinces = new Set(resolved.map((x) => x.province));
  if (provinces.size !== 1) return null;
  return resolved[0];
}

// Поиск улицы / микрорайона в уличном справочнике (OpenStreetMap), когда
// административные поля не распознаны. Дозаполняет город/область/район/тип.
function applyGazetteer(raw, out) {
  const gaz = loadGazetteer();
  if (!gaz || !gaz.streets) return;

  // Не подставляем данные OSM, если они противоречат уже известной области:
  // «Сарыагаш ауданы, ул. Абая 1» -> область Туркестанская, и улика «Абая»
  // из Алматы не должна превратить город в Алматы.
  const conflicts = (hit) => Boolean(out.province && hit.province && out.province !== hit.province);

  const fillAdmin = (hit) => {
    const bad = conflicts(hit);
    if (!out.city && hit.city && !bad) out.city = hit.city;
    if (!out.province && hit.province) out.province = hit.province;
    if (!out.district && hit.district && !bad) out.district = hit.district;
  };

  // 1) Улица, которую уже вытащил парсер, -> город/область.
  //    Только при однозначности (hit.restorable): «Туран 55/6» не должен
  //    превращаться в город Астана, а «Назарбаева8» — в Алматы.
  if (!out.city && out.street_name) {
    const hit = findStreet(out.street_name, null, gaz);
    if (hit?.city && hit.restorable) fillAdmin(hit);
  }

  // 2) Микрорайон / ЖК (парсер кладёт мкр в street_name со street_type=микрорайон).
  if (!out.city) {
    const asLiving =
      out.living_area ||
      (/^(микрорайон|мкр|квартал|жк|жилой|мкр\.)$/i.test(out.street_type || '')
        ? out.street_name
        : null);
    const hit = asLiving && findLivingArea(asLiving, null, gaz);
    if (hit?.city && hit.restorable) {
      fillAdmin(hit);
    }
    if (hit?.name && !out.living_area && asLiving && hit.restorable) {
      out.living_area = hit.name;
    }
  }

  // 3) Жилмассив прямо в сырой строке (например «Пришахтинск», потерянный парсером).
  //    Берём только однозначные совпадения (все кандидаты — один город).
  if (!out.city) {
    const skip = occupiedWords(out);
    for (const w of regionMarkedKeys(raw)) skip.add(w);
    for (const gram of ngrams(raw)) {
      if (!isUsableGram(gram)) continue;
      if (gram.every((w) => skip.has(w))) continue;
      const key = gram.join(' ');
      const list = gaz.living?.[key];
      if (!list?.length) continue;
      const cities = new Set(list.map((c) => c.c).filter(Boolean));
      if (cities.size !== 1) continue;
      const hit = findLivingArea(key, null, gaz);
      if (!hit?.city) continue;
      fillAdmin(hit);
      if (!out.living_area && hit.name) out.living_area = hit.name;
      break;
    }
  }

  // 4) Город известен, а района нет — восстанавливаем район по улице или
  //    микрорайону (только кандидат того же города): «Аксай За» -> Ауэзовский.
  if (!out.city || out.district) return;
  const micro = /^(микрорайон|мкр|квартал|жк|жилой|мкр\.)$/i.test(out.street_type || '');
  let hit = out.living_area ? findLivingArea(out.living_area, out.city, gaz) : null;
  if (!hit && out.street_name) {
    hit = micro
      ? findLivingArea(out.street_name, out.city, gaz)
      : findStreet(out.street_name, out.city, gaz);
  }
  const sameCity = hit?.city && hit.city.trim().toLowerCase() === out.city.trim().toLowerCase();
  if (hit?.district && sameCity) out.district = hit.district;
}

// Главная функция: принимает исходную строку и результат парсера,
// возвращает копию с дозаполненными province / city / district.
export function resolveMissing(raw, fields = {}, ref = loadReference()) {
  const out = { ...fields };
  if (!ref || !ref.places) return out;

  // 1) Город не распознан парсером — ищем название населённого пункта в строке.
  if (!out.city) {
    const rec = recoverCity(raw, out, ref);
    if (rec?.city) {
      out.city = rec.city;
      if (!out.province && rec.admin.province) out.province = rec.admin.province;
      if (!out.district && rec.admin.district) out.district = rec.admin.district;
    }
  }

  // 2) Район не распознан — ищем название района в строке.
  if (!out.district) {
    const rec = recoverDistrict(raw, out, ref);
    if (rec) {
      out.district = rec.name;
      if (!out.province) out.province = rec.province;
    }
  }

  // 3) Достраиваем иерархию по справочнику: город/район -> область.
  const admin = resolveAdmin(out, ref);
  if (!out.province && admin.province) out.province = admin.province;
  if (!out.district && admin.district) out.district = admin.district;

  // 4) Район города республиканского значения -> сам город (Турксибский -> Алматы).
  if (!out.city && out.district && out.province && REPUBLICAN_CITIES.has(out.province)) {
    out.city = out.province;
  }

  // 5) Уличный справочник OSM: город/область по названию улицы или микрорайона.
  applyGazetteer(raw, out);

  // 6) Добор иерархии по только что подставленному городу (область).
  const admin2 = resolveAdmin(out, ref);
  if (!out.province && admin2.province) out.province = admin2.province;
  if (!out.district && admin2.district) out.district = admin2.district;

  return out;
}
