import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { localDateKey, dateFromKey, monthCells, moveMonth, dailyMood, journalIndex } from '../src/journal.js';
import { calendarPage } from '../src/calendar.js';

test('calendar validates civil dates and clamps month changes across leap years', () => {
  assert.equal(dateFromKey('2025-02-29'), null);
  assert.equal(dateFromKey('2024-13-01'), null);
  assert.equal(moveMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(moveMonth('2025-03-31', -1), '2025-02-28');
  assert.equal(moveMonth('2025-12-31', 1), '2026-01-31');
  assert.equal(moveMonth('2026-01-31', -1), '2025-12-31');
  const cells = monthCells('2024-02');
  assert.equal(cells.length, 42);
  assert.equal(dateFromKey(cells[0]).getDay(), 1);
  assert.equal(new Set(cells).size, 42);
  assert.equal(cells.filter(key => key.startsWith('2024-02')).length, 29);
});

test('local date grouping agrees at midnight and during DST', () => {
  const url = new URL('../src/journal.js', import.meta.url).href;
  for (const [tz, instants, expected] of [
    ['Asia/Shanghai', ['2026-10-11T15:59:59Z','2026-10-11T16:00:00Z'], ['2026-10-11','2026-10-12']],
    ['America/New_York', ['2026-03-08T06:59:59Z','2026-03-08T07:00:00Z'], ['2026-03-08','2026-03-08']],
    ['America/New_York', ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'], ['2026-11-01','2026-11-01']],
  ]) {
    const result = execFileSync(process.execPath, ['--input-type=module','-e', `import {localDateKey,monthCells} from ${JSON.stringify(url)}; console.log(JSON.stringify({keys:${JSON.stringify(instants)}.map(localDateKey),days:new Set(monthCells('2026-03')).size}));`], {env:{...process.env,TZ:tz},encoding:'utf8',windowsHide:true});
    assert.deepEqual(JSON.parse(result), {keys:expected,days:42});
  }
});

test('implicit neutral stays distinct from confirmed neutral and never mutates the store', () => {
  const entries = [{date:'2026-10-11',mood:'low',at:'2026-10-11T01:00:00Z'}];
  assert.deepEqual(dailyMood(entries,'2026-10-12'),{mood:'okay',recorded:false,at:null});
  assert.equal(entries.length,1);
  assert.equal(dailyMood([{date:'2026-10-12',mood:'okay',at:'2026-10-12T01:00:00Z'}],'2026-10-12').recorded,true);
});

test('journal contains every actual dose, including record-only medications and labs of any analyte', () => {
  const date='2024-02-29', at=new Date(`${date}T12:00:00`).toISOString();
  const state={doses:Array.from({length:205},(_,i)=>({id:`dose-${i}`,routeId:i%2?'e2-ev-sublingual':'t-undecanoate-im',amount:1,at})),labs:[{id:'lab-t',analyte:'testosterone',value:350,unit:'ng/dL',at}],dailyMoods:[],plans:[{startAt:at}]};
  state.doses.push({id:'adjacent',routeId:'e2-oral',amount:1,at:new Date('2024-03-01T00:00:00').toISOString()});
  const index=journalIndex(state);
  assert.equal(index.get(date).doses.length,205);
  assert.equal(index.get(date).labs.length,1);
  const html=calendarPage(state,date);
  assert.equal((html.match(/data-dose-id=/g)||[]).length,205);
  assert.equal((html.match(/data-lab-id=/g)||[]).length,1);
  assert.match(html,/补佳乐/);
  assert.match(html,/总睾酮 T/);
  assert.doesNotMatch(html,/data-dose-id="adjacent"/);
  assert.equal(localDateKey('bad-date'),null);
});

test('journal orders day records by actual time and safely renders labels', () => {
  const state={doses:[{id:'late',routeId:'<img src=x>',amount:1,at:'2024-03-04T15:00:00'},{id:'early',routeId:'e2-oral',amount:1,at:'2024-03-04T01:00:00'}]};
  assert.deepEqual(journalIndex(state).get('2024-03-04').doses.map(item=>item.id),['early','late']);
  const html=calendarPage(state,'2024-03-04');
  assert.match(html,/&lt;img src=x&gt;/);
  assert.doesNotMatch(html,/<img src=x>/);
});
