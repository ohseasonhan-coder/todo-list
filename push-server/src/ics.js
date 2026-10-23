// 캘린더 구독용 iCalendar(.ics) 만들기 (RFC 5545)

export function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
}

// 한 줄은 75바이트까지, 넘으면 줄바꿈 + 공백으로 이어 씀 (한글이 깨지지 않게 글자 단위로 자름)
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const icsUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (d) => d.replace(/-/g, '');
function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** events: [{ uid, title, note, allDay, date } | { uid, title, note, allDay: false, start(ms), minutes }] */
export function buildCalendar(events, updatedAt) {
  const stamp = icsUtc(updatedAt);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//to do list//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:to do list', 'X-WR-TIMEZONE:Asia/Seoul', 'X-APPLE-CALENDAR-COLOR:#4F6BFF',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${icsText(e.uid)}@todo-list`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(e.title)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(e.date))}`);
    else lines.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(e.start + e.minutes * 60000)}`);
    if (e.note) lines.push(`DESCRIPTION:${icsText(e.note)}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
