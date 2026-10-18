#!/usr/bin/env node
// Сбор уличного справочника из OpenStreetMap (Overpass API).
//
//   node scripts/fetch_osm.js                        # города по умолчанию
//   node scripts/fetch_osm.js --cities Алматы,Астана # только эти
//   node scripts/fetch_osm.js --force                # перекачать существующие
//   node scripts/fetch_osm.js --districts-only       # только районы (admin_level=6)
//                                                    # и переразметка district
//                                                    # у существующих улиц/мест
//
// По каждому городу сохраняется data/osm/<город>.json со структурой:
//   { city, bbox, fetchedAt, districts[], streets[], places[] }
// где district у улицы/места проставлен point-in-polygon по границам районов
// (admin_level=6 — городские районы и районы областей; более мелкие уровни
// 8/9/10 — сельские округа и села — в назначении районов не участвуют,
// полигоны сортируются по площади: меньший = более точный).
//
// Интернет нужен ТОЛЬКО на этапе подготовки справочника. При разборе адресов
// сеть не используется: результат фиксируется в репозитории (data/osm/*.json).
//
// Источник: OpenStreetMap contributors, лицензия ODbL (https://osm.org/copyright).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'osm');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'jana-address/1.0 (gazetteer builder; ODbL)';

const DEFAULT_CITIES = [
  'Алматы', 'Астана', 'Шымкент', 'Караганда', 'Актобе', 'Тараз',
  'Павлодар', 'Усть-Каменогорск', 'Семей', 'Атырау', 'Актау',
  'Костанай', 'Кызылорда', 'Уральск', 'Петропавловск', 'Туркестан',
  'Талдыкорган', 'Темиртау', 'Боралдай', 'Конаев',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(3000 * (i + 1));
    }
  }
  throw new Error(`failed ${url}: ${last?.message ?? last}`);
}

async function overpass(query, tries = 4) {
  let last;
  for (const ep of OVERPASS_ENDPOINTS) {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        last = e;
        process.stderr.write(`  ! ${ep} try ${i + 1}: ${e.message}\n`);
        await sleep(5000 * (i + 1));
      }
    }
  }
  throw new Error(`overpass failed: ${last?.message ?? last}`);
}

async function nominatimBbox(city, country = 'Казахстан') {
  const url = `${NOMINATIM}?${new URLSearchParams({
    q: `${city}, ${country}`,
    format: 'json',
    limit: '1',
  })}`;
  const js = await httpJson(url);
  if (!js.length) return null;
  const s = js[0];
  const [south, north, west, east] = s.boundingbox.map(Number);
  return { city, bbox: [south, west, north, east], osm: s.osm_id, display: s.display_name };
}

// --- point-in-polygon (ray casting), без внешних зависимостей ---
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInMultiRing(x, y, rings) {
  for (const ring of rings) if (pointInRing(x, y, ring)) return true;
  return false;
}

// Точка внутри района: попадает в любое внешнее кольцо и ни в одно внутреннее.
function pointInPoly(lon, lat, poly) {
  if (!pointInMultiRing(lon, lat, poly.outers)) return false;
  if (poly.inners.length && pointInMultiRing(lon, lat, poly.inners)) return false;
  return true;
}

function districtOf(districts, masks, lon, lat) {
  if (lat == null || lon == null) return null;
  let maskArea = Infinity;
  for (const m of masks) {
    if (pointInPoly(lon, lat, m)) maskArea = Math.min(maskArea, m.area);
  }
  for (const d of districts) {
    if (!pointInPoly(lon, lat, d)) continue;
    // Район области, накрывающий весь город (город — анклав внутри него),
    // не является районом города: пропускаем, если он не меньше маски.
    if (d.area >= maskArea) continue;
    return d.name;
  }
  return null;
}

// Собрать замкнутые кольца из набора way-фрагментов, сшивая по общим концам.
function stitchRings(members, isMatch) {
  const segs = [];
  for (const m of members ?? []) {
    if (m.type === 'way' && isMatch(m.role) && m.geometry && m.geometry.length >= 2) {
      segs.push(m.geometry.map((p) => [p.lon, p.lat]));
    }
  }
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const rings = [];
  while (segs.length) {
    let ring = segs.pop();
    let extended = true;
    while (extended) {
      extended = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (key(s[0]) === key(end)) {
          ring = ring.concat(s.slice(1));
          segs.splice(i, 1);
          extended = true;
          break;
        }
        if (key(s[s.length - 1]) === key(end)) {
          ring = ring.concat(s.slice(0, -1).reverse());
          segs.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    if (key(ring[0]) !== key(ring[ring.length - 1])) ring.push(ring[0]);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function relationRings(rel, role) {
  const isMatch =
    role === 'inner'
      ? (r) => r === 'inner'
      : (r) => r === 'outer' || r === '' || r == null;
  return stitchRings(rel.members, isMatch);
}

// Площадь колец (формула площади Гаусса) — для сортировки полигонов
// от меньших к большим: вложенный малый район перебивает большой.
function areaOfRings(rings) {
  let area = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
  }
  return Math.abs(area) / 2;
}

// Полигоны районов из raw-ответа Overpass: без геометрии — пропускаем,
// сортируем по площади (меньше = точнее, вложенный район выигрывает).
// Собственно районы (relation с place=city_district/district/borough либо
// с «район»/«аудан» в имени) идут в districts; всё остальное (городские
// администрации «городская администрация X»/«X Г.А.», города уровня lvl 6
// «Алатау», «Конаев») — в masks: они не районы, но гасят накрывающие их
// районы областей.
function buildDistrictPolys(rawDistricts) {
  const polys = [];
  const masks = [];
  const list = [];
  for (const rel of rawDistricts) {
    const tags = rel.tags ?? {};
    const name = tags['name:ru'] || tags.name || tags['name:kk'];
    if (!name) continue;
    const place = tags.place ?? '';
    const hay = `${name} ${tags['name:kk'] ?? ''} ${tags.name ?? ''}`.toLowerCase();
    const isDistrict =
      /^(city_district|district|borough)$/.test(place) ||
      hay.includes('район') ||
      hay.includes('аудан');
    const outers = relationRings(rel, 'outer');
    if (outers.length) {
      const inners = relationRings(rel, 'inner');
      const area = areaOfRings(outers);
      if (isDistrict) polys.push({ name, outers, inners, area });
      else masks.push({ name, outers, inners, area });
    }
    if (isDistrict) {
      list.push({
        name,
        name_ru: tags['name:ru'] ?? null,
        name_kk: tags['name:kk'] ?? null,
        admin_level: tags.admin_level ?? null,
        osm_id: rel.id,
      });
    }
  }
  polys.sort((a, b) => a.area - b.area);
  return { polys, masks, list };
}

async function fetchAndStore(city, cache, opts = {}) {
  const districtsOnly = Boolean(opts.districtsOnly);
  if (!cache[city]) {
    const info = await nominatimBbox(city);
    if (!info) {
      console.error(`[warn] Nominatim не нашёл ${city}`);
      return;
    }
    cache[city] = info;
    fs.writeFileSync(path.join(OUT_DIR, '_cities.json'), JSON.stringify(cache, null, 1), 'utf8');
    await sleep(1200);
  }
  const info = cache[city];
  console.log(`[fetch] ${city} bbox=${info.bbox.join(',')} ...`);

  const qDistricts = `[out:json][timeout:180];
(
  relation["boundary"="administrative"]["admin_level"="6"](${info.bbox.join(',')});
  relation["place"~"^(city_district|district|borough)$"](${info.bbox.join(',')});
);
out geom;`;
  const districtsRaw = (await overpass(qDistricts)).elements ?? [];
  const { polys: districtPolys, masks: districtMasks, list: districtList } = buildDistrictPolys(districtsRaw);

  let streets;
  let places;

  if (districtsOnly) {
    // Только переразметка district у уже сохранённых улиц/мест.
    const outPath = path.join(OUT_DIR, `${city}.json`);
    if (!fs.existsSync(outPath)) {
      console.error(`[warn] ${city}: нет сохранённого файла, --districts-only невозможен`);
      return;
    }
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    streets = (prev.streets ?? []).map((s) => ({ ...s, district: districtOf(districtPolys, districtMasks, s.lon, s.lat) }));
    places = (prev.places ?? []).map((p) => ({ ...p, district: districtOf(districtPolys, districtMasks, p.lon, p.lat) }));
  } else {
    await sleep(2000);
    const qStreets = `[out:json][timeout:300];
(
  way["highway"]["name"](${info.bbox.join(',')});
);
out tags center;`;

    const qPlaces = `[out:json][timeout:300];
(
  node["place"~"^(suburb|neighbourhood|quarter|city_district|village|town|hamlet|residential)$"](${info.bbox.join(',')});
  way["place"~"^(suburb|neighbourhood|quarter|residential)$"](${info.bbox.join(',')});
  node["landuse"="residential"]["name"](${info.bbox.join(',')});
  way["landuse"="residential"]["name"](${info.bbox.join(',')});
);
out tags center;`;

    const streetsRaw = (await overpass(qStreets)).elements ?? [];
    await sleep(2000);
    const placesRaw = (await overpass(qPlaces)).elements ?? [];
    await sleep(2000);

    streets = [];
    for (const st of streetsRaw) {
      const tags = st.tags ?? {};
      const c = st.center ?? {};
      if (!tags.name || c.lat == null) continue;
      streets.push({
        name: tags.name,
        name_ru: tags['name:ru'] ?? null,
        name_kk: tags['name:kk'] ?? null,
        lat: c.lat,
        lon: c.lon,
        district: districtOf(districtPolys, districtMasks, c.lon, c.lat),
        highway: tags.highway ?? null,
        osm_id: st.id,
      });
    }

    places = [];
    for (const pl of placesRaw) {
      const tags = pl.tags ?? {};
      const c = pl.center ?? {};
      const lat = pl.lat ?? c.lat;
      const lon = pl.lon ?? c.lon;
      if (!tags.name || lat == null) continue;
      places.push({
        name: tags.name,
        name_ru: tags['name:ru'] ?? null,
        name_kk: tags['name:kk'] ?? null,
        place: tags.place ?? (tags.landuse === 'residential' ? 'residential' : null),
        lat,
        lon,
        district: districtOf(districtPolys, districtMasks, lon, lat),
        osm_id: pl.id,
      });
    }
  }

  const result = {
    city,
    bbox: info.bbox,
    fetchedAt: new Date().toISOString(),
    districts: districtList,
    streets,
    places,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${city}.json`), JSON.stringify(result), 'utf8');
  const withD = streets.filter((s) => s.district).length;
  const withDP = places.filter((p) => p.district).length;
  console.log(
    `[ok] ${city}: улиц=${streets.length} (с районом ${withD}), мест/мкр=${places.length} (с районом ${withDP}), ` +
      `районов=${districtList.length}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const districtsOnly = args.includes('--districts-only');
  const ci = args.indexOf('--cities');
  const cities = (ci >= 0 ? args[ci + 1] : DEFAULT_CITIES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cachePath = path.join(OUT_DIR, '_cities.json');
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

  for (const city of cities) {
    const outPath = path.join(OUT_DIR, `${city}.json`);
    if (!districtsOnly && !force && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      console.log(`[skip] ${city}: уже есть ${path.relative(ROOT, outPath)}`);
      continue;
    }
    try {
      await fetchAndStore(city, cache, { districtsOnly });
    } catch (e) {
      console.error(`[error] ${city}: ${e.message}`);
    }
  }
  console.log(districtsOnly ? '[done] районы переразмечены' : '[done] OSM справочник собран');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
