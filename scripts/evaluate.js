#!/usr/bin/env node
// Метрика разбора адресов по правилам из ТЗ (п. 6.2).
//
//   node scripts/evaluate.js                       # локальный парсер + официальный набор
//   node scripts/evaluate.js <pred.json> [truth]   # готовые предсказания
//
// Правила:
//   • адресные поля (province, city, street_name, house) — вес 0.60;
//   • детали (apartment, entrance, floor)              — вес 0.25;
//   • справочные поля (district, living_area)          — вес 0.15, и только по записям,
//     где они есть в эталоне;
//   • если поля нет ни в ответе, ни в эталоне — запись из подсчёта исключается;
//   • если поля нет в эталоне, а решение подняло его из справочника — в метрику
//     не входит (выводится отдельной колонкой «из справ.»);
//   • сравнение посимвольное после нормализации: нижний регистр, ё->е, без пунктуации
//     и лишних пробелов; падежи и опечатки не прощаются.

import fs from 'node:fs';
import path from 'node:path';

const ADDRESS_FIELDS = ['province', 'city', 'street_name', 'house'];
const DETAIL_FIELDS = ['apartment', 'entrance', 'floor'];
const REFERENCE_FIELDS = ['district', 'living_area'];
const ALL_FIELDS = [
  'province', 'city', 'district', 'living_area', 'street_type', 'street_name',
  'house', 'apartment', 'entrance', 'floor', 'landmark',
];
const GROUPS = [
  ['address', ADDRESS_FIELDS, 0.6],
  ['details', DETAIL_FIELDS, 0.25],
  ['reference', REFERENCE_FIELDS, 0.15],
];

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Нормализация значения поля (как в eval.py).
function norm(value) {
  if (value == null) return null;
  let s = String(value).toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/[^\p{L}\p{N}_\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

// Есть ли нормализованное значение поля в нормализованной исходной строке
// (правило ТЗ п. 6.2 для district / living_area).
function valueInRaw(value, rawAddress) {
  if (value == null) return false;
  const raw = norm(rawAddress);
  if (!raw) return false;
  return raw.includes(value);
}

function loadRecords(file) {
  const text = fs.readFileSync(path.resolve(file), 'utf8').trim();
  if (text.startsWith('{')) {
    const one = JSON.parse(text);
    return one.results || one.addresses || one.data || [one];
  }
  return JSON.parse(text);
}

function align(pred, truth) {
  const byId = new Map();
  const byRaw = new Map();
  for (const p of pred) {
    if (p?.id != null) byId.set(String(p.id), p);
    byRaw.set(p?.raw_address, p);
  }
  return truth.map((t) => ({
    truth: t,
    pred: byId.get(String(t?.id)) ?? byRaw.get(t?.raw_address) ?? {},
  }));
}

function evaluate(pred, truth) {
  const rows = align(pred, truth);
  const perField = {};
  for (const field of ALL_FIELDS) {
    let ok = 0, bad = 0, counted = 0, restored = 0;
    const isReference = REFERENCE_FIELDS.includes(field);
    for (const { truth: exp, pred: got } of rows) {
      const e = norm(exp?.[field]);
      const g = norm(got?.[field]);
      if (e == null && g == null) continue;
      if (e == null) { restored += 1; continue; } // из справочника — не считается
      // district / living_area учитываются только по записям, где они физически
      // есть в исходной строке; восстановленные справочником — не считаются.
      if (isReference && !valueInRaw(e, exp?.raw_address)) { restored += 1; continue; }
      counted += 1;
      if (e === g) ok += 1; else bad += 1;
    }
    perField[field] = { ok, bad, counted, restored, accuracy: counted ? ok / counted : null };
  }

  const groups = {};
  let score = 0;
  for (const [name, fields, weight] of GROUPS) {
    const ok = fields.reduce((s, f) => s + perField[f].ok, 0);
    const counted = fields.reduce((s, f) => s + perField[f].counted, 0);
    const accuracy = counted ? ok / counted : 0;
    groups[name] = { fields, weight, ok, counted, accuracy, contribution: accuracy * weight };
    score += accuracy * weight;
  }
  return { rows, perField, groups, score, restoredTotal: ALL_FIELDS.reduce((s, f) => s + perField[f].restored, 0) };
}

async function localPrediction(inputFile) {
  const { parseAddress } = await import(path.join(ROOT, 'src', 'enrich.js'));
  return loadRecords(inputFile).map((r) => ({
    id: r.id,
    raw_address: r.raw_address,
    ...parseAddress(r.raw_address),
  }));
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const input = args[0] ?? path.join(ROOT, 'data', 'official', 'sample_input.json');
  const expectedPath = args[1] ?? path.join(ROOT, 'data', 'official', 'sample_output.json');

  const expected = loadRecords(expectedPath);
  const predIdx = process.argv.indexOf('--pred');
  const predArg = predIdx >= 0 ? process.argv[predIdx + 1] : null;

  Promise.resolve(predArg ? loadRecords(predArg) : localPrediction(input)).then((pred) => {
    const { rows, perField, groups, score, restoredTotal } = evaluate(pred, expected);

    console.log('Метрика ТЗ п. 6.2\n' + '='.repeat(56));
    console.log(`Записей: ${expected.length}`);
    console.log('');
    console.log(
      'поле'.padEnd(13) + 'верно'.padStart(5) + 'ошиб'.padStart(5) + 'учтено'.padStart(6) + 'из справ'.padStart(7) + 'точность'.padStart(7)
    );
    for (const field of ALL_FIELDS) {
      const m = perField[field];
      const acc = m.accuracy == null ? '—' : (m.accuracy * 100).toFixed(1) + '%';
      console.log(
        `${field.padEnd(13)} ${String(m.ok).padStart(5)} ${String(m.bad).padStart(5)} ${String(m.counted).padStart(5)} ${String(m.restored).padStart(6)} ${acc.padStart(7)}`
      );
    }
    console.log('\nГруппы полей:');
    for (const [name, , weight] of GROUPS) {
      const g = groups[name];
      console.log(`  ${name.padEnd(9)} ${(g.accuracy * 100).toFixed(1).padStart(5)}% × ${weight} = ${g.contribution.toFixed(3)}`);
    }
    console.log(`\nИТОГОВЫЙ SCORE: ${(score * 100).toFixed(1)}%   (из справ. полей: ${restoredTotal})`);

    const KEY = [...ADDRESS_FIELDS, ...DETAIL_FIELDS, ...REFERENCE_FIELDS];
    const worst = rows
      .map(({ truth, pred: got }) => {
        const details = [];
        for (const f of KEY) {
          if ((f === 'district' || f === 'living_area')
            && (truth[f] == null || !valueInRaw(norm(truth[f]), truth.raw_address))) continue;
          if (norm(truth[f]) !== norm(got[f])) {
            details.push(`${f}: ${JSON.stringify(truth[f] ?? '')} -> ${JSON.stringify(got[f] ?? '')}`);
          }
        }
        return { id: truth.id, raw: truth.raw_address, details };
      })
      .filter((r) => r.details.length)
      .sort((a, b) => b.details.length - a.details.length);

    if (worst.length) {
      console.log('\nХудшие записи:\n' + '-'.repeat(56));
      for (const r of worst.slice(0, 15)) {
        console.log(`#${r.id}  ${JSON.stringify((r.raw ?? '').slice(0, 56))}`);
        for (const d of r.details) console.log(`    ${d}`);
      }
    }
  });
}

main();
