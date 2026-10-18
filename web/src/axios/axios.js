import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

export async function parseAddress(rawAddress) {
  const res = await api.post('/parse', { raw_address: rawAddress });
  return res.data;
}

export async function batchAddress(jsonArray) {
  const res = await api.post('/parse/batch', jsonArray);
  return res.data;
}

export async function sendFile(file) {
  const text = (await file.text()).trim();
  if (!text) throw new Error('Файл пустой');

  let records;
  try {
    records = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    try {
      records = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error('Файл должен содержать JSON или JSONL с одной JSON-записью на строку');
    }
  }

  return batchAddress(records);
}