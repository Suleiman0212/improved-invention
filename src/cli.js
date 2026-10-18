#!/usr/bin/env node
// CLI: пакетный разбор адресов из JSON/JSONL файла.
// Использование: node src/cli.js <input.json> [-o out.json]
// Если out не задан — результат печатается в stdout.

import fs from 'node:fs';
import path from 'node:path';
import { parseRecord } from './pipeline.js';

function loadRecords(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];

  // JSON-массив
  if (text.startsWith('[')) {
    return JSON.parse(text);
  }

  // Одиночный объект
  if (text.startsWith('{') && !/\n\s*\{/.test(text)) {
    try {
      return [JSON.parse(text)];
    } catch {
      /* fallthrough to JSONL */
    }
  }

  // JSONL
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.findIndex((a) => a === '-o' || a === '--out');
  const output = outIdx >= 0 ? args[outIdx + 1] : null;
  const input = args.find((a, i) => i !== outIdx && i !== outIdx + 1 && !a.startsWith('-'));

  if (!input) {
    console.error('Usage: node src/cli.js <input.json> [-o out.json]');
    process.exit(2);
  }

  const records = loadRecords(path.resolve(input));
  const out = records.map((rec) => parseRecord(rec));

  const json = JSON.stringify(out, null, 2);
  if (output) {
    fs.writeFileSync(path.resolve(output), json, 'utf8');
    console.error(`Written ${out.length} records to ${output}`);
  } else {
    process.stdout.write(`${json}\n`);
  }

  const avg =
    out.reduce((acc, r) => acc + r.confidence, 0) / (out.length || 1);
  console.error(
    `Parsed ${out.length} records. Avg confidence: ${avg.toFixed(3)}. ` +
      `city: ${out.filter((r) => r.city).length}, ` +
      `street: ${out.filter((r) => r.street_name).length}, ` +
      `house: ${out.filter((r) => r.house).length}`,
  );
}

main();
