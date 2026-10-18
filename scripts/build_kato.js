#!/usr/bin/env node
// Офлайн-сборка справочника КАТО (Классификатор административно-территориальных
// объектов РК) в компактный JSON-индекс для быстрого поиска во время разбора.
//
//   node scripts/build_kato.js                 # скачать xlsx с stat.gov.kz и собрать
//   node scripts/build_kato.js --local file.xlsx
//
// На выходе: data/kato/reference.json
//
// Сборка не тянет внешних зависимостей: XLSX — это ZIP с XML, поэтому используется
// встроенный zlib (inflateRawSync) и простой разбор XML регулярками.
//
// Источник: Бюро национальных статистик РК, КАТО НК РК 11-2025.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { canonicalProvinceStem, normalizeKey } from '../src/lexicon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'kato');
const SRC_DIR = path.join(OUT_DIR, 'source');
const OUT_FILE = path.join(OUT_DIR, 'reference.json');
const SRC_CACHE = path.join(SRC_DIR, 'kato.xlsx');

const KATO_URL =
  'https://stat.gov.kz/upload/iblock/a7d/eqogm92xc0udumlzfzffhcrutk0fjhb4/%D0%9A%D0%90%D0%A2%D0%9E_18.09.2026.xlsx';

// ---------------------------------------------------------------------------
// 1. Минимальный ZIP-ридер (xlsx = zip)
// ---------------------------------------------------------------------------

function unzip(buf) {
  // Ищем End Of Central Directory (EOCD).
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP: не найден EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: битый центральный каталог');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    entries[name] = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 2. Разбор XML xlsx
// ---------------------------------------------------------------------------

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    let text = '';
    while ((t = tRe.exec(m[1]))) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
}

function parseSheet(xml, strings) {
  const rows = [];
  const rowRe = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = {};
    const cellRe = /<c\b[^>]*r="([A-Z]+)\d+"([^>]*)\/?>(?:<v>([\s\S]*?)<\/v>)?/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const col = cm[1];
      const attrs = cm[2] || '';
      const raw = cm[3];
      if (raw === undefined) continue;
      const isShared = /\bt="s"/.test(attrs);
      const isInline = /\bt="(inlineStr|str)"/.test(attrs);
      const value = isShared ? strings[+raw] : decodeXml(raw);
      cells[col] = isInline ? decodeXml(raw) : value;
    }
    rows.push({ row: +rm[1], cells });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. Административная модель
// ---------------------------------------------------------------------------

// Уровень объекта по 9-значному коду (группы 2-2-2-3).
function levelOf(code) {
  const c = String(code).padStart(9, '0');
  if (c.slice(6, 9) !== '000') return 3;
  if (c.slice(4, 6) !== '00') return 2;
  if (c.slice(2, 4) !== '00') return 1;
  return 0;
}

// Коды «родителей» (от ближайшего к дальнему).
function ancestorCodes(code) {
  const c = String(code).padStart(9, '0');
  const g = [c.slice(0, 2), c.slice(2, 4), c.slice(4, 6), c.slice(6, 9)];
  const out = [];
  if (g[3] !== '000') out.push(g[0] + g[1] + g[2] + '000');
  if (g[2] !== '00') out.push(g[0] + g[1] + '00000');
  if (g[1] !== '00') out.push(g[0] + '0000000');
  return out;
}

function classify(rus) {
  const n = rus.trim();
  if (/^область\s+/i.test(n) || /область$/i.test(n)) return 'region';
  if (/район/i.test(n)) return 'district';
  if (/Г\.А\.|Қ\.Ә\./i.test(n)) return 'city_admin';
  if (/с\.о\.|а\.о\./i.test(n)) return 'rural_okrug';
  if (/^г\./i.test(n)) return 'city';
  if (/^[сап]\./i.test(n)) return 'village';
  return 'other';
}

function canonicalProvince(rus) {
  const m = /^область\s+(.+)$/i.exec(rus.trim());
  if (m) {
    const stem = canonicalProvinceStem(m[1]);
    return stem ? `${stem} область` : m[1].trim();
  }
  if (/^г\./i.test(rus.trim())) {
    return rus.trim().replace(/^г\.\s*/i, '');
  }
  return rus.trim();
}

function cleanNodeName(rus) {
  let n = rus.trim();
  n = n.replace(/\s*(Г\.А\.|Қ\.Ә\.|с\.о\.?|а\.о\.?)\s*$/iu, '').trim();
  n = n.replace(/^г\.\s*/iu, '').replace(/^[сапқ]\.\s*/iu, '').trim();
  return n;
}

function cleanDistrict(rus) {
  let n = rus.trim();
  const m = /^район\s+(.+)$/i.exec(n);
  if (m) n = m[1];
  else n = n.replace(/\s*район[а-яё]*$/iu, '');
  return n.trim();
}

// Прилагательные-хвосты названий районов («Турксибский» -> «турксиб»).
const DISTRICT_STEMS = [
  'инский', 'ский', 'ская', 'ское', 'ские', 'ого', 'ому', 'ий', 'ый',
  'ая', 'ое', 'ые', 'ой', 'ей',
];

// Убираем служебное слово «район/аудан» (в т.ч. казахское «ауданы»).
function stripDistrictWord(name) {
  return String(name).replace(/\s*(район[а-яё]*|аудан[а-яё]*)\s*$/iu, '').trim();
}

// «Турксибский» -> «турксиб», «Түрксіб ауданы» -> «турксиб». Нужно, чтобы
// казахские краткие формы («Түрксіб ауданы» в строке -> «Түрксіб») находили район.
function stemDistrict(name) {
  let n = stripDistrictWord(name).toLowerCase();
  for (const t of DISTRICT_STEMS) {
    if (n.length - t.length >= 3 && n.endsWith(t)) {
      n = n.slice(0, -t.length);
      break;
    }
  }
  return n;
}

function districtAliasKeys(name) {
  return [normalizeKey(name), normalizeKey(stripDistrictWord(name)), normalizeKey(stemDistrict(name))];
}

const TYPE_PRIORITY = { city: 4, city_admin: 3, village: 2, rep_city: 3, other: 1 };

function buildReference(records) {
  const byCode = new Map();
  for (const r of records) byCode.set(r.code, r);

  const provinceByPrefix = {};
  const provinceNames = {};
  const places = {};
  const districts = {};

  // 1-й проход: области и города республиканского значения (уровень 0).
  for (const r of records) {
    if (r.level !== 0) continue;
    const province = canonicalProvince(r.rus);
    provinceByPrefix[r.code.slice(0, 2)] = province;
    for (const key of [normalizeKey(province), normalizeKey(r.rus), normalizeKey(r.kaz)]) {
      if (key) provinceNames[key] = province;
    }
  }

  const districtRowOf = (code) => {
    for (const anc of ancestorCodes(code)) {
      const row = byCode.get(anc);
      if (row && row.type === 'district') return row;
    }
    return null;
  };

  const push = (map, key, entry) => {
    if (!key) return;
    (map[key] ??= []).push(entry);
  };

  for (const r of records) {
    const province = provinceByPrefix[r.code.slice(0, 2)] ?? null;

    if (r.type === 'district') {
      const name = cleanDistrict(r.rus);
      const entry = { p: province, k: r.code, t: 'district', n: name };
      for (const key of districtAliasKeys(name)) push(districts, key, entry);
      for (const key of districtAliasKeys(cleanDistrict(r.kaz))) push(districts, key, entry);
      // Район также отвечает на вопрос «в какой области» (для province).
      for (const key of [...districtAliasKeys(name), ...districtAliasKeys(cleanDistrict(r.kaz))]) {
        if (key && province) provinceNames[key] = provinceNames[key] ?? province;
      }
      continue;
    }

    if (r.type === 'region' || r.type === 'rural_okrug') continue;

    // Населённые пункты: город, Г.А., село/аул/посёлок.
    if (r.level === 0) {
      // Города республиканского значения (Астана/Алматы/Шымкент).
      if (!/^г\./i.test(r.rus)) continue;
      const entry = { p: province, d: null, k: r.code, t: 'rep_city', n: cleanNodeName(r.rus) };
      push(places, normalizeKey(cleanNodeName(r.rus)), entry);
      push(places, normalizeKey(cleanNodeName(r.kaz)), entry);
      continue;
    }

    const distRow = districtRowOf(r.code);
    const districtName = distRow ? cleanDistrict(distRow.rus) : null;
    const districtKato = distRow ? distRow.code : null;
    const entry = {
      p: province,
      d: districtName,
      k: r.code,
      t: r.type,
      n: cleanNodeName(r.rus),
      dk: districtKato,
    };
    push(places, normalizeKey(cleanNodeName(r.rus)), entry);
    push(places, normalizeKey(cleanNodeName(r.kaz)), entry);
  }

  return { provinceByPrefix, provinceNames, places, districts };
}

function dedupe(list) {
  const seen = new Map();
  for (const e of list) {
    const key = `${e.p}|${e.d ?? ''}|${e.k}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// 4. Загрузка / запись
// ---------------------------------------------------------------------------

async function ensureSource(localFile) {
  if (localFile) return fs.readFileSync(localFile);
  if (fs.existsSync(SRC_CACHE)) return fs.readFileSync(SRC_CACHE);
  console.error(`Скачиваю КАТО: ${KATO_URL}`);
  const res = await fetch(KATO_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке КАТО`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(SRC_CACHE, buf);
  return buf;
}

async function main() {
  const args = process.argv.slice(2);
  const localIdx = args.findIndex((a) => a === '--local');
  const localFile = localIdx >= 0 ? args[localIdx + 1] : null;

  const xlsx = await ensureSource(localFile);
  console.error(`XLSX: ${(xlsx.length / 1024 / 1024).toFixed(2)} МБ`);

  const entries = unzip(xlsx);
  const sharedXml = entries['xl/sharedStrings.xml'].toString('utf8');
  const sheetXml = entries['xl/worksheets/sheet1.xml'].toString('utf8');
  const strings = parseSharedStrings(sharedXml);
  const rows = parseSheet(sheetXml, strings).slice(1); // без заголовка

  const records = [];
  for (const { cells } of rows) {
    const code = cells.A;
    if (!code || !/^\d{9}$/.test(code)) continue;
    const rus = (cells.H ?? '').trim();
    const kaz = (cells.G ?? '').trim();
    if (!rus) continue;
    records.push({ code, level: levelOf(code), rus, kaz, type: classify(rus) });
  }
  console.error(`Записей КАТО: ${records.length}`);

  const { provinceByPrefix, provinceNames, places, districts } = buildReference(records);

  // Дедупликация и сортировка «лучшего» кандидата первым.
  for (const key of Object.keys(places)) {
    places[key] = dedupe(places[key]).sort(
      (a, b) =>
        (TYPE_PRIORITY[b.t] ?? 0) - (TYPE_PRIORITY[a.t] ?? 0) ||
        b.k.length - a.k.length ||
        a.k.localeCompare(b.k),
    );
  }
  for (const key of Object.keys(districts)) districts[key] = dedupe(districts[key]);

  const out = {
    meta: {
      source: 'КАТО НК РК 11-2025 (Бюро национальной статистики РК)',
      url: KATO_URL,
      version: '2026-09-18',
      builtAt: new Date().toISOString(),
      records: records.length,
      places: Object.keys(places).length,
      districts: Object.keys(districts).length,
    },
    provinceByPrefix,
    provinceNames,
    places,
    districts,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf8');
  const size = fs.statSync(OUT_FILE).size;
  console.error(
    `\nГотово: ${path.relative(ROOT, OUT_FILE)} (${(size / 1024).toFixed(0)} КБ)\n` +
      `  областей: ${Object.keys(provinceByPrefix).length}, ` +
      `населённых пунктов (ключей): ${Object.keys(places).length}, ` +
      `районов (ключей): ${Object.keys(districts).length}`,
  );
}

main().catch((err) => {
  console.error('Ошибка сборки КАТО:', err.message);
  process.exit(1);
});
