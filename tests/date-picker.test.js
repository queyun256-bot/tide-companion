import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePickerValue,pickerMonthCells,localPickerValue} from '../src/date-picker.js';

test('date picker accepts exact local minutes and rejects impossible civil dates', () => {
  assert.equal(parsePickerValue('2024-02-29 09:07').value,'2024-02-29T09:07');
  for (const value of ['2023-02-29T12:00','2024-02-30T12:00','2024-04-31T00:00','2024-01-01T24:00','2024-01-01T12:60','2024-13-01T12:00','2024-01-00T12:00','2024-01-01T-1:00']) assert.equal(parsePickerValue(value),null,value);
  assert.equal(parsePickerValue('2000-02-29','date').value,'2000-02-29');
  assert.equal(parsePickerValue('1900-02-29','date'),null);
  assert.equal(parsePickerValue('0000-01','month'),null);
  assert.equal(parsePickerValue('0100-02-29','date'),null);
});
test('month calendar stays Monday-first across year and leap-day boundaries', () => {
  const january = pickerMonthCells(2026,1);
  assert.equal(january.length,42);
  assert.equal(january[0],'2025-12-29');
  assert.equal(january.at(-1),'2026-02-08');
  assert.equal(new Set(january).size,42);
  assert.ok(pickerMonthCells(2024,2).includes('2024-02-29'));
  assert.ok(!pickerMonthCells(2023,2).includes('2023-02-29'));
});
test('local defaults read local fields instead of converting to UTC', () => {
  const date = new Date(2026,9,12,0,7);
  assert.equal(localPickerValue('datetime-local',date),'2026-10-12T00:07');
  assert.equal(localPickerValue('date',date),'2026-10-12');
  assert.equal(localPickerValue('month',date),'2026-10');
});
