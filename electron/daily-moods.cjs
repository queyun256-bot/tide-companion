'use strict';

const MOODS = new Set(['good', 'okay', 'low']);
const MAX_DAILY_MOODS = 40000;

function fail(label) { throw new Error(`数据格式不正确：${label}`); }

// A diary day follows the local calendar. UTC slicing would move early-morning
// entries into yesterday in positive UTC offsets (and late entries into tomorrow
// in negative offsets).
function localDayKey(value = new Date()) {
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) fail('心情日期');
  return `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('心情日期');
  const [year, month, day] = value.split('-').map(Number);
  const checked = new Date(0);
  checked.setUTCFullYear(year, month - 1, day);
  checked.setUTCHours(0, 0, 0, 0);
  if (year < 1 || checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) fail('心情日期');
  return value;
}

function validateDailyMoods(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_DAILY_MOODS) fail('每日心情');
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype) fail('每日心情');
    const date = calendarDate(entry.date);
    if (seen.has(date)) fail('每日心情存在重复日期');
    seen.add(date);
    if (!MOODS.has(entry.mood)) fail('每日心情选项');
    const at = entry.at;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) fail('心情记录时间');
    calendarDate(at.slice(0, 10));
    return { date, mood: entry.mood, at: new Date(at).toISOString() };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function migrateDailyMoods(events, now = Date.now()) {
  const days = new Map();
  for (const event of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const mood = event.action?.startsWith('mood-') ? event.action.slice(5) : '';
    const time = Date.parse(event.at);
    if (!MOODS.has(mood) || !Number.isFinite(time) || time > now) continue;
    const date = localDayKey(time);
    if (!days.has(date)) days.set(date, { date, mood, at: new Date(time).toISOString() });
  }
  return [...days.values()];
}

function appendDailyMood(entries, event) {
  if (!event.action.startsWith('mood-')) return entries;
  const mood = event.action.slice(5);
  if (!MOODS.has(mood)) fail('每日心情选项');
  const date = localDayKey(event.at);
  if (entries.some((entry) => entry.date === date)) throw new Error('今天的心情已经记下了，明天再来写一笔吧。');
  if (entries.length >= MAX_DAILY_MOODS) throw new Error('心情记录已达到本机容量上限，请先导出备份。');
  return [...entries, { date, mood, at: event.at }];
}

function restoreDailyMoods(imported, current, now = Date.now()) {
  const today = localDayKey(now);
  const existing = current.find((entry) => entry.date === today);
  // Backup restore is explicit, but must not become a way to choose today's
  // mood twice. Historical entries follow the selected backup.
  return existing ? [...imported.filter((entry) => entry.date !== today), existing] : imported;
}

module.exports = { localDayKey, validateDailyMoods, migrateDailyMoods, appendDailyMood, restoreDailyMoods, MAX_DAILY_MOODS };
