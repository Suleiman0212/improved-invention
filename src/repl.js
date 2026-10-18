#!/usr/bin/env node
// Интерактивный разбор адресов.
//
//   node src/repl.js                       # интерактивный REPL
//   node src/repl.js "ул. Абая 12 кв 5"    # разобрать одну строку и выйти
//   echo "Туран 55/6 4подьезд" | node src/repl.js   # разбор строк из stdin

import readline from 'node:readline';
import process from 'node:process';
import { parseAddress } from './enrich.js';

const HELP = `
Введите адресную строку и нажмите Enter — увидите разбор в JSON.
Команды:
  .help    показать эту справку
  .exit    выйти (также .quit или Ctrl+D)
`;

function parseAndPrint(raw) {
  const result = parseAddress(raw);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const args = process.argv.slice(2);

// 1) Аргумент командной строки — разобрать одну строку.
if (args.length > 0) {
  parseAndPrint(args.join(' '));
  process.exit(0);
}

// 2) Данные из stdin (пайп/редирект) — построчно.
if (!process.stdin.isTTY) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
  });
  process.stdin.on('end', () => {
    for (const line of buf.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (t === '.exit' || t === '.quit') break;
      if (t === '.help') {
        console.log(HELP);
        continue;
      }
      console.log(`> ${t}`);
      parseAndPrint(t);
    }
  });
} else {
  // 3) Интерактивный REPL.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'адрес> ',
  });

  console.log('Парсер адресов Jana (RU/KZ). Введите .help для справки, .exit для выхода.');
  rl.prompt();

  rl.on('line', (line) => {
    const t = line.trim();
    if (t === '.exit' || t === '.quit') {
      rl.close();
      return;
    }
    if (t === '.help') {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (t) parseAndPrint(t);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nПока!');
    process.exit(0);
  });
}
