// Нормализация входной строки и обработка двуязычных склеек через «/».

import { TYPO_FIXES, LWORD, KZ_ONLY } from './lexicon.js';

const INVISIBLE = /[\u00A0\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g;
const KZ_ONLY_RE = new RegExp(`[${KZ_ONLY}]`, 'i');

export function normalize(raw) {
  let s = String(raw ?? '');
  s = s.normalize('NFKC');
  s = s.replace(INVISIBLE, ' ');
  s = s.replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"');
  s = s.replace(/[–—−]/g, '-');
  s = s.replace(/\s+/g, ' ').trim();
  for (const [re, rep] of TYPO_FIXES) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// «город Актобе/Актөбе қаласы» → оставляем русскую половину.
// Также поддержаны варианты, где казахская половина идёт первой.
export function resolveBilingual(input) {
  let s = input;

  // Быстрый выход: без «/» двуязычных склеек нет (защита от квадратичного
  // перебора альтернатив LWORD на длинных строках без слэша).
  if (!s.includes('/')) return s;

  // <ru>/<kk> қаласы|ауданы|қ.
  s = s.replace(
    new RegExp(`(${LWORD})\\s*/\\s*${LWORD}\\s*(?:қаласы|қ\\.|ауданы|аудан\\.?)`, 'giu'),
    '$1',
  );

  // <kk> қаласы/<ru>
  s = s.replace(
    new RegExp(`${LWORD}\\s*(?:қаласы|қ\\.)\\s*/\\s*(${LWORD})`, 'giu'),
    '$1',
  );

  // Общий случай: если одна половина содержит казахские буквы, а другая нет —
  // оставляем «русскую» половину.
  s = s.replace(
    new RegExp(`(${LWORD})\\s*/\\s*(${LWORD})`, 'gu'),
    (whole, a, b) => {
      const aKz = KZ_ONLY_RE.test(a);
      const bKz = KZ_ONLY_RE.test(b);
      if (aKz && !bKz) return b;
      if (bKz && !aKz) return a;
      return a;
    },
  );

  return s;
}
