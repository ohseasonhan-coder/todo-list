import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, foldLine } from '../src/ics.js';

test('long Korean lines fold at 75 bytes without splitting characters', () => {
  const line = `SUMMARY:${'아주 긴 할 일 제목입니다 '.repeat(8)}`;
  const folded = foldLine(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  for (const [i, p] of parts.entries()) {
    assert.ok(Buffer.byteLength(p) <= 75, `line ${i} is ${Buffer.byteLength(p)} bytes`);
    if (i > 0) assert.equal(p[0], ' ');
  }
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), line);
});

test('calendar has all-day and timed events with escaped text', () => {
  const ics = buildCalendar([
    { uid: 'a@2026-10-24', title: '⭐ 치과, 오후', allDay: false, start: Date.UTC(2026, 9, 24, 6, 0), minutes: 30, note: '보험증;지참' },
    { uid: 'b@2026-10-25', title: '장보기', allDay: true, date: '2026-10-25' },
  ], Date.UTC(2026, 9, 23, 7, 0));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261024T060000Z\r\nDTEND:20261024T063000Z/);
  assert.match(ics, /SUMMARY:⭐ 치과\\, 오후/);
  assert.match(ics, /DESCRIPTION:보험증\\;지참/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261025\r\nDTEND;VALUE=DATE:20261026/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});
