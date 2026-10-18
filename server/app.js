#!/usr/bin/env node
// REST API + раздача веб-интерфейса. Без внешних зависимостей (node:http).
//
//   npm run serve            # http://localhost:8080
//   PORT=3000 npm run serve
//
// Эндпоинты:
//   GET  /api/health                 — статус и версия справочника
//   POST /api/parse                  — {"raw_address":"..."} → результат разбора
//   POST /api/parse/batch            — [ {...}, ... ] или {"records":[...]} → массив
//   GET  /api/lookup?name=Боралдай   — что известно справочнику КАТО
//   (всё остальное)                  — собранный интерфейс из web/dist/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecord, parseRecords, getRaw } from '../src/pipeline.js';
import { referenceMeta, lookupPlace, lookupDistrict, hasReference } from '../src/reference.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'web', 'dist');
const rawPort = process.env.PORT;
const PORT = rawPort === undefined || rawPort === ''
  ? 8080
  : Number(rawPort);
const LISTEN_PORT = Number.isFinite(PORT) ? PORT : 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 32 * 1024 * 1024; // 32 МБ

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Приводит тело запроса к массиву записей.
function toRecords(body) {
  if (Array.isArray(body)) return { records: body };
  if (body && Array.isArray(body.records)) return { records: body.records };
  if (body && Array.isArray(body.data)) return { records: body.data };
  if (body && typeof body === 'object') return { records: [body] };
  return { error: 'Ожидается объект или массив записей' };
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      reference: hasReference(),
      kato: referenceMeta(),
      uptime: Math.round(process.uptime()),
    });
  }

  if (pathname === '/api/lookup' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    return sendJson(res, 200, {
      name,
      place: lookupPlace(name),
      district: lookupDistrict(name),
    });
  }

  if (pathname === '/api/parse' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Некорректный JSON' });
    }
    const raw = getRaw(body);
    if (!raw) return sendJson(res, 400, { error: 'Не найдено поле raw_address/address/raw' });
    return sendJson(res, 200, parseRecord(body));
  }

  if (pathname === '/api/parse/batch' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '[]');
    } catch {
      return sendJson(res, 400, { error: 'Некорректный JSON' });
    }
    const { records, error } = toRecords(body);
    if (error) return sendJson(res, 400, { error });
    if (!records.length) return sendJson(res, 200, []);
    const started = Date.now();
    const out = parseRecords(records);
    res.setHeader('x-parse-ms', String(Date.now() - started));
    return sendJson(res, 200, out);
  }

  return sendJson(res, 404, { error: 'Неизвестный эндпоинт' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // /data/* — только чтение примеров из data/ (sample_input/output.json).
  let filePath;
  if (rel.startsWith('/data/')) {
    const dataDir = path.resolve(__dirname, '..', 'data');
    filePath = path.resolve(dataDir, `.${rel.slice('/data'.length)}`);
    if (filePath !== dataDir && !filePath.startsWith(`${dataDir}${path.sep}`)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
  } else {
    filePath = path.resolve(DIST_DIR, `.${rel}`);
    if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${path.sep}`)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!rel.startsWith('/data/') && req.method === 'GET' && !path.extname(rel)) {
        fs.readFile(path.join(DIST_DIR, 'index.html'), (indexErr, index) => {
          if (indexErr) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
            return;
          }
          res.writeHead(200, {
            'content-type': MIME['.html'],
            'content-length': index.length,
          });
          res.end(index);
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS — чтобы фронтенд и внешние скрипты могли стучаться к API.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    const status = err.statusCode || 500;
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Внутренняя ошибка' });
    else res.end();
  }
});

server.listen(LISTEN_PORT, HOST, () => {
  const actual = server.address().port;
  console.log(`Jana Address API: http://${HOST}:${actual}`);
  console.log(`Справочник КАТО: ${hasReference() ? 'загружен' : 'НЕ НАЙДЕН (запустите node scripts/build_kato.js)'}`);
});

export { server };
