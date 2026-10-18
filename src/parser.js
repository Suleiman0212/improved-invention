// Ядро разбора: раскладывает произвольную адресную строку на структурированные поля.
// Работает локально, без сети и без справочника КАТО — извлекает только то, что
// явно написано в строке. Дозаполнение недостающих полей по справочнику —
// отдельный модуль src/resolver.js.
//
// Интерфейс: parseFields(rawString) -> объект с полями (значения или null).

import { normalize, resolveBilingual } from './normalize.js';
import {
  LETTER, LWORD, NUM, HOUSE_NUM,
  STREET_DEFS, ADMIN_PARTICLES, STRAY_TOKENS, STOP_TOKENS, isStopToken,
  CITY_ALIASES, CITY_MAP, REPUBLICAN_CITIES, STABLE_CITY_PROVINCE,
  LANDMARK_PREFIXES, canonicalCity, canonicalProvinceStem,
} from './lexicon.js';

const re = (src, flags = 'iu') => new RegExp(src, flags);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Номер квартиры: допускаем литеру, чтобы «кв 12а» не резалось до «1».
const APT_NUM = `\\d{1,4}[а-яА-Яa-z]?`;

// ---------------------------------------------------------------------------
// Регулярные выражения извлечения полей (группа 1 = значение)
// ---------------------------------------------------------------------------

const APARTMENT_PATTERNS = [
  re(`(?<![${LETTER}0-9/])(${APT_NUM})\\s*квартир[а-яё]*(?![${LETTER}0-9])(?!\\s*\\d)`),
  re(`(?<![${LETTER}])квартир[а-яё]*\\.?\\s*(?:№\\s*)?(${APT_NUM})(?![${LETTER}0-9])`),
  re(`(?<![${LETTER}0-9/])(${APT_NUM})\\s*кв(?![${LETTER}])(?!\\s*\\d)`),
  re(`(?<![${LETTER}])кв\\.?\\s*(?:№\\s*)?(${APT_NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(?:flat|apt|apartment|kv)\\.?\\s*(?:№\\s*)?(${APT_NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${APT_NUM})\\s*(?:flat|apt|kv)(?![${LETTER}])(?!\\s*\\d)`),
];

const ENTRANCE_PATTERNS = [
  // Гладкое «4подъезд» — самое надёжное, поэтому идёт первым.
  re(`(?<![${LETTER}0-9/])(${NUM})под[ъь]?езд`),
  re(`(?<![${LETTER}])под[ъь]?езд[а-яё]*\\.?\\s*(?:№\\s*)?(${NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${NUM})\\s+под[ъь]?езд`),
  re(`(?<![${LETTER}])(?:вход|кіреберіс)\\s*(?:№\\s*)?(${NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${NUM})\\s*(?:вход|кіреберіс)(?![${LETTER}])`),
  re(`(?<![${LETTER}])под\\.\\s*(?:№\\s*)?(${NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${NUM})\\s*под\\.(?![${LETTER}])`),
];

const FLOOR_PATTERNS = [
  re(`(?<![${LETTER}0-9/])(${NUM})этаж`),
  re(`(?<![${LETTER}])этаж[а-яё]*\\.?\\s*(?:№\\s*)?(${NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${NUM})\\s+этаж`),
  re(`(?<![${LETTER}0-9/])(${NUM})қабат`),
  re(`(?<![${LETTER}])қабат[а-яё]*\\.?\\s*(?:№\\s*)?(${NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${NUM})\\s+қабат`),
  re(`(?<![${LETTER}0-9/])(?:floor)\\s*(?:№\\s*)?(${NUM})(?![${LETTER}])`),
  re(`(?<![${LETTER}0-9/])(${NUM})\\s+floor(?![${LETTER}])`),
];

const HOUSE_MARKER_PATTERNS = [
  re(`(?<![${LETTER}0-9/])(${HOUSE_NUM})дом[а-яё]?(?![${LETTER}0-9])`),
  re(`(?<![${LETTER}])дом[а-яё]?\\.?\\s*(?:№\\s*)?(${HOUSE_NUM})`),
  re(`(?<![${LETTER}])д\\.\\s*(?:№\\s*)?(${HOUSE_NUM})`),
  re(`(?<![${LETTER}0-9/])(\\d{1,4})д(?![${LETTER}0-9.])`),
];

const PROVINCE_PATTERNS = [
  re(`(?<![${LETTER}])(${LWORD}(?:\\s+${LWORD}){0,3})\\s*(?<![${LETTER}])(?:област(?:ь|и|ью)?|облыс[а-яё]*)`),
];

const DISTRICT_PATTERNS = [
  re(
    `(?<![${LETTER}])(${LWORD}(?:\\s+${LWORD}){0,4})\\s*(?<![${LETTER}])(?:район(?:а|ы|у|е|ом)?|аудан(?:ы|ға|да|ның|ды)?|р[\\-\\s]?н)(?![${LETTER}])`,
  ),
];

// После маркера города не захватываем следующий адресный маркер —
// иначе «город Караганда проспект Бухар-Жырау» съест «проспект».
const CITY_STOP_WORDS = [...STOP_TOKENS]
  .map(escapeRe)
  .sort((a, b) => b.length - a.length)
  .join('|');
const CITY_NAME_WORD = `(?!${CITY_STOP_WORDS}(?![${LETTER}]))${LWORD}`;

const CITY_MARKER_PATTERNS = [
  re(
    `(?<![${LETTER}])(?:` +
      `город(?:а|у|е|ом)?(?![${LETTER}])|гор\\.|г\\.|` +
      `қала(?:ның|да|ға|ны)?(?![${LETTER}])|қ\\.|` +
      `пос[её]лок(?![${LETTER}])|пос[её]лка(?![${LETTER}])|пос[её]лк[еи](?![${LETTER}])|пос\\.|` +
      `село|села|селе|` +
      `ауыл[а-яё]*(?![${LETTER}])|ау\\.|` +
      `кент[а-яё]*(?![${LETTER}])|пгт|р\\.?п\\.?|н\\.?п\\.?|` +
      `с\\.` +
      `)[\\s.:]*(${CITY_NAME_WORD}(?:\\s+${CITY_NAME_WORD}){0,2})`,
  ),
];

// «Голый» номер дома без маркера — крайний случай, проверяется последним.
const BARE_HOUSE_PATTERNS = [
  re(`(?<![${LETTER}0-9\\-/])(${HOUSE_NUM})(?![${LETTER}0-9])`),
];

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

// Берёт первое вхождение по списку паттернов; найденный фрагмент вырезается
// из строки (rest) и возвращается вместе со значением.
function takeFirst(s, patterns) {
  for (const pattern of patterns) {
    const m = pattern.exec(s);
    if (m) {
      const value = m[1] ?? null;
      const rest = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      return { value, rest };
    }
  }
  return { value: null, rest: s };
}

function cleanNumber(v) {
  return v == null ? null : String(v).replace(/\s+/g, '');
}

function cleanHouse(v) {
  if (v == null) return null;
  return String(v).replace(/\s*\/\s*/g, '/').replace(/\s+/g, '').replace(/[.,;]+$/g, '');
}

function isStopStyle(token) {
  return isStopToken(token);
}

// Чистка административного названия: оставляем слова после последнего служебного
// токена (город/область/қаласы/район/...) и убираем мусор по краям.
function cleanAdminName(run) {
  const toks = run.trim().split(/\s+/);
  let start = 0;
  for (let i = 0; i < toks.length; i++) {
    if (isStopStyle(toks[i])) start = i + 1;
  }
  let out = toks.slice(start).filter((t) => !isStopStyle(t));
  if (out.length > 4) out = out.slice(-4);
  return out.join(' ').replace(/^[.,;:\-\s]+|[.,;:\-\s]+$/g, '').trim();
}

// Область приводится к каноничному виду: «Актобе облысы» → «Актюбинская область».
function canonProvince(name) {
  let n = cleanAdminName(name);
  if (!n) return null;
  if (/ой$/i.test(n)) n = n.replace(/ой$/i, 'ая');
  else if (/ей$/i.test(n)) n = n.replace(/ей$/i, 'яя');
  const stem = canonicalProvinceStem(n);
  if (stem) n = stem;
  if (!/область$/i.test(n)) n = `${n} область`;
  return n;
}

function cleanCityName(run) {
  const n = cleanAdminName(run);
  return n || null;
}

// Удаляем служебные слова («қаласы», «область», «город», ...) из остатка строки.
function stripParticles(s) {
  const toks = s.split(/\s+/).filter(Boolean);
  const kept = toks.filter((t) => {
    const key = t.toLowerCase().replace(/[.,;:()«»"'’№]/g, '');
    if (!key) return false;
    if (key === '№') return false;
    if (ADMIN_PARTICLES.includes(key)) return false;
    if (key.startsWith('қалас') || key.startsWith('облыс')) return false;
    return true;
  });
  return kept.join(' ');
}

// Удаляем одиночные маркеры, оставшиеся без номера («кв», «этаж», «подъезд», «д.»).
function stripStrayMarkers(s) {
  const toks = s.split(/\s+/).filter(Boolean);
  const kept = toks.filter((t) => {
    const key = t.toLowerCase().replace(/[.,;:()«»"'’]/g, '');
    if (!key) return false;
    if (STRAY_TOKENS.has(key)) return false;
    return true;
  });
  return kept.join(' ');
}

// Разделяем слитные «Название8» / «Название55/6» → «Название 8»,
// а также «66квартал» / «2микрорайон» → «66 квартал» / «2 микрорайон».
function splitGluedWordNumber(s) {
  // Без цифр делить нечего — быстрый выход для длинных строк-мусора.
  if (!/\d/.test(s)) return s;
  const wordThenNum = s.replace(
    new RegExp(`([${LETTER}]{2,60}?)(\\d{1,4})(?=\\s|$|[,;/])`, 'giu'),
    '$1 $2',
  );
  return wordThenNum.replace(
    new RegExp(
      `(\\d{1,4})(?=(?:квартал|микрорайон|микрор|микро|мкрн|мкр|микр|жилмассив|массив|жилмассив|кварт)(?![${LETTER}]))`,
      'giu',
    ),
    '$1 ',
  );
}

// ---------------------------------------------------------------------------
// Справочник городов
// ---------------------------------------------------------------------------

// Если город уже известен — убираем его повторные упоминания из строки.
// Если ещё нет — ищем первое вхождение известного города и запоминаем.
function applyCityDict(s, result) {
  if (result.city) {
    const info = CITY_MAP.get(result.city.toLowerCase());
    const aliases = info
      ? CITY_ALIASES.filter((a) => CITY_MAP.get(a) === info)
      : [result.city];
    for (const alias of aliases) {
      s = s.replace(
        new RegExp(`(?<![${LETTER}])${escapeRe(alias)}(?![${LETTER}])`, 'giu'),
        ' ',
      );
    }
    return s;
  }

  let best = null;
  for (const alias of CITY_ALIASES) {
    const m = re(`(?<![${LETTER}])${escapeRe(alias)}(?![${LETTER}])`).exec(s);
    if (m && (!best || m.index < best.index)) {
      best = { index: m.index, alias, info: CITY_MAP.get(alias) };
    }
  }
  if (!best) return s;

  result.city = best.info.name;
  const aliases = CITY_ALIASES.filter((a) => CITY_MAP.get(a) === best.info);
  for (const alias of aliases) {
    s = s.replace(
      new RegExp(`(?<![${LETTER}])${escapeRe(alias)}(?![${LETTER}])`, 'giu'),
      ' ',
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// Извлечение улиц / микрорайонов / ЖК
// ---------------------------------------------------------------------------

function tokenize(s) {
  const toks = [];
  const rr = /\S+/g;
  let m;
  while ((m = rr.exec(s))) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return toks;
}

// Токен подходит на роль имени: буквы (допустимы цифры, дефис, апостроф),
// не служебное слово. Короткие числа («17») пропускаются только для
// микрорайонов — у них номер часть названия.
function isNameToken(text, allowNumber) {
  const cleaned = text.replace(/^[.,;:()«»"'’]+|[.,;:()«»"'’]+$/g, '');
  if (!cleaned) return false;
  if (isStopStyle(cleaned)) return false;
  if (/^\d{1,3}$/.test(cleaned)) return allowNumber === true;
  return new RegExp(`^[${LETTER}][${LETTER}0-9'’\\-]*$`, 'u').test(cleaned);
}

function cleanNameWords(name) {
  return name.replace(/\s+/g, ' ').replace(/^[.,;:\-\s]+|[.,;:\-\s]+$/g, '').trim();
}

// Номер дома сразу за названием улицы («Абая 12», «Достык 210»).
function takeHouseAfter(s, pos) {
  const m = new RegExp(`^[\\s,]*(${HOUSE_NUM})(?![${LETTER}0-9])`, 'iu').exec(s.slice(pos));
  if (!m) return null;
  const start = pos + m[0].length - m[1].length;
  return { value: cleanHouse(m[1]), start, end: pos + m[0].length };
}

// Собирает название вокруг маркера типа улицы: слова до и после маркера,
// пока они подходят по типу (не служебные, не номер дома).
function grabName(s, match) {
  const toks = tokenize(s);
  let si = toks.findIndex((t) => match.start >= t.start && match.start < t.end);
  let ei = toks.findIndex((t) => match.end - 1 >= t.start && match.end - 1 < t.end);
  if (si < 0) si = 0;
  if (ei < 0) ei = si;

  const def = match.def;
  const allowNumBefore = def.family === 'micro';
  const allowNumAfterFirst = def.family === 'micro';

  const beforeParts = [];
  const afterParts = [];

  if (match.start > toks[si].start) {
    const p = toks[si].text.slice(0, match.start - toks[si].start).trim();
    if (p) beforeParts.unshift(p);
  }
  if (match.end < toks[ei].end) {
    const p = toks[ei].text.slice(match.end - toks[ei].start).trim();
    if (p) afterParts.push(p);
  }

  let li = si - 1;
  while (li >= 0) {
    const txt = toks[li].text;
    if (/[;]$/.test(txt)) break;
    // «8,» перед маркером — это дом предыдущего компонента, а не часть названия.
    if (/,$/.test(txt) && /^\d{1,4}[а-яa-z]?,$/i.test(txt)) break;
    if (isNameToken(txt, allowNumBefore)) {
      beforeParts.unshift(txt);
      li--;
      if (/,$/.test(txt)) break;
    } else break;
  }

  let ri = ei + 1;
  let firstRight = afterParts.length === 0;
  while (ri < toks.length) {
    const txt = toks[ri].text;
    const hasComma = /[,;]$/.test(txt);
    const isWord = isNameToken(txt, false);
    // Для микрорайона номер с литерой может быть частью названия:
    // «Аксай 3а», «Нурсити 2», «Привокзальный 5» — это не дом.
    const isNum = /^\d{1,3}[а-яa-z]?[,;]?$/i.test(txt);
    if (isWord) {
      afterParts.push(txt);
      firstRight = false;
      ri++;
      if (hasComma) break;
    } else if (allowNumAfterFirst && isNum && (firstRight || hasComma)) {
      afterParts.push(txt);
      firstRight = false;
      ri++;
      if (hasComma) break;
    } else break;
  }

  const before = cleanNameWords(beforeParts.join(' '));
  const after = cleanNameWords(afterParts.join(' '));
  const name = def.prefer === 'before' ? before || after : after || before;

  const startTok = toks[li + 1] ?? toks[si];
  const endTok = toks[ri - 1] ?? toks[ei];
  return { name: name || null, start: startTok.start, end: endTok.end };
}

// Первая подряд идущая группа слов — кандидат в название улицы без маркера типа
// («Туран 55/6», «Назарбаева8»).
function firstWordRun(s) {
  const toks = tokenize(s);
  let startIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    if (isNameToken(toks[i].text, false)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  const parts = [];
  let end = toks[startIdx].end;
  for (let i = startIdx; i < toks.length && parts.length < 4; i++) {
    const txt = toks[i].text;
    if (!isNameToken(txt, false)) break;
    parts.push(txt);
    end = toks[i].end;
    if (/[,;]$/.test(txt)) break;
  }
  const name = cleanNameWords(parts.join(' '));
  if (!name) return null;
  return { name, start: toks[startIdx].start, end };
}

// Основной сборщик улиц: находит все маркеры типов, выбирает непересекающиеся
// совпадения и распределяет их по полям street_name / living_area.
// Найденные фрагменты заносятся в consumed и потом вычеркиваются из строки.
function extractStreets(s, result) {
  const matches = [];
  for (const def of STREET_DEFS) {
    const scan = re(def.source, 'giu');
    let m;
    while ((m = scan.exec(s))) {
      matches.push({ def, start: m.index, end: m.index + m[0].length });
      if (m.index === scan.lastIndex) scan.lastIndex++;
    }
  }

  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const chosen = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      chosen.push(m);
      lastEnd = m.end;
    }
  }

  const realStreet = chosen.find((m) => m.def.family === 'street');
  const micro = chosen.filter((m) => m.def.family === 'micro');
  const living = chosen.filter((m) => m.def.family === 'living');

  const consumed = [];
  const takeName = (m) => {
    const g = grabName(s, m);
    consumed.push([g.start, g.end]);
    return g;
  };
  const takeHouse = (g) => {
    if (result.house || !g) return;
    const h = takeHouseAfter(s, g.end);
    if (h) {
      result.house = h.value;
      consumed.push([h.start, h.end]);
    }
  };

  // Имена микрорайонов/ЖК вычисляем заранее: нужно решить, улица это или living_area.
  const microGrabs = micro.map((m) => ({ m, g: grabName(s, m) }));
  const livingGrabs = living.map((m) => ({ m, g: grabName(s, m) }));

  if (realStreet) {
    // Случай 1: явная улица с типом (ул./пр./...).
    const g = takeName(realStreet);
    result.street_type = realStreet.def.type;
    result.street_name = g.name || result.street_name;
    takeHouse(g);
  } else {
    // Случай 2: улица без типа («Туран 55/6 ...» / «Назарбаева8»).
    const otherSpans = [...microGrabs, ...livingGrabs].map((x) => x.g);
    const microIsNumeric =
      microGrabs.length > 0 &&
      microGrabs.every((x) => x.g.name == null || /^[\d\s,.;\/-]+$/.test(x.g.name));
    if (!result.street_name && (microGrabs.length === 0 || microIsNumeric)) {
      const run = firstWordRun(s);
      const insideSpan = run
        ? otherSpans.some((g) => !(run.end <= g.start || run.start >= g.end))
        : true;
      if (run && !insideSpan) {
        const first = run.name.toLowerCase().split(/\s+/)[0].replace(/[.,;:]+$/, '');
        consumed.push([run.start, run.end]);
        if (LANDMARK_PREFIXES.has(first)) {
          // Начинается с маркера ориентира («магазин береке») — это landmark.
          if (!result.landmark) result.landmark = run.name;
        } else {
          result.street_name = run.name;
          takeHouse(run);
        }
      }
    }
  }

  // Случай 3: микрорайон/квартал — улица, если настоящей улицы нет; иначе living_area.
  for (const { m, g } of microGrabs) {
    consumed.push([g.start, g.end]);
    if (!realStreet && !result.street_name) {
      result.street_type = m.def.type;
      result.street_name = g.name || result.street_name;
    } else if (!result.living_area) {
      result.living_area = g.name || null;
    }
  }

  // Случай 4: ЖК/массив — всегда living_area.
  for (const { g } of livingGrabs) {
    consumed.push([g.start, g.end]);
    if (!result.living_area) result.living_area = g.name || null;
  }

  if (!consumed.length) return s;

  // Вычеркиваем использованные фрагменты по битовой маске (а не срезами строк —
  // иначе индексы после первого удаления уезжают и вложенные совпадения жрут не то).
  consumed.sort((a, b) => a[0] - b[0]);
  const mask = new Array(s.length).fill(false);
  for (const [a, b] of consumed) {
    for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) mask[i] = true;
  }
  return s
    .split('')
    .map((ch, i) => (mask[i] ? ' ' : ch))
    .join('');
}

// ---------------------------------------------------------------------------
// Ориентир и оценка уверенности
// ---------------------------------------------------------------------------

// Ориентир собирается из остатка строки, но только если он начинается с
// узнаваемого маркера (магазин, БЦ, Qazpost, ТРЦ...) — случайный мусор
// в landmark не попадает. Номер сохраняется, только если стоит сразу за
// словом («офис 5»); одиночные числа — это обычно остаток дома/квартиры.
function assembleLandmark(s) {
  const toks = s
    .split(/\s+/)
    .map((t) => t.replace(/^[.,;:]+|[.,;:]+$/g, ''))
    .filter(Boolean);
  if (!toks.length) return null;
  const first = toks[0].toLowerCase().replace(/[.,;:]+$/, '');
  if (!LANDMARK_PREFIXES.has(first)) return null;
  const isNum = (t) => /^\d{1,4}[а-яa-z]?(?:\/\d{1,4}[а-яa-z]?)?$/i.test(t);
  const kept = [];
  for (let i = 0; i < toks.length; i++) {
    if (!isNum(toks[i])) kept.push(toks[i]);
    else if (i > 0 && !isNum(toks[i - 1])) kept.push(toks[i]);
  }
  return kept.length ? kept.join(' ') : null;
}

// Простая эвристика 0..1: сколько ключевых полей заполнено и насколько
// надёжно распознан город. В автоматическую метрику не входит, но в
// веб-интерфейсе помогает подсветить сомнительные строки.
function computeConfidence(r) {
  let c = 0.45;
  if (r.province) c += 0.07;
  if (r.city) c += 0.13;
  if (r.street_name) c += 0.13;
  if (r.house) c += 0.11;
  if (r.apartment) c += 0.04;
  if (r.entrance) c += 0.03;
  if (r.floor) c += 0.03;
  if (r.district) c += 0.03;
  if (r.living_area) c += 0.03;
  if (!r.city) c -= 0.12;
  if (!r.house) c -= 0.10;
  if (!r.street_name) c -= 0.08;
  c = Math.max(0.05, Math.min(0.99, c));
  return Math.round(c * 100) / 100;
}

// ---------------------------------------------------------------------------
// Главная функция
// ---------------------------------------------------------------------------

export function parseFields(raw) {
  const result = {
    province: null,
    city: null,
    district: null,
    living_area: null,
    street_type: null,
    street_name: null,
    house: null,
    apartment: null,
    entrance: null,
    floor: null,
    landmark: null,
  };

  // Очень длинные строки (мусор, склейки) обрезаем до разумного предела:
  // реальные адреса — десятки символов, обрезка защищает от вырождения
  // производительности на случайном вводе.
  const MAX_LEN = 2048;
  let s = normalize(typeof raw === 'string' && raw.length > MAX_LEN ? raw.slice(0, MAX_LEN) : raw);
  s = resolveBilingual(s);

  let t;

  // Порядок важен: сначала однозначные числовые поля, потом административные,
  // и только затем — улица и ориентир из остатка.

  t = takeFirst(s, HOUSE_MARKER_PATTERNS);
  result.house = cleanHouse(t.value);
  s = t.rest;

  t = takeFirst(s, APARTMENT_PATTERNS);
  result.apartment = cleanNumber(t.value);
  s = t.rest;

  t = takeFirst(s, ENTRANCE_PATTERNS);
  result.entrance = cleanNumber(t.value);
  s = t.rest;

  t = takeFirst(s, FLOOR_PATTERNS);
  result.floor = cleanNumber(t.value);
  s = t.rest;

  t = takeFirst(s, PROVINCE_PATTERNS);
  if (t.value) {
    result.province = canonProvince(t.value);
    s = t.rest;
  }

  t = takeFirst(s, DISTRICT_PATTERNS);
  if (t.value) {
    const d = cleanAdminName(t.value);
    result.district = d || null;
    s = t.rest;
  }

  t = takeFirst(s, CITY_MARKER_PATTERNS);
  if (t.value) {
    const c = cleanCityName(t.value);
    result.city = canonicalCity(c) || c;
    s = t.rest;
  }

  s = applyCityDict(s, result);

  // Город республиканского значения — он же и область. У остальных городов
  // с устойчивой привязкой область берётся из словаря.
  if (result.city && !result.province) {
    if (REPUBLICAN_CITIES.has(result.city)) {
      result.province = result.city;
    } else if (STABLE_CITY_PROVINCE.has(result.city)) {
      const info = CITY_MAP.get(result.city.toLowerCase());
      if (info) result.province = info.province;
    }
  }

  s = stripParticles(s);
  s = splitGluedWordNumber(s);
  s = extractStreets(s, result);

  if (!result.house) {
    t = takeFirst(s, BARE_HOUSE_PATTERNS);
    result.house = cleanHouse(t.value);
    s = t.rest;
  }

  s = stripStrayMarkers(s);
  const tailLandmark = assembleLandmark(s);
  if (tailLandmark) {
    result.landmark = result.landmark
      ? `${result.landmark} ${tailLandmark}`
      : tailLandmark;
  }

  result.confidence = computeConfidence(result);

  return result;
}
