// Calendar keys use the device's local civil day, never a UTC date or a rolling 24 hours.
export function localDateKey(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateFromKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(`${key}T12:00:00`);
  return localDateKey(date) === key ? date : null;
}

export function moveMonth(key, offset) {
  const date = dateFromKey(key);
  if (!date || !Number.isInteger(offset)) return null;
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, end));
  return localDateKey(date);
}

export function monthCells(month) {
  const first = dateFromKey(`${month}-01`);
  if (!first) return [];
  first.setDate(1 - (first.getDay() + 6) % 7);
  return Array.from({length: 42}, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    return localDateKey(date);
  });
}

export function dailyMood(records, date = localDateKey()) {
  const record = (records || []).find(item => item.date === date && ['good', 'okay', 'low'].includes(item.mood));
  return {mood: record?.mood || 'okay', recorded: Boolean(record), at: record?.at || null};
}

export function journalIndex(state) {
  const index = new Map();
  for (const kind of ['doses', 'labs']) for (const record of state[kind] || []) {
    const key = localDateKey(record.at);
    if (!key) continue;
    if (!index.has(key)) index.set(key, {doses: [], labs: []});
    index.get(key)[kind].push(record);
  }
  for (const entry of index.values()) for (const kind of ['doses', 'labs']) {
    entry[kind].sort((a, b) => new Date(a.at) - new Date(b.at));
  }
  return index;
}
