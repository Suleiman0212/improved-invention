// Публичный вход разбора: парсер (parseFields) + восстановление полей по КАТО.
//
// Парсер и справочник намеренно разделены:
//   src/parser.js   — только текст -> поля (без справочника);
//   src/resolver.js — дозаполнение province/city/district по КАТО.
// Здесь они соединяются в один вызов parseAddress(raw, options).

import { parseFields } from './parser.js';
import { resolveMissing } from './resolver.js';

export function parseAddress(raw, options = {}) {
  const fields = parseFields(raw);

  if (options.reference === false) {
    return { ...fields };
  }

  // options.reference === undefined|true -> справочник по умолчанию;
  // options.reference === объект        -> использовать его как справочник.
  const ref = options.reference === true ? undefined : options.reference;
  return resolveMissing(raw, fields, ref);
}
