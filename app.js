// to do list — 로컬 저장 + 정해진 시각 알림을 지원하는 가벼운 할 일 앱

const STORE_KEY = 'todo.v1';
const SETTINGS_KEY = 'todo.settings.v1';
const VIEW_KEY = 'todo.view';
const DEVICE_KEY = 'todo.device';
// 푸시·AI 서버 (Cloudflare Worker). 비어 있으면 서버 기능 없이 동작
const API_BASE = 'https://todo-push.ohseasonhan.workers.dev';
const SNOOZE_MIN = 10;
const MISSED_WINDOW = 6 * 3600e3; // 이보다 오래 지난 알림은 조용히 넘김

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------------- storage ---------------- */

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 환경 */ }
}

let tasks = safeGet(STORE_KEY, []);
let settings = { defaultTime: '09:00', briefOn: true, briefTime: '08:00', ...safeGet(SETTINGS_KEY, {}) };
let view = safeGet(VIEW_KEY, 'today');
if (!['today', 'upcoming', 'all', 'done'].includes(view)) view = 'today';

function save() {
  stampChanges();
  safeSet(STORE_KEY, tasks);
  scheduleReminders();
  queuePushSync();
  queueDataSync();
  queueFeedPublish();
}

/* ---------------- 변경 기록 (동기화용) ---------------- */
// 할 일마다 updatedAt을 찍고, 지운 할 일은 tombs에 남겨서 기기끼리 합칠 때 씀

const SYNC_KEY = 'todo.sync.v1';
let syncMeta = { code: null, version: 0, lastSync: 0, tombs: {}, ...safeGet(SYNC_KEY, {}) };
const taskSig = (x) => JSON.stringify({ ...x, notifiedKey: undefined, updatedAt: undefined });
let sigMap = new Map(tasks.map((x) => [x.id, taskSig(x)]));

function stampChanges() {
  const now = Date.now();
  const seen = new Set();
  for (const x of tasks) {
    seen.add(x.id);
    const s = taskSig(x);
    if (sigMap.get(x.id) !== s) {
      x.updatedAt = now;
      sigMap.set(x.id, s);
      delete syncMeta.tombs[x.id];
    }
  }
  for (const id of [...sigMap.keys()]) {
    if (!seen.has(id)) { sigMap.delete(id); syncMeta.tombs[id] = now; }
  }
  safeSet(SYNC_KEY, syncMeta);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let deviceId = safeGet(DEVICE_KEY, null);
if (!deviceId) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  deviceId = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  safeSet(DEVICE_KEY, deviceId);
}
const findTask = (id) => tasks.find((t) => t.id === id);

/* ---------------- dates ---------------- */

const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayStr = () => ymd(new Date());
const at = (dateStr, timeStr) => {
  const d = parseYmd(dateStr);
  const [h, m] = timeStr.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

function dateLabel(s, withWeekday = true) {
  const t = todayStr();
  if (s === t) return '오늘';
  if (s === addDays(t, 1)) return '내일';
  if (s === addDays(t, 2)) return '모레';
  if (s === addDays(t, -1)) return '어제';
  const d = parseYmd(s);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}년 `;
  return `${year}${d.getMonth() + 1}월 ${d.getDate()}일${withWeekday ? ` (${WD[d.getDay()]})` : ''}`;
}
function timeLabel(t) {
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? '오전' : '오후';
  const h12 = h % 12 || 12;
  return m ? `${ap} ${h12}:${pad(m)}` : `${ap} ${h12}시`;
}
function mondayOf(dateStr) {
  const d = parseYmd(dateStr);
  return addDays(dateStr, -((d.getDay() + 6) % 7));
}

const REMIND_LABEL = { 0: '정시', 5: '5분 전', 10: '10분 전', 30: '30분 전', 60: '1시간 전', 1440: '하루 전' };
const dow = (dateStr) => parseYmd(dateStr).getDay();
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월요일부터

// "🔁 월·수·금 · 12월 31일까지" 같은 반복 설명
function repeatLabel(x) {
  if (!x.repeat || x.repeat === 'none') return '';
  let base;
  if (x.repeat === 'daily') base = '매일';
  else if (x.repeat === 'weekdays') base = '평일';
  else if (x.repeat === 'monthly') base = `매월 ${x.anchorDay || (x.due ? parseYmd(x.due).getDate() : '')}일`;
  else {
    const days = x.repeatDays?.length ? x.repeatDays : x.due ? [dow(x.due)] : [];
    const key = [...days].sort().join('');
    base = key === '0123456' ? '매일' : key === '12345' ? '평일' : key === '06' ? '주말'
      : `매주 ${WEEK_ORDER.filter((d) => days.includes(d)).map((d) => WD[d]).join('·')}`;
  }
  return x.repeatUntil ? `${base} · ${dateLabel(x.repeatUntil, false)}까지` : base;
}

// 반복 규칙 정리: 예전 '평일'은 요일 선택으로 바꾸고, 시작일을 고른 요일에 맞춤
function normalizeRepeat(x) {
  if (x.repeat === 'weekdays') { x.repeat = 'weekly'; x.repeatDays = [1, 2, 3, 4, 5]; }
  // 몇 시간마다는 하루 단위 반복 위에서 돌아감 (반복이 없으면 매일)
  const every = Math.round(Number(x.everyHours) || 0);
  if (every >= 1 && every <= 12) {
    x.everyHours = every;
    if (!x.repeat || x.repeat === 'none') x.repeat = 'daily';
    x.time = x.time || '09:00';
    x.endTime = x.endTime || '21:00';
    if (toMin(x.endTime) < toMin(x.time)) x.endTime = '23:59';
  } else {
    x.everyHours = null;
    x.endTime = null;
  }
  if (!x.repeat || x.repeat === 'none') { x.repeatDays = null; x.repeatUntil = null; return x; }
  if (x.repeat !== 'weekly') x.repeatDays = null;
  if (!x.due) x.due = todayStr();
  if (x.repeat === 'weekly') {
    if (!x.repeatDays?.length) x.repeatDays = [dow(x.due)];
    x.repeatDays = [...new Set(x.repeatDays.map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    while (!x.repeatDays.includes(dow(x.due))) x.due = addDays(x.due, 1);
  }
  if (x.repeat === 'monthly') x.anchorDay = x.anchorDay || parseYmd(x.due).getDate();
  else x.anchorDay = null;
  if (x.repeatUntil && !/^\d{4}-\d{2}-\d{2}$/.test(x.repeatUntil)) x.repeatUntil = null;
  return x;
}

// 종료일이 지난 루틴은 끝난 것으로 처리 (true면 이번에 끝남)
function endRoutineIfOver(x) {
  if (x.done || !x.repeat || x.repeat === 'none' || !x.repeatUntil || !x.due || x.due <= x.repeatUntil) return false;
  x.done = true;
  x.doneAt = Date.now();
  x.snoozeUntil = null;
  x.pausedUntil = null;
  x.pauseFrom = null;
  return true;
}
const withinUntil = (x, d) => !x.repeatUntil || d <= x.repeatUntil;

function stepRepeat(dateStr, repeat, anchorDay, days) {
  switch (repeat) {
    case 'daily': return addDays(dateStr, 1);
    case 'weekdays': {
      let n = addDays(dateStr, 1);
      while ([0, 6].includes(parseYmd(n).getDay())) n = addDays(n, 1);
      return n;
    }
    case 'weekly': {
      if (!days?.length) return addDays(dateStr, 7);
      let n = addDays(dateStr, 1);
      for (let i = 0; i < 7 && !days.includes(dow(n)); i++) n = addDays(n, 1);
      return n;
    }
    case 'monthly': {
      const d = parseYmd(dateStr);
      const day = anchorDay || d.getDate();
      const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate();
      return ymd(new Date(d.getFullYear(), d.getMonth() + 1, Math.min(day, last)));
    }
    default: return dateStr;
  }
}
function nextDue(task) {
  const t = todayStr();
  let n = stepRepeat(task.due, task.repeat, task.anchorDay, task.repeatDays);
  while (n < t) n = stepRepeat(n, task.repeat, task.anchorDay, task.repeatDays);
  return n;
}

/* ---------------- 루틴 일시정지 ---------------- */

const isRoutine = (x) => !x.done && x.repeat && x.repeat !== 'none' && x.due;
const isPaused = (x) => !!x.pausedUntil && x.pausedUntil > todayStr();

// start부터 반복 규칙대로 넘겨 target 이후 첫 날짜를 찾음
function firstOnOrAfter(task, start, target) {
  let n = start;
  while (n < target) n = stepRepeat(n, task.repeat, task.anchorDay, task.repeatDays);
  return n;
}
function pauseTask(x, until) {
  if (!isRoutine(x)) return false;
  if (!x.pausedUntil) x.pauseFrom = x.due;
  x.pausedUntil = until;
  x.due = firstOnOrAfter(x, x.pauseFrom || x.due, until);
  x.snoozeUntil = null;
  endRoutineIfOver(x);
  settleReminder(x);
  return true;
}
function resumeTask(x) {
  if (!x.pausedUntil) return false;
  x.due = firstOnOrAfter(x, x.pauseFrom || x.due, todayStr());
  x.pausedUntil = null;
  x.pauseFrom = null;
  settleReminder(x);
  return true;
}
// 재개 날짜가 지나면 표시만 정리
function clearExpiredPauses() {
  let changed = false;
  for (const x of tasks) {
    if (x.pausedUntil && x.pausedUntil <= todayStr()) { x.pausedUntil = null; x.pauseFrom = null; changed = true; }
  }
  return changed;
}

/* ---------------- reminders: 시각 계산 ---------------- */

function fireTime(task) {
  if (task.done || !task.due) return null;
  if (task.snoozeUntil) return task.snoozeUntil; // 미루기·10분 뒤는 알림 설정과 상관없이 울림
  if (task.remind == null) return null;
  if (task.everyHours) {
    // 몇 시간마다: 마지막으로 알린 회차 다음 회차
    const last = Number(task.notifiedKey) || 0;
    return hourlySlots(task).map((s) => at(task.due, s)).find((f) => f > last) ?? null;
  }
  const base = at(task.due, task.time || settings.defaultTime);
  return base - task.remind * 60000;
}
// 이미 지난 알림 시각으로 저장하면 곧바로 울리지 않도록 처리
function settleReminder(task) {
  if (task.everyHours && !task.snoozeUntil) {
    const past = task.due ? hourlySlots(task).map((s) => at(task.due, s)).filter((f) => f <= Date.now()) : [];
    task.notifiedKey = past.length ? String(past.at(-1)) : null;
    return;
  }
  const f = fireTime(task);
  task.notifiedKey = f != null && f <= Date.now() ? String(f) : null;
}

/* ---------------- 몇 시간마다 ---------------- */
// time = 시작, endTime = 끝, everyHours = 간격. 하루에 여러 번 (예: 9시~21시 2시간마다 → 7번)

const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const fromMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
function hourlySlots(x) {
  if (!x.everyHours) return x.time ? [x.time] : [];
  const start = toMin(x.time || '09:00');
  const end = toMin(x.endTime || '21:00');
  const slots = [];
  for (let m = start; m <= end && slots.length < 24; m += x.everyHours * 60) slots.push(fromMin(m));
  return slots;
}
const slotCountToday = (x) => (x.slotDate === x.due ? x.slotCount || 0 : 0);

// 몇 시간마다 할 일의 표시 아이콘 (직접 고를 수 있고, 안 고르면 제목으로 추측)
const ICON_CHOICES = ['💧', '💊', '🧘', '💪', '🚶', '👀', '☕', '📖', '🧹', '🍎', '🦷', '⏰'];
function guessIcon(title = '') {
  const rules = [
    [/물|수분/, '💧'], [/약|영양제|비타민|유산균/, '💊'], [/스트레칭|요가|명상|호흡/, '🧘'],
    [/운동|팔굽|스쿼트|헬스|플랭크/, '💪'], [/걷|산책|일어나|만보|계단/, '🚶'], [/눈/, '👀'],
    [/커피|차 마시/, '☕'], [/독서|책|공부|단어|암기/, '📖'], [/청소|정리|환기/, '🧹'],
    [/과일|간식|식사|밥/, '🍎'], [/양치|치실/, '🦷'],
  ];
  return rules.find(([re]) => re.test(title))?.[1] || '⏰';
}
const iconOf = (x) => x.icon || guessIcon(x.title);
function firstGrapheme(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter().segment(v)][0]?.segment || '';
  return Array.from(v).slice(0, 2).join('');
}
function nextSlotToday(x) {
  if (!x.due || x.due !== todayStr()) return null;
  const now = Date.now();
  return hourlySlots(x).find((s) => at(x.due, s) > now) || null;
}
function hourlyLabel(x) {
  return `${timeLabel(x.time || '09:00')}~${timeLabel(x.endTime || '21:00')} · ${x.everyHours}시간마다`;
}

/* ---------------- 자연어 빠른 입력 ---------------- */

const WD_RE = '([월화수목금토일])요일';
const PARTICLE = '(?:에|까지|부터|에는|엔)?';
const END = '(?=\\s)';

function upcomingWeekday(idx) {
  const t = todayStr();
  const diff = (idx - new Date().getDay() + 7) % 7;
  return addDays(t, diff);
}

function parseQuick(raw) {
  let s = ` ${raw} `;
  const out = { title: '', due: null, time: null, repeat: 'none', important: false, anchorDay: null, repeatDays: null, repeatUntil: null };
  const t = todayStr();
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    if (fn(m) === false) return false;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return true;
  };
  // "월수금", "월,수,금", "월요일 수요일" → [1,3,5]
  const DAYSEQ = '((?:[월화수목금토일](?:요일)?\\s?[,·/]?\\s?)*[월화수목금토일](?:요일)?)';
  const parseDays = (str) => [...new Set([...str.replace(/요일/g, '')].map((c) => WD.indexOf(c)).filter((i) => i >= 0))];
  const setWeekly = (days) => {
    out.repeat = 'weekly';
    out.repeatDays = days;
    let d = t;
    while (!days.includes(dow(d))) d = addDays(d, 1);
    out.due = d;
  };

  // 반복
  take(new RegExp(`\\s(?:매주\\s?${DAYSEQ}(?:마다)?|${DAYSEQ}마다)${PARTICLE}${END}`), (m) => {
    const days = parseDays(m[1] || m[2]);
    if (!days.length) return false;
    setWeekly(days);
  }) ||
  // "월수금 7시 운동", "월,수,금"처럼 요일을 두 개 이상 나열하면 반복으로 봄 (금일·수금 같은 낱말은 제외)
  take(new RegExp(`\\s${DAYSEQ}${PARTICLE}${END}`), (m) => {
    const token = m[1].replace(/\s/g, '');
    if (['금일', '수금', '일일', '월일', '일월'].includes(token)) return false;
    const days = parseDays(m[1]);
    if (days.length < 2) return false;
    setWeekly(days);
  }) ||
  take(new RegExp(`\\s(?:매주\\s?)?주말(?:마다)${PARTICLE}${END}`), () => setWeekly([0, 6])) ||
  take(new RegExp(`\\s(?:매달|매월)\\s?(\\d{1,2})일${PARTICLE}${END}`), (m) => {
    const day = +m[1];
    if (day < 1 || day > 31) return false;
    out.repeat = 'monthly';
    out.anchorDay = day;
    const now = new Date();
    let d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()));
    if (ymd(d) < t) d = new Date(now.getFullYear(), now.getMonth() + 1, Math.min(day, new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate()));
    out.due = ymd(d);
  }) ||
  take(new RegExp(`\\s매일(?:마다)?${END}`), () => { out.repeat = 'daily'; }) ||
  take(new RegExp(`\\s(?:매주\\s?)?(?:평일|주중)(?:마다)?${PARTICLE}${END}`), () => setWeekly([1, 2, 3, 4, 5])) ||
  take(new RegExp(`\\s매주(?:마다)?${END}`), () => { out.repeat = 'weekly'; }) ||
  take(new RegExp(`\\s(?:매달|매월)(?:마다)?${END}`), () => { out.repeat = 'monthly'; });

  // 반복 기간: "12월 31일까지", "12/31까지", "2주 동안", "3개월간", "이번 달까지", "연말까지"
  // 몇 시간마다: "2시간마다", "두 시간 간격으로", "매시간" (반복이 없으면 매일)
  const KNUM = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6 };
  take(new RegExp(`\\s(?:(\\d{1,2})|(한|두|세|네|다섯|여섯))\\s?시간\\s?(?:마다|간격(?:으로)?|에\\s?한\\s?번(?:씩)?)${END}`), (m) => {
    const n = m[1] ? +m[1] : KNUM[m[2]];
    if (!n || n > 12) return false;
    out.everyHours = n;
  }) ||
  take(new RegExp(`\\s매\\s?시간(?:마다)?${END}`), () => { out.everyHours = 1; });
  if (out.everyHours && out.repeat === 'none') out.repeat = 'daily';

  if (out.repeat !== 'none') {
    const untilDate = (mo, day) => {
      if (mo < 1 || mo > 12 || day < 1 || day > 31) return false;
      const now = new Date();
      let d = new Date(now.getFullYear(), mo - 1, day);
      if (d.getMonth() !== mo - 1) return false;
      if (ymd(d) < t) d = new Date(now.getFullYear() + 1, mo - 1, day);
      out.repeatUntil = ymd(d);
    };
    const addMonths = (n) => { const d = parseYmd(t); d.setMonth(d.getMonth() + n); d.setDate(d.getDate() - 1); return ymd(d); };
    take(new RegExp(`\\s(\\d{1,2})월\\s?(\\d{1,2})일\\s?까지${END}`), (m) => untilDate(+m[1], +m[2])) ||
    take(new RegExp(`\\s(\\d{1,2})\\s?/\\s?(\\d{1,2})\\s?까지${END}`), (m) => untilDate(+m[1], +m[2])) ||
    take(new RegExp(`\\s(\\d{1,3})\\s?(일|주|개월|달)\\s?(?:동안|간)${END}`), (m) => {
      const n = +m[1];
      if (!n) return false;
      out.repeatUntil = m[2] === '일' ? addDays(t, n - 1) : m[2] === '주' ? addDays(t, n * 7 - 1) : addMonths(n);
    }) ||
    take(new RegExp(`\\s이번\\s?달\\s?(?:까지|동안)${END}`), () => {
      const d = parseYmd(t);
      out.repeatUntil = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    }) ||
    take(new RegExp(`\\s(?:연말|올해|올\\s?연말)\\s?(?:까지|동안)${END}`), () => { out.repeatUntil = `${t.slice(0, 4)}-12-31`; });
  }

  // 날짜
  if (!out.due) {
    take(new RegExp(`\\s(오늘|금일|내일|낼|모레|글피)${PARTICLE}${END}`), (m) => {
      out.due = addDays(t, { 오늘: 0, 금일: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[m[1]]);
    }) ||
    take(new RegExp(`\\s(이번\\s?주|다음\\s?주|담주)?\\s?${WD_RE}${PARTICLE}${END}`), (m) => {
      const idx = WD.indexOf(m[2]);
      if (!m[1]) { out.due = upcomingWeekday(idx); return; }
      const monday = m[1].startsWith('이번') ? mondayOf(t) : addDays(mondayOf(t), 7);
      out.due = addDays(monday, (idx + 6) % 7);
    }) ||
    take(new RegExp(`\\s(?:이번\\s?)?주말${PARTICLE}${END}`), () => { out.due = upcomingWeekday(6); }) ||
    take(new RegExp(`\\s(?:다음\\s?주|담주)${PARTICLE}${END}`), () => { out.due = addDays(mondayOf(t), 7); }) ||
    take(new RegExp(`\\s(\\d{1,2})월\\s?(\\d{1,2})일${PARTICLE}${END}`), (m) => setMonthDay(+m[1], +m[2])) ||
    take(new RegExp(`\\s(\\d{1,2})\\s?/\\s?(\\d{1,2})${PARTICLE}${END}`), (m) => setMonthDay(+m[1], +m[2]));
  }
  function setMonthDay(mo, day) {
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return false;
    const now = new Date();
    let d = new Date(now.getFullYear(), mo - 1, day);
    if (d.getMonth() !== mo - 1) return false;
    if (ymd(d) < t) d = new Date(now.getFullYear() + 1, mo - 1, day);
    out.due = ymd(d);
  }

  const AP = '(오전|오후|아침|낮|점심|저녁|밤|새벽)?\\s?';
  const toHM = (ap, h, mi = 0) => {
    if (h > 24 || mi > 59) return null;
    if (['오후', '저녁', '밤'].includes(ap) && h < 12) h += 12;
    else if (['낮', '점심'].includes(ap) && h <= 6) h += 12;
    else if (['오전', '아침', '새벽'].includes(ap) && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 6) h += 12; // "3시" → 오후 3시
    if (h === 24) h = 0;
    return `${pad(h)}:${pad(mi)}`;
  };

  // 몇 시간마다의 시작~끝: "9시부터 21시까지", "9시~9시"
  if (out.everyHours) {
    take(new RegExp(`\\s${AP}(\\d{1,2})시?\\s?(?:부터|~|-)\\s?${AP}(\\d{1,2})시\\s?(?:까지)?${END}`), (m) => {
      const start = toHM(m[1], +m[2]);
      let end = toHM(m[3], +m[4]);
      if (!start || !end) return false;
      if (!m[3] && toMin(end) <= toMin(start) && toMin(end) < 12 * 60) end = fromMin(toMin(end) + 12 * 60);
      out.time = start;
      out.endTime = end;
    });
  }

  // 시간
  take(new RegExp(`\\s${AP}(\\d{1,2})시\\s?(?:(\\d{1,2})분|(반))?${PARTICLE}${END}`), (m) => setTime(m[1], +m[2], m[4] ? 30 : +(m[3] || 0))) ||
  take(new RegExp(`\\s${AP}(\\d{1,2}):(\\d{2})${PARTICLE}${END}`), (m) => setTime(m[1], +m[2], +m[3])) ||
  take(new RegExp(`\\s정오${PARTICLE}${END}`), () => setTime('', 12, 0));
  function setTime(ap, h, mi) {
    if (out.time && out.everyHours) return false; // 이미 시작~끝을 정함
    const hm = toHM(ap, h, mi);
    if (!hm) return false;
    out.time = hm;
  }

  // 중요
  take(/\s(?:!+|중요)(?=\s)/, () => { out.important = true; });

  if (out.everyHours) {
    normalizeRepeat(out); // 반복이 없으면 매일, 기본 9시~21시
    if (!out.due) out.due = t;
    // 오늘 마지막 회차까지 지났으면 다음 회차 날부터
    if (out.due === t && at(t, out.endTime) <= Date.now()) out.due = stepRepeat(t, out.repeat, out.anchorDay, out.repeatDays);
  } else {
    if (out.time && !out.due) out.due = at(t, out.time) > Date.now() ? t : addDays(t, 1);
    if (out.repeat !== 'none') {
      normalizeRepeat(out);
      // 오늘이 첫 회차인데 시간이 이미 지났으면 다음 회차부터
      if (out.due === t && out.time && at(t, out.time) <= Date.now()) {
        out.due = stepRepeat(t, out.repeat, out.anchorDay, out.repeatDays);
      }
    }
  }

  out.title = s.replace(/\s+/g, ' ').trim() || raw.trim();
  return out;
}

/* ---------------- rendering ---------------- */

const list = $('#list');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sortTasks(a, b) {
  if ((a.due || '9999') !== (b.due || '9999')) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
  if ((a.time || '99') !== (b.time || '99')) return (a.time || '99') < (b.time || '99') ? -1 : 1;
  if (!!a.important !== !!b.important) return a.important ? -1 : 1;
  return a.createdAt - b.createdAt;
}

function buildGroups() {
  const t = todayStr();
  const tomorrow = addDays(t, 1);
  const open = tasks.filter((x) => !x.done).sort(sortTasks);
  if (view === 'today') {
    return [
      { title: '기한 지남', items: open.filter((x) => x.due && x.due < t), cls: 'overdue' },
      { title: '오늘', items: open.filter((x) => x.due === t) },
    ];
  }
  if (view === 'upcoming') {
    const future = open.filter((x) => x.due && x.due > t);
    const byDate = new Map();
    for (const x of future) {
      if (!byDate.has(x.due)) byDate.set(x.due, []);
      byDate.get(x.due).push(x);
    }
    return [
      ...[...byDate].map(([d, items]) => ({ title: dateLabel(d), items })),
      { title: '날짜 없음', items: open.filter((x) => !x.due) },
    ];
  }
  if (view === 'all') {
    return [
      { title: '기한 지남', items: open.filter((x) => x.due && x.due < t), cls: 'overdue' },
      { title: '오늘', items: open.filter((x) => x.due === t) },
      { title: '내일', items: open.filter((x) => x.due === tomorrow) },
      { title: '이후', items: open.filter((x) => x.due && x.due > tomorrow) },
      { title: '날짜 없음', items: open.filter((x) => !x.due) },
    ];
  }
  const done = tasks.filter((x) => x.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const byDay = new Map();
  for (const x of done) {
    const key = ymd(new Date(x.doneAt || x.createdAt));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(x);
  }
  return [...byDay].map(([d, items]) => ({ title: `${dateLabel(d)} 완료`, items }));
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const STAR_SVG = (on) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>`;

function taskHTML(x) {
  const t = todayStr();
  const meta = [];
  if (x.due && x.everyHours && !x.done) {
    // 몇 시간마다: "💧 3/7회 · 다음 오후 3시"
    const late = x.due < t;
    const showDate = !(view === 'today' && x.due === t) && !(view === 'upcoming');
    if (showDate || late) meta.push(`<span class="${late ? 'late' : ''}">${late ? '⚠ ' : ''}${esc(dateLabel(x.due))}</span>`);
    const total = hourlySlots(x).length;
    meta.push(`<span class="slots">${esc(iconOf(x))} ${slotCountToday(x)}/${total}회</span>`);
    const next = nextSlotToday(x);
    if (next) meta.push(`<span class="${at(x.due, next) - Date.now() < 3600e3 ? 'soon' : ''}">다음 ${timeLabel(next)}</span>`);
    meta.push(`<span>🔁 ${esc(repeatLabel(x))} · ${x.everyHours}시간마다</span>`);
  } else if (x.due) {
    const late = !x.done && x.due < t;
    const showDate = !(view === 'today' && x.due === t) && !(view === 'upcoming');
    let label = showDate ? dateLabel(x.due) : '';
    if (x.time) label = `${label} ${timeLabel(x.time)}`.trim();
    const pastTime = !x.done && x.due === t && x.time && at(x.due, x.time) < Date.now();
    const soon = !x.done && x.due === t && x.time && !pastTime && at(x.due, x.time) - Date.now() < 3600e3;
    if (label) meta.push(`<span class="${late || pastTime ? 'late' : soon ? 'soon' : ''}">${late ? '⚠ ' : ''}${esc(label)}</span>`);
  }
  if (x.repeat && x.repeat !== 'none' && !(x.everyHours && !x.done)) meta.push(`<span>🔁 ${esc(repeatLabel(x))}</span>`);
  if (!x.done && isPaused(x)) meta.push(`<span class="paused">⏸ ${esc(dateLabel(x.pausedUntil, false))}까지 쉬는 중</span>`);
  if (!x.done && x.due && x.remind != null) {
    const remindText = x.snoozeUntil ? `${SNOOZE_MIN}분 뒤` : x.everyHours ? `${timeLabel(x.time)}~${timeLabel(x.endTime)}` : REMIND_LABEL[x.remind] ?? '';
    meta.push(`<span title="알림">🔔 ${remindText}</span>`);
  }
  return `
    <div class="swipe" data-id="${x.id}">
      <div class="swipe-bg" aria-hidden="true"><span class="sb-done">✓ 완료</span><span class="sb-later">${x.repeat && x.repeat !== 'none' ? '다음 회차' : '내일로'} →</span></div>
      <article class="task${x.done ? ' done' : ''}${x.important ? ' important' : ''}" data-id="${x.id}">
        <button class="check" aria-label="${x.done ? '완료 취소' : '완료'}">${CHECK_SVG}</button>
        <div class="task-body">
          <div class="task-title">${esc(x.title)}</div>
          ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
          ${x.note ? `<div class="note-preview">${esc(x.note)}</div>` : ''}
        </div>
        <button class="star${x.important ? ' on' : ''}" aria-label="중요 표시" aria-pressed="${!!x.important}">${STAR_SVG(x.important)}</button>
      </article>
    </div>`;
}

const EMPTY = {
  today: ['☀️', '오늘 할 일이 없어요', '아래 입력창에 할 일을 적어 보세요.'],
  upcoming: ['🗓️', '예정된 할 일이 없어요', '“내일 3시 치과”처럼 날짜와 시간을 함께 적으면 자동으로 정리돼요.'],
  all: ['📝', '할 일이 비어 있어요', '첫 번째 할 일을 추가해 보세요.'],
  done: ['✅', '아직 완료한 일이 없어요', '완료한 일은 여기에 모여요.'],
};

function render() {
  const groups = buildGroups().filter((g) => g.items.length);
  if (!groups.length) {
    const [icon, title, sub] = EMPTY[view];
    const allDoneToday = view === 'today' && tasks.some((x) => x.done && ymd(new Date(x.doneAt)) === todayStr());
    list.innerHTML = `<div class="empty"><div class="big">${allDoneToday ? '🎉' : icon}</div>
      <p><b>${allDoneToday ? '오늘 할 일을 모두 끝냈어요!' : title}</b></p><p><small>${allDoneToday ? '수고했어요.' : sub}</small></p></div>`;
  } else {
    list.innerHTML = groups.map((g) => `
      <section class="section">
        <div class="section-head ${g.cls || ''}">${esc(g.title)} <span class="count">${g.items.length}</span>
          ${g.cls === 'overdue' ? '<span class="head-actions"><button class="mini-btn" data-bulk="today">모두 오늘로</button><button class="mini-btn" data-bulk="tomorrow">모두 내일로</button></span>' : ''}</div>
        ${g.items.map(taskHTML).join('')}
      </section>`).join('') +
      (view !== 'done' ? '<p class="list-hint">→ 밀면 완료 · ← 밀면 내일로 · 길게 누르면 미루기</p>' : '');
  }
  renderChrome();
}

function renderChrome() {
  const t = todayStr();
  const d = new Date();
  $('#todayLabel').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
  const open = tasks.filter((x) => !x.done);
  const todayOpen = open.filter((x) => x.due && x.due <= t).length;
  $('#cntToday').textContent = todayOpen || '';
  $('#cntUpcoming').textContent = open.filter((x) => x.due && x.due > t).length || '';
  $('#cntAll').textContent = open.length || '';
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));

  const doneToday = tasks.filter((x) => x.done && x.doneAt && ymd(new Date(x.doneAt)) === t).length;
  const total = doneToday + todayOpen;
  $('#progressFill').style.width = total ? `${(doneToday / total) * 100}%` : '0%';
  $('#progressText').textContent = !total ? '오늘 할 일 없음' : doneToday === total ? `오늘 ${total}개 모두 완료 🎉` : `오늘 ${doneToday}/${total} 완료`;

  $('#composer').hidden = view === 'done';
  const needsPerm = 'Notification' in window && Notification.permission === 'default' && open.some((x) => x.due && x.remind != null);
  $('#notifyBanner').hidden = !needsPerm;

  if (navigator.setAppBadge) {
    (todayOpen ? navigator.setAppBadge(todayOpen) : navigator.clearAppBadge()).catch(() => {});
  }
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(text, undo) {
  const el = $('#toast');
  $('#toastText').textContent = text;
  const btn = $('#toastAction');
  btn.hidden = !undo;
  btn.onclick = () => { el.hidden = true; undo?.(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 5000 : 3000);
}

/* ---------------- actions ---------------- */

function snapshot() { return JSON.parse(JSON.stringify(tasks)); }
function restore(snap) { tasks = snap; save(); render(); }

function toggleDone(id, { animate = true } = {}) {
  const x = findTask(id);
  if (!x) return;
  const before = snapshot();
  // 몇 시간마다: 하루 회차를 다 채우기 전까지는 횟수만 올림
  if (!x.done && x.everyHours && x.due) {
    const total = hourlySlots(x).length;
    const count = slotCountToday(x) + 1;
    if (count < total) {
      x.slotDate = x.due;
      x.slotCount = count;
      x.snoozeUntil = null;
      closeNotification(id);
      save();
      render();
      const next = nextSlotToday(x);
      toast(`${iconOf(x)} ${count}/${total}회 했어요${next ? ` · 다음 ${timeLabel(next)}` : ''}`, () => restore(before));
      return;
    }
  }
  const apply = () => {
    if (x.everyHours) { x.slotDate = null; x.slotCount = 0; }
    const next = !x.done && x.repeat && x.repeat !== 'none' && x.due ? nextDue(x) : null;
    if (next && !withinUntil(x, next)) {
      // 종료일 전 마지막 회차 → 루틴 자체를 완료
      x.done = true;
      x.doneAt = Date.now();
      x.snoozeUntil = null;
      toast('🎉 마지막 회차까지 끝냈어요', () => restore(before));
    } else if (next) {
      tasks.push({
        ...x, id: uid(), repeat: 'none', repeatDays: null, repeatUntil: null, everyHours: null, endTime: null, done: true, doneAt: Date.now(),
        notifiedKey: null, snoozeUntil: null, pausedUntil: null, pauseFrom: null,
      });
      x.pausedUntil = null;
      x.pauseFrom = null;
      x.due = next;
      x.snoozeUntil = null;
      settleReminder(x);
      toast(x.everyHours
        ? `🎉 오늘 ${hourlySlots(x).length}번 다 했어요 · 다음: ${dateLabel(x.due)}`
        : `완료! 다음 일정: ${dateLabel(x.due)}`, () => restore(before));
    } else if (!x.done) {
      x.done = true;
      x.doneAt = Date.now();
      x.snoozeUntil = null;
      toast('완료했어요 👏', () => restore(before));
    } else {
      x.done = false;
      x.doneAt = null;
      settleReminder(x);
      toast('다시 할 일로 옮겼어요', () => restore(before));
    }
    closeNotification(id);
    save();
    render();
  };
  const el = animate && list.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  if (el) {
    if (!x.done) el.classList.add('done');
    setTimeout(() => el.closest('.swipe').classList.add('leaving'), 160);
    setTimeout(apply, 380);
  } else apply();
}

function toggleImportant(id) {
  const x = findTask(id);
  if (!x) return;
  x.important = !x.important;
  save();
  render();
}

/* ---------------- 미루기 ---------------- */

// 할 일을 date(와 time)로 옮김. 반복 할 일은 규칙에 맞는 그날 이후 첫 회차로 (완료 기록 없이 건너뜀)
function moveTask(x, date, time) {
  const routine = x.repeat && x.repeat !== 'none' && x.due;
  if (routine && time === undefined) {
    let n = firstOnOrAfter(x, x.due, date);
    if (n === x.due) n = stepRepeat(n, x.repeat, x.anchorDay, x.repeatDays);
    x.due = n;
  } else {
    x.due = date;
  }
  if (time !== undefined) {
    x.time = time;
    if (time && x.remind == null) x.remind = 0;
  }
  x.pausedUntil = null;
  x.pauseFrom = null;
  x.snoozeUntil = null;
  endRoutineIfOver(x);
  settleReminder(x);
  closeNotification(x.id);
}

function postpone(id, date, time, label) {
  const x = findTask(id);
  if (!x || x.done) return;
  const before = snapshot();
  const routineSkip = x.repeat && x.repeat !== 'none' && time === undefined;
  moveTask(x, date, time);
  save();
  render();
  const when = `${dateLabel(x.due)}${x.time ? ` ${timeLabel(x.time)}` : ''}`;
  const msg = x.done ? '반복 기간이 끝나서 루틴을 마쳤어요'
    : routineSkip ? `이번 회차는 건너뛰어요 · 다음: ${when}` : `미뤘어요 · ${when}`;
  toast(label || msg, () => restore(before));
}

function bulkMoveOverdue(target) {
  const t = todayStr();
  const date = target === 'today' ? t : addDays(t, 1);
  const overdue = tasks.filter((x) => !x.done && x.due && x.due < t);
  if (!overdue.length) return;
  const before = snapshot();
  for (const x of overdue) {
    if (x.repeat && x.repeat !== 'none') {
      x.due = firstOnOrAfter(x, x.due, date);
      x.snoozeUntil = null;
      endRoutineIfOver(x);
      settleReminder(x);
    } else moveTask(x, date);
  }
  save();
  render();
  toast(`밀린 일 ${overdue.length}개를 ${target === 'today' ? '오늘' : '내일'}로 옮겼어요`, () => restore(before));
}

function addTask(data) {
  const task = newTask(data);
  tasks.push(task);
  save();
  render();
  return task;
}

function newTask(data) {
  const task = {
    id: uid(),
    title: data.title,
    note: data.note || '',
    due: data.due || null,
    time: data.time || null,
    remind: data.remind ?? null,
    repeat: data.repeat || 'none',
    repeatDays: data.repeatDays || null,
    repeatUntil: data.repeatUntil || null,
    everyHours: data.everyHours || null,
    endTime: data.endTime || null,
    icon: data.everyHours ? firstGrapheme(data.icon) || guessIcon(data.title) : null,
    anchorDay: data.anchorDay || null,
    important: !!data.important,
    done: false,
    doneAt: null,
    createdAt: Date.now(),
    notifiedKey: null,
    snoozeUntil: null,
  };
  normalizeRepeat(task);
  settleReminder(task);
  return task;
}

function deleteTask(id) {
  const x = findTask(id);
  if (!x) return;
  const before = snapshot();
  tasks = tasks.filter((t) => t.id !== id);
  closeNotification(id);
  save();
  render();
  toast(`‘${x.title}’ 삭제됨`, () => restore(before));
}

/* ---------------- composer ---------------- */

const quickInput = $('#quickInput');
const preview = $('#parsePreview');

function previewPills(p) {
  const pills = [];
  if (p.due) pills.push(`📅 ${dateLabel(p.due)}`);
  if (p.everyHours) pills.push(`${iconOf(p)} ${hourlyLabel(p)} (하루 ${hourlySlots(p).length}번)`);
  else if (p.time) pills.push(`⏰ ${timeLabel(p.time)}`);
  if (p.repeat !== 'none') pills.push(`🔁 ${repeatLabel(p)}`);
  if (p.important) pills.push('⭐ 중요');
  return pills;
}

quickInput.addEventListener('input', () => {
  const v = quickInput.value.trim();
  const pills = v ? previewPills(parseQuick(v)) : [];
  preview.hidden = !pills.length;
  preview.innerHTML = pills.map((p) => `<span class="pill">${esc(p)}</span>`).join('');
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = quickInput.value.trim();
  if (!v) { quickInput.focus(); return; }
  const p = parseQuick(v);
  if (!p.due && view === 'today') p.due = todayStr();
  const task = addTask({ ...p, remind: p.time ? 0 : null });
  quickInput.value = '';
  preview.hidden = true;
  const where = task.due ? `${dateLabel(task.due)}${task.time ? ` ${timeLabel(task.time)}` : ''}` : '날짜 없음';
  const inView = view === 'all' || (view === 'today' && task.due && task.due <= todayStr()) ||
    (view === 'upcoming' && (!task.due || task.due > todayStr()));
  toast(inView ? `추가했어요 · ${where}` : `‘${where}’에 추가했어요`);
  if (task.remind != null) maybeAskPermission();
});

$('#detailBtn').addEventListener('click', () => {
  const v = quickInput.value.trim();
  const p = v ? parseQuick(v) : {};
  if (!p.due && view === 'today') p.due = todayStr();
  openEditor(null, p);
});

/* ---------------- editor sheet ---------------- */

const editBackdrop = $('#editBackdrop');
const form = $('#editForm');
let editingId = null;

function openEditor(task, prefill = {}) {
  editingId = task?.id || null;
  const src = task || prefill;
  $('#editTitle').textContent = task ? '할 일 편집' : '새 할 일';
  form.title.value = src.title || '';
  form.note.value = src.note || '';
  form.due.value = src.due || '';
  form.time.value = src.time || '';
  form.remind.value = task ? (task.remind == null ? 'off' : String(task.remind)) : (src.time ? '0' : 'off');
  const rep = src.repeat === 'weekdays' ? 'weekly' : src.repeat || 'none';
  editDays = src.repeat === 'weekdays' ? [1, 2, 3, 4, 5] : src.repeatDays ? [...src.repeatDays] : [];
  setRepeatUI(rep, src.repeatUntil || '');
  form.startTime.value = src.everyHours ? src.time || '' : '';
  form.endTime.value = src.endTime || '';
  form.icon.value = src.everyHours ? src.icon || guessIcon(src.title) : '';
  setHourlyUI(src.everyHours || null);
  form.important.checked = !!src.important;
  $('#deleteBtn').hidden = !task;
  $('#breakdownBtn').hidden = !API_BASE;
  renderPauseBox(task);
  updateRemindHint();
  openSheet(editBackdrop);
  if (!task) setTimeout(() => form.title.focus(), 50);
}

function updateRemindHint() {
  const hint = $('#remindHint');
  const remind = form.remind.value;
  const due = form.due.value;
  $('#icsBtn').hidden = !due;
  if (remind === 'off') { hint.textContent = ''; return; }
  if (form.everyHours.value) {
    hint.textContent = `🔔 ${timeLabel(form.startTime.value || '09:00')}부터 ${timeLabel(form.endTime.value || '21:00')}까지 ${form.everyHours.value}시간마다 알려드려요.`;
    return;
  }
  if (!due) { hint.textContent = '날짜를 정하면 알림이 울려요.'; return; }
  const f = at(due, form.time.value || settings.defaultTime) - Number(remind) * 60000;
  const d = new Date(f);
  const when = `${dateLabel(ymd(d))} ${timeLabel(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}`;
  hint.textContent = f < Date.now() ? `⚠ 알림 시각(${when})이 이미 지났어요.` : `🔔 ${when}에 알려드려요.`;
}

/* 반복: 안 함 / 매일 / 요일 선택 / 매월 + 언제까지 (비우면 계속) */
let editDays = [];

function setRepeatUI(repeat, until) {
  form.repeat.value = repeat;
  $$('#repeatSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.repeat === repeat)));
  $('#repeatBox').hidden = repeat === 'none';
  $('#weekdayBox').hidden = repeat !== 'weekly';
  if (repeat === 'weekly' && !editDays.length) editDays = [dow(form.due.value || todayStr())];
  if (until !== undefined) form.until.value = until;
  renderRepeatUI();
}

function renderRepeatUI() {
  $$('#wdRow button').forEach((b) => b.setAttribute('aria-pressed', String(editDays.includes(Number(b.dataset.d)))));
  $('#untilClear').setAttribute('aria-pressed', String(!form.until.value));
  form.until.min = form.due.value || todayStr();
  const repeat = form.repeat.value;
  const hint = $('#repeatHint');
  if (repeat === 'none') { hint.textContent = ''; return; }
  const probe = normalizeRepeat({
    repeat, repeatDays: repeat === 'weekly' ? editDays : null, repeatUntil: form.until.value || null,
    due: form.due.value || todayStr(), anchorDay: null,
  });
  if (probe.repeatUntil && probe.repeatUntil < probe.due) { hint.textContent = '⚠ 종료일이 첫 회차보다 빨라요.'; return; }
  let hourly = '';
  if (form.everyHours.value) {
    const n = hourlySlots({ everyHours: Number(form.everyHours.value), time: form.startTime.value || '09:00', endTime: form.endTime.value || '21:00' }).length;
    hourly = ` · 하루 ${n}번`;
  }
  hint.textContent = `🔁 ${repeatLabel(probe)}${probe.repeatUntil ? '' : ' · 계속 반복'}${hourly} · 첫 회차 ${dateLabel(probe.due)}`;
}

/* 하루 중 몇 시간마다 */
// 아이콘 고르기: 자주 쓰는 것 12개 + 직접 넣기(이모지 키보드)
$('#iconRow').innerHTML = ICON_CHOICES.map((ic) => `<button type="button" data-icon="${ic}" aria-label="${ic}">${ic}</button>`).join('');
function renderIconPick() {
  const cur = firstGrapheme(form.icon.value);
  $$('#iconRow button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.icon === cur)));
}
$('#iconRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-icon]');
  if (!b) return;
  form.icon.value = b.dataset.icon;
  renderIconPick();
});
form.icon.addEventListener('input', renderIconPick);
form.icon.addEventListener('change', () => { form.icon.value = firstGrapheme(form.icon.value); renderIconPick(); });

function setHourlyUI(every) {
  form.everyHours.value = every ? String(every) : '';
  const on = !!every;
  $('#hourlyStartField').hidden = !on;
  $('#hourlyEndField').hidden = !on;
  $('#iconPick').hidden = !on;
  form.time.closest('.field').hidden = on; // 시간 칸 대신 시작~끝
  if (on) {
    if (!form.icon.value) form.icon.value = guessIcon(form.title.value);
    renderIconPick();
    form.startTime.value = form.startTime.value || form.time.value || '09:00';
    form.endTime.value = form.endTime.value || '21:00';
    form.time.value = form.startTime.value;
    if (form.repeat.value === 'none') setRepeatUI('daily');
    if (form.remind.value === 'off') form.remind.value = '0';
    if (!form.due.value) form.due.value = todayStr();
  }
  renderRepeatUI();
  updateRemindHint();
}
form.everyHours.addEventListener('change', () => setHourlyUI(Number(form.everyHours.value) || null));
form.startTime.addEventListener('input', () => { form.time.value = form.startTime.value; renderRepeatUI(); updateRemindHint(); });
form.endTime.addEventListener('input', () => { renderRepeatUI(); updateRemindHint(); });

$$('#repeatSeg button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.repeat === 'none' && form.everyHours.value) setHourlyUI(null);
  setRepeatUI(b.dataset.repeat);
}));
$$('#wdRow button').forEach((b) => b.addEventListener('click', () => {
  const d = Number(b.dataset.d);
  if (editDays.includes(d)) {
    if (editDays.length === 1) { toast('요일을 하나 이상 골라 주세요'); return; }
    editDays = editDays.filter((x) => x !== d);
  } else editDays = [...editDays, d];
  renderRepeatUI();
}));
$$('.wd-presets [data-preset]').forEach((b) => b.addEventListener('click', () => {
  editDays = [...b.dataset.preset].map(Number);
  renderRepeatUI();
}));
$('#untilClear').addEventListener('click', () => { form.until.value = ''; renderRepeatUI(); });
form.due.addEventListener('change', renderRepeatUI);
form.until.addEventListener('input', renderRepeatUI);

form.addEventListener('input', updateRemindHint);
form.time.addEventListener('change', () => {
  if (form.time.value && form.remind.value === 'off') form.remind.value = '0';
  if (form.time.value && !form.due.value) form.due.value = todayStr();
  updateRemindHint();
});

$$('.quick-dates [data-date]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.date;
  if (v === 'none') { form.due.value = ''; form.time.value = ''; }
  else if (v === 'weekend') form.due.value = upcomingWeekday(6);
  else form.due.value = addDays(todayStr(), Number(v));
  updateRemindHint();
}));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = form.title.value.trim();
  if (!title) { form.title.focus(); return; }
  const data = {
    title,
    note: form.note.value.trim(),
    due: form.due.value || null,
    time: form.time.value || null,
    remind: form.remind.value === 'off' ? null : Number(form.remind.value),
    repeat: form.repeat.value,
    repeatDays: form.repeat.value === 'weekly' ? [...editDays] : null,
    repeatUntil: form.repeat.value !== 'none' ? form.until.value || null : null,
    everyHours: Number(form.everyHours.value) || null,
    endTime: form.everyHours.value ? form.endTime.value || '21:00' : null,
    icon: form.everyHours.value ? firstGrapheme(form.icon.value) || guessIcon(title) : null,
    important: form.important.checked,
  };
  if (data.everyHours) data.time = form.startTime.value || '09:00';
  if ((data.time || data.repeat !== 'none') && !data.due) data.due = todayStr();
  const prevAnchor = editingId ? findTask(editingId)?.anchorDay : null;
  // 매월 반복은 날짜를 바꿨을 때만 기준일을 새로 잡음
  data.anchorDay = data.repeat === 'monthly' && prevAnchor && findTask(editingId)?.due === data.due ? prevAnchor : null;
  normalizeRepeat(data);
  if (data.repeatUntil && data.repeatUntil < data.due) { toast('“언제까지”가 첫 회차보다 빨라요'); return; }

  if (editingId) {
    const x = findTask(editingId);
    const hourlyChanged = (x.everyHours || null) !== data.everyHours || (x.endTime || null) !== data.endTime;
    if (hourlyChanged) { data.slotDate = null; data.slotCount = 0; }
    const repeatChanged = x.repeat !== data.repeat || String(x.repeatDays) !== String(data.repeatDays)
      || x.repeatUntil !== data.repeatUntil || hourlyChanged;
    const timingChanged = x.due !== data.due || x.time !== data.time || x.remind !== data.remind || repeatChanged;
    const dueChanged = x.due !== data.due;
    Object.assign(x, data);
    if (x.repeat === 'none' || dueChanged) { x.pausedUntil = null; x.pauseFrom = null; }
    if (timingChanged) { x.snoozeUntil = null; settleReminder(x); closeNotification(x.id); }
    save();
    render();
    toast('저장했어요');
  } else {
    addTask(data);
    toast('추가했어요');
    quickInput.value = '';
    preview.hidden = true;
  }
  closeSheet(editBackdrop);
  if (data.remind != null && data.due) maybeAskPermission();
});

function renderPauseBox(task) {
  const box = $('#pauseBox');
  box.hidden = !task || !isRoutine(task);
  if (box.hidden) return;
  const paused = isPaused(task);
  $('#pauseStatus').textContent = paused
    ? `${dateLabel(task.pausedUntil)}까지 쉬는 중이에요. 그날부터 다시 알려드려요.`
    : '정한 날짜까지 이 루틴이 목록과 알림에서 빠져요.';
  $('#pauseUntil').value = paused ? task.pausedUntil : addDays(todayStr(), 7);
  $('#pauseUntil').min = addDays(todayStr(), 1);
  $('#pauseBtn').textContent = paused ? '날짜 바꾸기' : '일시정지';
  $('#resumeBtn').hidden = !paused;
}

$('#pauseBtn').addEventListener('click', () => {
  const x = editingId && findTask(editingId);
  const until = $('#pauseUntil').value;
  if (!x || !until) return;
  if (until <= todayStr()) { toast('내일 이후 날짜를 골라 주세요'); return; }
  const before = snapshot();
  pauseTask(x, until);
  save();
  render();
  closeSheet(editBackdrop);
  toast(`⏸ ${dateLabel(until)}까지 쉬어요`, () => restore(before));
});
$('#resumeBtn').addEventListener('click', () => {
  const x = editingId && findTask(editingId);
  if (!x) return;
  resumeTask(x);
  save();
  render();
  closeSheet(editBackdrop);
  toast(`▶ 다시 시작해요 · ${dateLabel(x.due)}`);
});

$('#deleteBtn').addEventListener('click', () => {
  if (!editingId) return;
  closeSheet(editBackdrop);
  deleteTask(editingId);
});

$('#icsBtn').addEventListener('click', () => {
  const data = {
    title: form.title.value.trim() || '할 일',
    note: form.note.value.trim(),
    due: form.due.value,
    time: form.time.value,
    remind: form.remind.value === 'off' ? null : Number(form.remind.value),
    repeat: form.repeat.value,
    repeatDays: form.repeat.value === 'weekly' ? [...editDays] : null,
    repeatUntil: form.until.value || null,
  };
  if (!data.due) return;
  downloadICS(normalizeRepeat(data));
});

/* ---------------- sheets ---------------- */

function openSheet(backdrop) {
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet(backdrop) {
  backdrop.hidden = true;
  if ($$('.sheet-backdrop').every((b) => b.hidden)) document.body.style.overflow = '';
}
$$('.sheet-backdrop').forEach((bd) => {
  bd.addEventListener('click', (e) => {
    if (e.target === bd || e.target.closest('[data-close]')) closeSheet(bd);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.sheet-backdrop').forEach((b) => !b.hidden && closeSheet(b));
  if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); quickInput.focus(); }
});

/* ---------------- list interactions ---------------- */

let suppressClick = false;

list.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; return; }
  const bulk = e.target.closest('[data-bulk]');
  if (bulk) { bulkMoveOverdue(bulk.dataset.bulk); return; }
  const row = e.target.closest('.task');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.check')) toggleDone(id);
  else if (e.target.closest('.star')) toggleImportant(id);
  else if (e.target.closest('.task-body')) openEditor(findTask(id));
});

// 밀어서 처리 (오른쪽 → 완료, 왼쪽 → 내일로) + 길게 눌러 빠른 미루기
const SWIPE_THRESHOLD = 90;
let gesture = null;

list.addEventListener('pointerdown', (e) => {
  const sw = e.target.closest('.swipe');
  if (!sw || view === 'done' || e.button > 0 || e.target.closest('.check, .star')) return;
  const g = { sw, task: sw.querySelector('.task'), id: sw.dataset.id, x0: e.clientX, y0: e.clientY, dx: 0, mode: null, pid: e.pointerId };
  g.lp = setTimeout(() => {
    if (gesture === g && !g.mode) {
      g.mode = 'longpress';
      suppressClick = true;
      navigator.vibrate?.(15);
      openQuickMenu(g.id);
    }
  }, 500);
  gesture = g;
});

list.addEventListener('pointermove', (e) => {
  const g = gesture;
  if (!g || g.pid !== e.pointerId) return;
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.mode) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      g.mode = 'swipe';
      clearTimeout(g.lp);
      try { g.sw.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    } else if (Math.abs(dy) > 10) {
      g.mode = 'scroll';
      clearTimeout(g.lp);
      return;
    } else return;
  }
  if (g.mode !== 'swipe') return;
  g.dx = dx;
  g.task.style.transition = 'none';
  g.task.style.transform = `translateX(${dx}px)`;
  g.sw.classList.toggle('to-done', dx > 0);
  g.sw.classList.toggle('to-later', dx < 0);
  const armed = Math.abs(dx) > SWIPE_THRESHOLD;
  if (armed && !g.armed) navigator.vibrate?.(8);
  g.armed = armed;
  g.sw.classList.toggle('armed', armed);
});

function endGesture(e) {
  const g = gesture;
  if (!g || g.pid !== e.pointerId) return;
  clearTimeout(g.lp);
  gesture = null;
  if (g.mode !== 'swipe') return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 50);
  g.task.style.transition = '';
  if (e.type === 'pointerup' && Math.abs(g.dx) > SWIPE_THRESHOLD) {
    g.task.style.transform = `translateX(${g.dx > 0 ? '110%' : '-110%'})`;
    const id = g.id;
    const right = g.dx > 0;
    setTimeout(() => {
      if (right) toggleDone(id, { animate: false });
      else postpone(id, addDays(todayStr(), 1));
    }, 180);
  } else {
    g.task.style.transform = '';
    g.sw.classList.remove('to-done', 'to-later', 'armed');
  }
}
list.addEventListener('pointerup', endGesture);
list.addEventListener('pointercancel', endGesture);
list.addEventListener('contextmenu', (e) => {
  const sw = e.target.closest('.swipe');
  if (!sw || view === 'done') return;
  e.preventDefault();
  if (gesture?.mode === 'longpress') return; // 터치 길게 누르기로 이미 열림
  openQuickMenu(sw.dataset.id);
});

/* ---------------- 빠른 미루기 메뉴 ---------------- */

const quickBackdrop = $('#quickBackdrop');

function roundUpTime(ms, stepMin = 5) {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / stepMin) * stepMin);
  return d;
}

function quickOptions(x) {
  const routine = x.repeat && x.repeat !== 'none';
  const now = new Date();
  const t = todayStr();
  const opts = [];
  const later = roundUpTime(Date.now() + 3600e3);
  opts.push({ label: '1시간 뒤', sub: timeLabel(`${pad(later.getHours())}:${pad(later.getMinutes())}`), at: later });
  if (now.getHours() < 18 || (now.getHours() === 18 && now.getMinutes() < 30)) {
    const ev = new Date(); ev.setHours(19, 0, 0, 0);
    opts.push({ label: '오늘 저녁', sub: '오후 7시', at: ev });
  }
  const tomorrow = addDays(t, 1);
  if (routine) {
    let next = firstOnOrAfter(x, x.due || t, tomorrow);
    if (next === x.due) next = stepRepeat(next, x.repeat, x.anchorDay, x.repeatDays);
    opts.push({ label: '이번 회차 건너뛰기', sub: `다음: ${dateLabel(next)}`, date: tomorrow });
  } else {
    opts.push({ label: '내일 아침', sub: `${dateLabel(tomorrow)} ${timeLabel(settings.defaultTime)}`, date: tomorrow, time: settings.defaultTime });
  }
  if (!routine) {
    const nextMon = addDays(mondayOf(t), 7);
    opts.push({ label: '다음 주', sub: dateLabel(nextMon), date: nextMon });
  }
  return opts;
}

function openQuickMenu(id) {
  const x = findTask(id);
  if (!x || x.done) return;
  const routine = x.repeat && x.repeat !== 'none';
  $('#quickTitle').textContent = x.title;
  const opts = quickOptions(x);
  $('#quickOptions').innerHTML = opts.map((o, i) => `
    <button type="button" class="quick-opt" data-i="${i}"><b>${esc(o.label)}</b><span>${esc(o.sub)}</span></button>`).join('');
  $('#quickOptions').onclick = (e) => {
    const b = e.target.closest('.quick-opt');
    if (!b) return;
    const o = opts[Number(b.dataset.i)];
    closeSheet(quickBackdrop);
    if (o.at) {
      const timeStr = `${pad(o.at.getHours())}:${pad(o.at.getMinutes())}`;
      if (routine) {
        // 루틴은 시간 자체를 바꾸지 않고 그때 다시 알려 줌
        const before = snapshot();
        x.snoozeUntil = o.at.getTime();
        x.notifiedKey = null;
        save();
        render();
        toast(`${timeLabel(timeStr)}에 다시 알려드릴게요`, () => restore(before));
      } else {
        postpone(id, ymd(o.at), timeStr);
      }
    } else {
      postpone(id, o.date, o.time);
    }
  };
  $('#quickEdit').onclick = () => { closeSheet(quickBackdrop); openEditor(findTask(id)); };
  $('#quickDelete').onclick = () => { closeSheet(quickBackdrop); deleteTask(id); };
  openSheet(quickBackdrop);
}

$$('.tab').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  safeSet(VIEW_KEY, view);
  render();
  window.scrollTo({ top: 0 });
}));

/* ---------------- calendar (.ics) ---------------- */

function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`); }
function downloadICS(t) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const day = t.due.replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//to do list//KO', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${uid()}@todo-list`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEscape(t.title)}`];
  if (t.time) {
    const start = `${day}T${t.time.replace(':', '')}00`;
    const end = new Date(at(t.due, t.time) + 30 * 60000);
    lines.push(`DTSTART:${start}`, `DTEND:${ymd(end).replace(/-/g, '')}T${pad(end.getHours())}${pad(end.getMinutes())}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${addDays(t.due, 1).replace(/-/g, '')}`);
  }
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  let rule = {
    daily: 'FREQ=DAILY',
    weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    weekly: `FREQ=WEEKLY${t.repeatDays?.length ? `;BYDAY=${t.repeatDays.map((d) => BYDAY[d]).join(',')}` : ''}`,
    monthly: 'FREQ=MONTHLY',
  }[t.repeat];
  if (rule && t.repeatUntil) rule += `;UNTIL=${t.repeatUntil.replace(/-/g, '')}${t.time ? 'T235959' : ''}`;
  if (rule) lines.push(`RRULE:${rule}`);
  if (t.note) lines.push(`DESCRIPTION:${icsEscape(t.note)}`);
  if (t.remind != null) {
    // 종일 일정은 자정 기준이므로 기본 알림 시각만큼 뒤로 맞춤
    let minutes = -t.remind;
    if (!t.time) { const [h, m] = settings.defaultTime.split(':').map(Number); minutes += h * 60 + m; }
    const trig = minutes === 0 ? 'PT0M' : `${minutes < 0 ? '-' : ''}PT${Math.abs(minutes)}M`;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(t.title)}`, `TRIGGER:${trig}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'todo'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('캘린더 파일을 열면 휴대폰 캘린더에 알림과 함께 추가돼요');
}

/* ---------------- notifications ---------------- */

let swReg = null;
const swReady = ('serviceWorker' in navigator)
  ? navigator.serviceWorker.register('sw.js').then((r) => (swReg = r)).catch(() => null)
  : Promise.resolve(null);

async function showSystemNotification(title, opts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const reg = swReg || await Promise.race([swReady, new Promise((r) => setTimeout(() => r(null), 1500))]);
  try {
    if (reg) { await reg.showNotification(title, opts); return true; }
    const { actions, ...rest } = opts; // 생성자 방식은 actions를 지원하지 않음
    new Notification(title, rest);
    return true;
  } catch {
    try { new Notification(title, { body: opts.body }); return true; } catch { return false; }
  }
}

function notifyTask(x) {
  const parts = [];
  if (x.everyHours) parts.push(`${iconOf(x)} ${slotCountToday(x)}/${hourlySlots(x).length}회 했어요`);
  else if (x.time) parts.push(`${x.due === todayStr() ? '' : `${dateLabel(x.due)} `}${timeLabel(x.time)}`);
  else parts.push(dateLabel(x.due));
  if (x.note) parts.push(x.note);
  // 서버 푸시가 연결돼 있으면 시스템 알림은 서버가 보냄 (중복 방지)
  if (!pushActive()) showSystemNotification(x.title, {
    body: parts.join(' · '),
    tag: x.id,
    renotify: true,
    requireInteraction: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: { id: x.id },
    actions: [{ action: 'done', title: '완료' }, { action: 'snooze', title: `${SNOOZE_MIN}분 뒤` }],
  });
  if (document.visibilityState === 'visible') {
    toast(`🔔 ${x.title}`);
    navigator.vibrate?.([200, 100, 200]);
  }
}

async function closeNotification(id) {
  try {
    const reg = swReg;
    if (!reg) return;
    (await reg.getNotifications({ tag: id })).forEach((n) => n.close());
  } catch { /* 무시 */ }
}

let reminderTimer = null;
function scheduleReminders() {
  clearTimeout(reminderTimer);
  const now = Date.now();
  let next = Infinity;
  let changed = false;
  for (const x of tasks) {
    const f = fireTime(x);
    if (f == null) continue;
    const key = String(f);
    if (x.notifiedKey === key) continue;
    if (f <= now) {
      x.notifiedKey = key;
      if (x.snoozeUntil) {
        // 다시 알림이 울렸으면 원래 알림 시각 기준으로 되돌림 (재알림 방지)
        x.snoozeUntil = null;
        if (x.everyHours) settleReminder(x);
        else x.notifiedKey = String(fireTime(x));
      } else if (x.everyHours) {
        settleReminder(x); // 놓친 회차는 건너뛰고 가장 최근 회차만 알림
      }
      changed = true;
      if (now - f < MISSED_WINDOW) notifyTask(x);
    } else {
      next = Math.min(next, f);
    }
  }
  if (changed) { safeSet(STORE_KEY, tasks); render(); }
  if (next < Infinity) reminderTimer = setTimeout(scheduleReminders, Math.min(next - now + 300, 2 ** 31 - 1));
}

function snooze(id) {
  const x = findTask(id);
  if (!x || x.done) return;
  x.snoozeUntil = Date.now() + SNOOZE_MIN * 60000;
  x.notifiedKey = null;
  save();
  render();
  toast(`${SNOOZE_MIN}분 뒤에 다시 알려드릴게요`);
}

function handleAction(action, rawId) {
  // 서버 알림은 "할일id@회차날짜" 형식
  const [id, occurrence] = String(rawId || '').split('@');
  if (!id || !findTask(id)) return;
  if (action === 'done') {
    const x = findTask(id);
    if (x.done) return;
    // 밀린 루틴을 알림으로 완료하면 그 회차 기준으로 다음 날짜를 잡음 ("날짜T시각" 회차는 날짜만 봄)
    const occDate = occurrence?.slice(0, 10);
    if (occDate && x.repeat !== 'none' && x.due && occDate > x.due) {
      x.due = occDate;
      if (x.everyHours) { x.slotDate = null; x.slotCount = 0; }
    }
    toggleDone(id, { animate: false });
  }
  else if (action === 'snooze') snooze(id);
  else if (action === 'open') openEditor(findTask(id));
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data && e.data.type) handleAction(e.data.type, e.data.id);
});

async function requestPermission() {
  if (!('Notification' in window)) {
    toast('이 브라우저는 알림을 지원하지 않아요. 홈 화면에 설치해 주세요.');
    return 'unsupported';
  }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    toast('알림이 켜졌어요 🔔');
    await enablePush();
  }
  else if (result === 'denied') toast('알림이 차단됐어요. 브라우저 설정에서 허용해 주세요.');
  render();
  renderSettings();
  return result;
}
function maybeAskPermission() {
  if ('Notification' in window && Notification.permission === 'default') requestPermission();
}
$('#bannerEnable').addEventListener('click', requestPermission);

/* ---------------- server push ---------------- */

let pushError = '';
const pushActive = () => !!(API_BASE && settings.pushOn && 'Notification' in window && Notification.permission === 'granted');

async function api(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `http-${res.status}`), { code: data.error, status: res.status });
  return data;
}

function urlB64ToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// 구독을 만들거나 갱신해서 서버에 등록
async function enablePush({ quiet = false } = {}) {
  if (!API_BASE || !('PushManager' in window)) return false;
  try {
    const reg = swReg || await swReady;
    if (!reg) throw new Error('no-service-worker');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await fetch(`${API_BASE}/vapid`).then((r) => r.json());
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
    }
    await api('/subscribe', { subscription: sub.toJSON() });
    settings.pushOn = true;
    safeSet(SETTINGS_KEY, settings);
    pushError = '';
    await syncPushNow();
    if (!quiet) toast('📡 잠금화면 알림이 연결됐어요');
    renderSettings();
    return true;
  } catch (err) {
    pushError = err.message || String(err);
    if (!quiet) toast('서버 알림 연결에 실패했어요. 잠시 뒤 다시 시도해 주세요.');
    renderSettings();
    return false;
  }
}

// 서버에 넘길 알림 목록. 반복 할 일은 앱을 열지 않아도 계속 울리도록 앞으로 ROUTINE_HORIZON_DAYS일치를 미리 넘김
// (회차별 id는 "할일id@날짜")
const ROUTINE_HORIZON_DAYS = 30;
const HOURLY_HORIZON_DAYS = 7; // 몇 시간마다는 회차가 많아서 1주일치만
function upcomingReminders(x) {
  const first = fireTime(x);
  if (first == null) return [];
  if (x.everyHours) return hourlyReminders(x);
  const list = [];
  if (x.notifiedKey !== String(first)) {
    list.push({ id: `${x.id}@${x.due}`, fireAt: first, title: x.title, body: reminderBody(x, first, x.due) });
  }
  if (!x.repeat || x.repeat === 'none' || x.remind == null) return list;
  const horizon = addDays(todayStr(), ROUTINE_HORIZON_DAYS);
  for (let d = stepRepeat(x.due, x.repeat, x.anchorDay, x.repeatDays); d <= horizon && withinUntil(x, d); d = stepRepeat(d, x.repeat, x.anchorDay, x.repeatDays)) {
    const f = at(d, x.time || settings.defaultTime) - x.remind * 60000;
    list.push({ id: `${x.id}@${d}`, fireAt: f, title: x.title, body: reminderBody(x, f, d) });
  }
  return list;
}

function hourlyReminders(x) {
  const now = Date.now();
  const lastNotified = Number(x.notifiedKey) || 0;
  const slots = hourlySlots(x);
  const list = [];
  if (x.snoozeUntil && x.snoozeUntil > now) {
    list.push({ id: `${x.id}@${x.due}Tsnooze`, fireAt: x.snoozeUntil, title: x.title, body: `${iconOf(x)} ${slotCountToday(x)}/${slots.length}회 · 다시 알림` });
  }
  for (const d of occurrencesBetween(x, x.due, addDays(todayStr(), HOURLY_HORIZON_DAYS))) {
    slots.forEach((s, i) => {
      const f = at(d, s);
      if (f <= now || (d === x.due && f <= lastNotified)) return;
      const done = d === x.due ? slotCountToday(x) : 0;
      list.push({
        id: `${x.id}@${d}T${s}`, fireAt: f, title: x.title,
        body: [`${iconOf(x)} ${i + 1}번째 (${done}/${slots.length}회 했어요)`, x.note].filter(Boolean).join(' · '),
      });
    });
  }
  return list;
}

// 반복 할 일이 from~to 사이에 걸리는 날짜들
function occurrencesBetween(x, from, to) {
  if (!x.due) return [];
  if (!x.repeat || x.repeat === 'none') return x.due >= from && x.due <= to ? [x.due] : [];
  const out = [];
  for (let d = firstOnOrAfter(x, x.due, from); d <= to && withinUntil(x, d); d = stepRepeat(d, x.repeat, x.anchorDay, x.repeatDays)) out.push(d);
  return out;
}

// 아침 브리핑: 매일 정한 시각에 그날 할 일을 알림 하나로 (할 일이 있는 날만)
function briefingReminders() {
  if (!settings.briefOn) return [];
  const t = todayStr();
  const horizon = addDays(t, ROUTINE_HORIZON_DAYS);
  const open = tasks.filter((x) => !x.done && x.due);
  const byDay = new Map();
  for (const x of open) {
    for (const d of occurrencesBetween(x, t, horizon)) {
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(x);
    }
  }
  const now = Date.now();
  const list = [];
  let first = true;
  for (let d = t; d <= horizon; d = addDays(d, 1)) {
    const fireAt = at(d, settings.briefTime || '08:00');
    if (fireAt <= now) continue;
    const items = (byDay.get(d) || []).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    const overdue = first ? open.filter((x) => x.due < d && !(x.repeat && x.repeat !== 'none')).length : 0;
    first = false;
    if (!items.length && !overdue) continue;
    const names = items.slice(0, 4).map((x) => (x.everyHours
      ? `${iconOf(x)} ${x.title} ${x.everyHours}시간마다`
      : `${x.time ? `${timeLabel(x.time)} ` : ''}${x.title}`));
    if (items.length > 4) names.push(`외 ${items.length - 4}개`);
    if (overdue) names.push(`밀린 일 ${overdue}개`);
    list.push({
      id: `__brief__@${d}`,
      fireAt,
      title: items.length ? `☀️ 오늘 할 일 ${items.length}개` : '☀️ 밀린 할 일이 있어요',
      body: names.join(' · '),
    });
  }
  return list;
}

function reminderBody(x, fireAt, date = x.due) {
  const fireDay = ymd(new Date(fireAt));
  const parts = [];
  const d = parseYmd(date);
  const dayText = date === fireDay ? '' : `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
  const when = [dayText, x.time ? timeLabel(x.time) : ''].filter(Boolean).join(' ');
  parts.push(when || '오늘 할 일');
  if (x.note) parts.push(x.note);
  return parts.join(' · ');
}

let pushSyncTimer = null;
function queuePushSync() {
  if (!pushActive()) return;
  clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(syncPushNow, 800);
}
async function syncPushNow() {
  clearTimeout(pushSyncTimer);
  if (!pushActive()) return;
  const now = Date.now();
  const reminders = [...tasks.flatMap(upcomingReminders), ...briefingReminders()]
    .filter((r) => r.fireAt > now)
    .sort((a, b) => a.fireAt - b.fireAt)
    .slice(0, 500);
  try {
    await api('/sync', { reminders });
    pushError = '';
  } catch (err) {
    pushError = err.message;
    // 서버가 기기를 모르면(구독 만료 등) 다시 등록
    if (err.code === 'unknown-device') enablePush({ quiet: true });
  }
}

$('#lockTestBtn').addEventListener('click', async () => {
  try {
    await api('/test', { delaySec: 60 });
    toast('1분 안에 알림이 와요. 지금 화면을 잠가 보세요 🔒');
  } catch {
    toast('테스트 예약에 실패했어요');
  }
});

/* ---------------- pause all ---------------- */

$('#pauseAllBtn').addEventListener('click', () => {
  const until = $('#pauseAllUntil').value;
  if (!until || until <= todayStr()) { toast('내일 이후 날짜를 골라 주세요'); return; }
  const before = snapshot();
  const n = tasks.filter((x) => pauseTask(x, until)).length;
  if (!n) { toast('반복 할 일이 없어요'); return; }
  save();
  render();
  renderSettings();
  toast(`⏸ 루틴 ${n}개를 ${dateLabel(until)}까지 멈췄어요`, () => { restore(before); renderSettings(); });
});
$('#resumeAllBtn').addEventListener('click', () => {
  const n = tasks.filter((x) => resumeTask(x)).length;
  save();
  render();
  renderSettings();
  toast(`▶ 루틴 ${n}개를 다시 시작해요`);
});

/* ---------------- AI ---------------- */

const aiBackdrop = $('#aiBackdrop');
const aiForm = $('#aiForm');
let aiMode = 'plan';
let aiTasks = [];
const AI_PLACEHOLDER = {
  plan: '예) 다음 주 금요일 제주도 여행 준비할 것 정리해줘',
  today: '예) 오늘 6시 퇴근 후 운동도 하고 싶어. 오늘 할 일 순서 좀 짜줘',
  breakdown: '예) 이사 준비',
};
const AI_LABEL = { plan: '무엇을 도와드릴까요?', today: '오늘 상황을 알려 주세요', breakdown: '쪼갤 할 일' };
const AI_ERRORS = {
  'bad-passcode': '설정에서 AI 접근 코드를 확인해 주세요.',
  'ai-not-configured': '서버에 Gemini API 키가 아직 없어요.',
  'ai-daily-limit': '오늘 AI 사용 한도를 넘었어요. 내일 다시 써 주세요.',
};
// 서버가 돌려준 Gemini 원인 코드(ai-upstream-상태-이유)를 알아듣기 쉬운 말로
function aiErrorMessage(code = '') {
  if (AI_ERRORS[code]) return AI_ERRORS[code];
  if (/API_KEY_INVALID|API_KEY/.test(code)) return 'Gemini API 키가 올바르지 않아요. 키를 다시 넣어야 해요.';
  if (/-403-|PERMISSION_DENIED|SERVICE_DISABLED/.test(code)) return 'Gemini 키에 사용 권한이 없어요. Google AI Studio에서 키를 확인해 주세요.';
  if (/-429-|RESOURCE_EXHAUSTED/.test(code)) return 'Gemini 무료 사용량을 잠시 넘었어요. 조금 뒤 다시 시도해 주세요.';
  if (/-404-/.test(code)) return 'Gemini 모델을 찾지 못했어요.';
  if (/ai-bad-output-(SAFETY|BLOCK)/.test(code)) return 'AI가 이 요청에는 답하지 않았어요. 다르게 적어 보세요.';
  return `AI 응답을 받지 못했어요 (${code || '연결 오류'}).`;
}

function setAiMode(mode) {
  aiMode = mode;
  $$('#aiModes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('#aiText').placeholder = AI_PLACEHOLDER[mode];
  $('#aiLabel').textContent = AI_LABEL[mode];
}
function openAI(mode = 'plan', text = '') {
  if (!API_BASE) { toast('AI 서버가 아직 연결되지 않았어요'); return; }
  if (!settings.aiPasscode) {
    toast('설정에서 AI 접근 코드를 먼저 입력해 주세요');
    renderSettings();
    openSheet(settingsBackdrop);
    setTimeout(() => $('#aiPasscode').focus(), 100);
    return;
  }
  setAiMode(mode);
  $('#aiText').value = text;
  $('#aiResult').hidden = true;
  openSheet(aiBackdrop);
  setTimeout(() => $('#aiText').focus(), 50);
}
$$('#aiModes button').forEach((b) => b.addEventListener('click', () => { setAiMode(b.dataset.mode); $('#aiResult').hidden = true; }));
$('#aiBtn').addEventListener('click', () => openAI('plan', quickInput.value.trim()));
$('#breakdownBtn').addEventListener('click', () => {
  const title = form.title.value.trim();
  if (!title) { form.title.focus(); return; }
  const due = form.due.value;
  closeSheet(editBackdrop);
  openAI('breakdown', due ? `${title} (마감 ${due})` : title);
});

async function runAI() {
  const text = $('#aiText').value.trim();
  if (!text) { $('#aiText').focus(); return; }
  const btn = $('#aiSubmit');
  btn.disabled = true;
  btn.textContent = '생각하는 중…';
  try {
    const t = todayStr();
    const n = new Date();
    const context = tasks.filter((x) => !x.done && (aiMode !== 'today' || (x.due && x.due <= t)))
      .sort(sortTasks).slice(0, 60).map((x) => ({ title: x.title, due: x.due, time: x.time }));
    const data = await api('/ai', {
      passcode: settings.aiPasscode, mode: aiMode, text, context,
      today: `${t} (${WD[n.getDay()]}요일)`, now: `${pad(n.getHours())}:${pad(n.getMinutes())}`,
    });
    aiTasks = data.tasks || [];
    renderAIResult(data.message);
  } catch (err) {
    toast(aiErrorMessage(err.code));
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI에게 부탁하기';
  }
}

function findOpenByTitle(title) {
  const key = title.replace(/\s+/g, '');
  return tasks.find((x) => !x.done && x.title.replace(/\s+/g, '') === key);
}

function renderAIResult(message) {
  $('#aiResult').hidden = false;
  $('#aiMessage').textContent = message || (aiTasks.length ? '' : '만들 할 일을 찾지 못했어요.');
  $('#aiTasks').innerHTML = aiTasks.map((x, i) => {
    const meta = [x.due ? dateLabel(x.due) : '', x.time ? timeLabel(x.time) : '', x.repeat !== 'none' ? `🔁 ${repeatLabel(normalizeRepeat({ ...x }))}` : '', x.important ? '⭐' : '']
      .filter(Boolean).join(' · ');
    const existing = aiMode === 'today' && findOpenByTitle(x.title);
    return `<label class="ai-item"><input type="checkbox" data-i="${i}" checked />
      <div><div class="t">${esc(x.title)}${existing ? '<span class="tag">시간 조정</span>' : ''}</div>
      ${meta ? `<div class="m">${esc(meta)}</div>` : ''}${x.note ? `<div class="m">${esc(x.note)}</div>` : ''}</div></label>`;
  }).join('');
  $('#aiApply').hidden = !aiTasks.length;
}

aiForm.addEventListener('submit', (e) => { e.preventDefault(); runAI(); });
$('#aiRetry').addEventListener('click', runAI);
$('#aiApply').addEventListener('click', () => {
  const picked = $$('#aiTasks input:checked').map((el) => aiTasks[Number(el.dataset.i)]);
  if (!picked.length) { toast('추가할 항목을 골라 주세요'); return; }
  const before = snapshot();
  let added = 0;
  let updated = 0;
  for (const p of picked) {
    const existing = aiMode === 'today' && findOpenByTitle(p.title);
    if (existing) {
      existing.due = p.due || existing.due;
      if (p.time) { existing.time = p.time; if (existing.remind == null) existing.remind = 0; }
      existing.snoozeUntil = null;
      settleReminder(existing);
      updated++;
      continue;
    }
    const task = newTask({ ...p, remind: p.time ? 0 : null });
    task.createdAt = Date.now() + added;
    tasks.push(task);
    added++;
  }
  save();
  render();
  closeSheet(aiBackdrop);
  quickInput.value = '';
  preview.hidden = true;
  toast([added && `${added}개 추가`, updated && `${updated}개 시간 조정`].filter(Boolean).join(' · ') + ' 했어요', () => restore(before));
  if (picked.some((p) => p.time)) maybeAskPermission();
});

/* ---------------- 백업·동기화 ---------------- */
// 동기화 코드 하나로 space id·쓰기 토큰·암호 키를 만들어 냄. 서버에는 암호문만 올라감

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = (s) => normCode(s).match(/.{1,4}/g)?.join('-') || '';
function newSyncCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return fmtCode([...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join(''));
}
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let syncKeysCache = null;
async function syncKeys(code = syncMeta.code) {
  const c = normCode(code);
  if (syncKeysCache?.c === c) return syncKeysCache;
  const space = toHex(await sha256(`todo-sync|space|${c}`)).slice(0, 32);
  const token = toHex(await sha256(`todo-sync|write|${c}`));
  const key = await crypto.subtle.importKey('raw', await sha256(`todo-sync|key|${c}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
  syncKeysCache = { c, space, token, key };
  return syncKeysCache;
}
async function encryptJSON(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  // 큰 배열에서도 안전하게 base64로
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return `${toB64(iv)}.${btoa(bin)}`;
}
async function decryptJSON(blob, key) {
  const [iv, data] = blob.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(data));
  return JSON.parse(new TextDecoder().decode(plain));
}

const stamp = (x) => x.updatedAt || x.createdAt || 0;
function mergeData(remote) {
  const tombs = { ...(remote.tombs || {}) };
  for (const [id, t] of Object.entries(syncMeta.tombs)) tombs[id] = Math.max(tombs[id] || 0, t);
  const byId = new Map();
  // 같은 시각이면 이 기기 쪽을 우선
  for (const x of [...tasks, ...(remote.tasks || [])]) {
    const cur = byId.get(x.id);
    if (!cur || stamp(x) > stamp(cur)) byId.set(x.id, x);
  }
  const merged = [...byId.values()].filter((x) => !(tombs[x.id] >= stamp(x)));
  const cutoff = Date.now() - 90 * 86400e3;
  for (const [id, t] of Object.entries(tombs)) if (t < cutoff) delete tombs[id];
  return { merged, tombs };
}
const fingerprint = (list, tombs) => JSON.stringify([
  list.map((x) => `${x.id}:${stamp(x)}`).sort(),
  Object.keys(tombs || {}).sort(),
]);

let dataSyncTimer = null;
let dataSyncing = null;
let syncAgain = false;
let syncError = '';
function queueDataSync() {
  if (!API_BASE || !syncMeta.code) return;
  clearTimeout(dataSyncTimer);
  dataSyncTimer = setTimeout(() => syncData(), 1500);
}

async function syncData({ attempt = 0 } = {}) {
  if (!API_BASE || !syncMeta.code) return false;
  if (dataSyncing) { syncAgain = true; return dataSyncing; }
  clearTimeout(dataSyncTimer);
  dataSyncing = (async () => {
    try {
      const k = await syncKeys();
      const remote = await api('/data/get', { space: k.space });
      const remoteData = remote.blob ? await decryptJSON(remote.blob, k.key) : { tasks: [], tombs: {} };

      // Siri 등으로 들어온 할 일 (처음엔 space가 없어서 실패할 수 있음)
      let inbox = [];
      if (remote.blob) {
        try { inbox = (await api('/inbox/take', { space: k.space, token: k.token })).items || []; } catch { /* 다음에 다시 */ }
      }

      // 여기서부터는 await 없이 합쳐서, 그 사이 이 기기에서 고친 내용이 덮이지 않게 함
      const before = fingerprint(tasks, syncMeta.tombs);
      const { merged, tombs } = mergeData(remoteData);
      for (const it of inbox) {
        const p = parseQuick(it.text);
        const task = newTask({ ...p, remind: p.time ? 0 : null, due: p.due || todayStr() });
        task.updatedAt = Date.now();
        merged.push(task);
      }
      const inboxCount = inbox.length;

      tasks = merged;
      syncMeta.tombs = tombs;
      sigMap = new Map(tasks.map((x) => [x.id, taskSig(x)]));
      safeSet(STORE_KEY, tasks);

      if (fingerprint(merged, tombs) !== fingerprint(remoteData.tasks || [], remoteData.tombs)) {
        const blob = await encryptJSON({ v: 1, tasks: merged, tombs }, k.key);
        try {
          const res = await api('/data/put', { space: k.space, token: k.token, blob, baseVersion: remote.version });
          syncMeta.version = res.version;
        } catch (err) {
          if (err.status === 409 && attempt < 3) { dataSyncing = null; return syncData({ attempt: attempt + 1 }); }
          throw err;
        }
      } else {
        syncMeta.version = remote.version;
      }
      syncMeta.lastSync = Date.now();
      safeSet(SYNC_KEY, syncMeta);
      syncError = '';
      if (fingerprint(tasks, syncMeta.tombs) !== before) {
        render();
        scheduleReminders();
        queuePushSync();
        queueFeedPublish();
      }
      if (inboxCount) toast(`🎙 Siri로 추가한 할 일 ${inboxCount}개를 가져왔어요`);
      return true;
    } catch (err) {
      syncError = err.code || err.message || String(err);
      return false;
    } finally {
      dataSyncing = null;
      if (!settingsBackdrop.hidden) renderSyncSettings();
      // 동기화 도중 이 기기에서 또 바뀌었으면 한 번 더
      if (syncAgain) { syncAgain = false; queueDataSync(); }
    }
  })();
  return dataSyncing;
}

function renderSyncSettings() {
  const on = !!syncMeta.code;
  $('#syncSection').hidden = !API_BASE;
  $('#syncOff').hidden = on;
  $('#syncOn').hidden = !on;
  if (!on) return;
  $('#syncCode').textContent = fmtCode(syncMeta.code);
  const last = syncMeta.lastSync ? new Date(syncMeta.lastSync) : null;
  $('#syncStatus').textContent = syncError
    ? `⚠ 동기화하지 못했어요 (${syncError}). 인터넷 연결을 확인해 주세요.`
    : last ? `✅ 마지막 백업: ${dateLabel(ymd(last))} ${timeLabel(`${pad(last.getHours())}:${pad(last.getMinutes())}`)}` : '백업 중…';
  syncKeys().then((k) => { $('#siriUrl').textContent = `${API_BASE}/inbox?s=${k.space}&t=`; }).catch(() => {});
}

$('#syncStartBtn').addEventListener('click', async () => {
  syncMeta.code = newSyncCode();
  syncMeta.version = 0;
  safeSet(SYNC_KEY, syncMeta);
  renderSyncSettings();
  const ok = await syncData();
  toast(ok ? '☁️ 자동 백업을 켰어요. 코드를 꼭 메모해 두세요' : '백업 서버에 연결하지 못했어요');
});
$('#syncJoinBtn').addEventListener('click', async () => {
  const code = normCode($('#syncJoinInput').value);
  if (code.length !== 16) { toast('코드 16자리를 확인해 주세요'); return; }
  const prev = { ...syncMeta };
  syncMeta.code = fmtCode(code);
  syncMeta.version = 0;
  const k = await syncKeys();
  try {
    const remote = await api('/data/get', { space: k.space });
    if (!remote.blob) { Object.assign(syncMeta, prev); toast('이 코드로 저장된 백업이 없어요'); return; }
  } catch {
    Object.assign(syncMeta, prev);
    toast('서버에 연결하지 못했어요');
    return;
  }
  safeSet(SYNC_KEY, syncMeta);
  $('#syncJoinInput').value = '';
  const ok = await syncData();
  renderSyncSettings();
  toast(ok ? '🔗 연결했어요. 두 기기의 할 일을 합쳤어요' : '연결에 실패했어요');
});
$('#syncNowBtn').addEventListener('click', async () => {
  const ok = await syncData();
  toast(ok ? '지금 백업했어요' : '백업에 실패했어요');
});
$('#syncCopyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(fmtCode(syncMeta.code)); toast('코드를 복사했어요'); } catch { toast('복사하지 못했어요. 직접 적어 두세요'); }
});
$('#siriCopyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#siriUrl').textContent); toast('주소를 복사했어요'); } catch { toast('복사하지 못했어요'); }
});
$('#syncStopBtn').addEventListener('click', () => {
  if (!confirm('이 기기에서 동기화를 끌까요? 할 일은 이 기기에 그대로 남고, 서버 백업도 지워지지 않아요.')) return;
  syncMeta.code = null;
  syncMeta.version = 0;
  safeSet(SYNC_KEY, syncMeta);
  syncKeysCache = null;
  renderSyncSettings();
  toast('동기화를 껐어요');
});

/* ---------------- 캘린더 구독 피드 ---------------- */
// 켜 두면 할 일을 서버의 .ics 피드로 올림 → 아이폰 캘린더·위젯에 표시 (이 부분만 평문)

const FEED_PAST_DAYS = 7;
const FEED_FUTURE_DAYS = 60;
let feedTimer = null;
let feedError = '';

const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const feedUrl = (scheme = 'https') => `${API_BASE.replace(/^https:/, `${scheme}:`)}/cal/${settings.calFeed.id}.ics`;

function feedEvent(x, date, prefix = '', allDay = false) {
  const hourly = x.everyHours && !x.done;
  const title = `${prefix}${x.important ? '⭐ ' : ''}${hourly ? `${iconOf(x)} ` : ''}${x.title}${hourly ? ` (${x.everyHours}시간마다)` : ''}`;
  const base = { uid: `${x.id}@${date}`, title, note: x.note || '' };
  if (x.everyHours && !x.done && !allDay) {
    // 시작~끝 시간을 하나의 일정으로
    return { ...base, allDay: false, start: at(date, x.time), minutes: Math.max(toMin(x.endTime) - toMin(x.time), 30) };
  }
  return x.time && !allDay
    ? { ...base, allDay: false, start: at(date, x.time), minutes: 30 }
    : { ...base, allDay: true, date };
}

function buildFeedEvents() {
  const t = todayStr();
  const from = addDays(t, -FEED_PAST_DAYS);
  const to = addDays(t, FEED_FUTURE_DAYS);
  const events = [];
  for (const x of tasks) {
    if (!x.due) continue;
    if (x.done) {
      // 최근 완료한 일은 완료한 날에 ✓ 표시로 남겨 둠 (오늘 얼마나 했는지 위젯에서 보이게)
      const d = x.doneAt ? ymd(new Date(x.doneAt)) : x.due;
      if (d >= from && d <= t) events.push(feedEvent(x, d, '✓ ', d !== x.due));
      continue;
    }
    const routine = x.repeat && x.repeat !== 'none';
    if (!routine && x.due < t) {
      events.push(feedEvent(x, t, '⚠ ', true)); // 밀린 일은 오늘 칸에
      continue;
    }
    for (const d of occurrencesBetween(x, t, to)) events.push(feedEvent(x, d));
  }
  return events.slice(0, 1000);
}

function queueFeedPublish() {
  if (!API_BASE || !settings.calFeed) return;
  clearTimeout(feedTimer);
  feedTimer = setTimeout(publishFeed, 3000);
}

async function publishFeed() {
  clearTimeout(feedTimer);
  if (!API_BASE || !settings.calFeed) return false;
  try {
    await api('/feed/put', { feed: settings.calFeed.id, token: settings.calFeed.token, events: buildFeedEvents() });
    settings.calFeed.last = Date.now();
    safeSet(SETTINGS_KEY, settings);
    feedError = '';
    return true;
  } catch (err) {
    feedError = err.code || err.message || String(err);
    return false;
  } finally {
    renderFeedSettings();
  }
}

function renderFeedSettings() {
  const on = !!settings.calFeed;
  $('#feedSection').hidden = !API_BASE;
  $('#feedOnActions').hidden = !on;
  renderLockGuide();
  if (!on) { $('#feedStatus').textContent = ''; return; }
  const last = settings.calFeed.last ? new Date(settings.calFeed.last) : null;
  $('#feedStatus').textContent = feedError
    ? `⚠ 캘린더에 올리지 못했어요 (${feedError}). 인터넷 연결을 확인해 주세요.`
    : last ? `✅ 캘린더 구독 켜짐 · 마지막 반영 ${dateLabel(ymd(last))} ${timeLabel(`${pad(last.getHours())}:${pad(last.getMinutes())}`)}` : '올리는 중…';
}

/* 잠금화면 3단계 안내: ① 구독 켜기 ② 아이폰 캘린더에 추가 ③ 잠금화면 위젯 */
const lockGuideBackdrop = $('#lockGuideBackdrop');
function renderLockGuide() {
  const on = !!settings.calFeed;
  const g = settings.lockGuide || {};
  $('#gStep1').classList.toggle('done', on);
  for (const [n, done] of [[2, g.s2], [3, g.s3]]) {
    $(`#gStep${n}`).classList.toggle('locked', !on);
    $(`#gStep${n}`).classList.toggle('done', on && !!done);
    $(`#gCheck${n}`).checked = !!done;
  }
  if (on) $('#feedSubscribe').href = feedUrl('webcal');
  $('#guideFinish').hidden = !(on && g.s2 && g.s3);
  $('#lockTip').hidden = !API_BASE || on || !!settings.lockTipDismissed;
}
function openLockGuide() {
  closeSheet(settingsBackdrop);
  renderLockGuide();
  openSheet(lockGuideBackdrop);
}
function setGuideStep(key, value) {
  settings.lockGuide = { ...(settings.lockGuide || {}), [key]: value };
  safeSet(SETTINGS_KEY, settings);
  renderLockGuide();
}
$('#lockGuideOpen').addEventListener('click', openLockGuide);
$('#lockTipOpen').addEventListener('click', openLockGuide);
$('#lockTipClose').addEventListener('click', () => {
  settings.lockTipDismissed = true;
  safeSet(SETTINGS_KEY, settings);
  renderLockGuide();
  toast('설정 → “잠금화면 · 위젯에 할 일 띄우기”에서 언제든 할 수 있어요');
});
$('#feedSubscribe').addEventListener('click', () => setTimeout(() => setGuideStep('s2', true), 500));
$('#gCheck2').addEventListener('change', (e) => setGuideStep('s2', e.target.checked));
$('#gCheck3').addEventListener('change', (e) => {
  setGuideStep('s3', e.target.checked);
  if (e.target.checked && settings.lockGuide?.s2) toast('🎉 다 됐어요! 잠금화면을 확인해 보세요');
});

$('#feedStartBtn').addEventListener('click', async () => {
  settings.calFeed = { id: randomHex(16), token: randomHex(32), last: 0 };
  safeSet(SETTINGS_KEY, settings);
  renderFeedSettings();
  const ok = await publishFeed();
  if (!ok) { settings.calFeed = null; safeSet(SETTINGS_KEY, settings); renderFeedSettings(); }
  toast(ok ? '✅ 1단계 완료! 이제 “캘린더에 추가”를 눌러 주세요' : '서버에 연결하지 못했어요. 잠시 뒤 다시 눌러 주세요');
});
$('#feedCopyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(feedUrl('https')); toast('구독 주소를 복사했어요'); } catch { toast('복사하지 못했어요'); }
});
$('#feedStopBtn').addEventListener('click', async () => {
  if (!confirm('캘린더 구독을 끌까요? 서버에 올린 할 일 목록도 지워져요. 아이폰 캘린더에서는 구독 캘린더를 따로 삭제해 주세요.')) return;
  const feed = settings.calFeed;
  try { await api('/feed/delete', { feed: feed.id, token: feed.token }); } catch { /* 이미 없으면 무시 */ }
  settings.calFeed = null;
  settings.lockGuide = {};
  safeSet(SETTINGS_KEY, settings);
  renderFeedSettings();
  toast('캘린더 구독을 껐어요');
});

/* ---------------- settings ---------------- */

const settingsBackdrop = $('#settingsBackdrop');
let installEvent = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function renderSettings() {
  const status = $('#permStatus');
  const enable = $('#enableNotify');
  if (!('Notification' in window)) {
    status.textContent = isIOS && !isStandalone
      ? '아이폰은 홈 화면에 설치한 뒤 알림을 켤 수 있어요.'
      : '이 브라우저는 알림을 지원하지 않아요.';
    enable.hidden = true;
  } else {
    const p = Notification.permission;
    status.textContent = p === 'granted' ? '✅ 알림이 켜져 있어요.' : p === 'denied' ? '⛔ 알림이 차단돼 있어요. 브라우저(앱) 설정에서 알림을 허용해 주세요.' : '알림이 아직 꺼져 있어요.';
    enable.hidden = p !== 'default';
  }
  $('#testNotify').hidden = !('Notification' in window) || Notification.permission !== 'granted';
  const push = $('#pushStatus');
  if (!API_BASE) push.textContent = '';
  else if (pushActive()) push.textContent = pushError ? `⚠ 서버 알림 동기화 오류 (${pushError}) — 앱을 다시 열면 재시도해요.` : '📡 서버 알림 연결됨 · 앱을 닫거나 잠금화면이어도 알림이 와요.';
  else if ('Notification' in window && Notification.permission === 'granted') push.textContent = '📡 서버 알림이 아직 연결되지 않았어요. “알림 켜기”를 눌러 주세요.';
  else push.textContent = '';
  if ('Notification' in window && Notification.permission === 'granted' && API_BASE && !pushActive()) enable.hidden = false;
  $('#lockTestBtn').hidden = !pushActive();
  $('#defaultTime').value = settings.defaultTime;
  $('#briefOn').checked = !!settings.briefOn;
  $('#briefTime').value = settings.briefTime || '08:00';
  $('#briefTime').disabled = !settings.briefOn;
  $('.brief-row').hidden = !API_BASE;
  renderSyncSettings();
  renderFeedSettings();

  const pausedRoutines = tasks.filter((x) => !x.done && isPaused(x));
  const routines = tasks.filter(isRoutine);
  $('#pauseAllStatus').textContent = pausedRoutines.length
    ? `⏸ 루틴 ${pausedRoutines.length}개가 쉬는 중이에요 (${dateLabel(pausedRoutines.map((x) => x.pausedUntil).sort().at(-1))}까지).`
    : routines.length ? `반복 할 일 ${routines.length}개를 한 번에 멈출 수 있어요. 여행처럼 못 지키는 기간에 써 보세요.` : '반복 할 일이 생기면 여기서 한 번에 멈출 수 있어요.';
  $('#pauseAllUntil').min = addDays(todayStr(), 1);
  if (!$('#pauseAllUntil').value) $('#pauseAllUntil').value = addDays(todayStr(), 7);
  $('#resumeAllBtn').hidden = !pausedRoutines.length;
  $('#aiPasscode').value = settings.aiPasscode || '';
  $('#aiPasscode').closest('.set-group').hidden = !API_BASE;
  const hint = $('#installHint');
  if (isStandalone) hint.textContent = '✅ 홈 화면 앱으로 실행 중이에요.';
  else if (isIOS) hint.textContent = 'Safari 하단의 공유 버튼(□↑) → “홈 화면에 추가”를 눌러 설치하세요.';
  else if (installEvent) hint.textContent = '앱처럼 설치하면 더 빠르게 열고 알림도 잘 받을 수 있어요.';
  else hint.textContent = '브라우저 메뉴의 “앱 설치” 또는 “홈 화면에 추가”로 설치할 수 있어요.';
  $('#installBtn').hidden = !installEvent || isStandalone;
}

$('#settingsBtn').addEventListener('click', () => { renderSettings(); openSheet(settingsBackdrop); });
$('#enableNotify').addEventListener('click', () => (
  'Notification' in window && Notification.permission === 'granted' ? enablePush() : requestPermission()
));
$('#aiPasscode').addEventListener('change', (e) => {
  settings.aiPasscode = e.target.value.trim();
  safeSet(SETTINGS_KEY, settings);
  toast(settings.aiPasscode ? 'AI 접근 코드를 저장했어요' : 'AI 접근 코드를 지웠어요');
});
$('#testNotify').addEventListener('click', async () => {
  const ok = await showSystemNotification('to do list 알림 테스트', {
    body: '이렇게 정해진 시각에 알려드려요 🔔', tag: 'test', icon: 'icons/icon-192.png',
  });
  toast(ok ? '테스트 알림을 보냈어요' : '알림을 보낼 수 없어요');
});
$('#defaultTime').addEventListener('change', (e) => {
  settings.defaultTime = e.target.value || '09:00';
  safeSet(SETTINGS_KEY, settings);
  tasks.filter((x) => !x.time).forEach(settleReminder);
  save();
  render();
});
$('#briefOn').addEventListener('change', (e) => {
  settings.briefOn = e.target.checked;
  safeSet(SETTINGS_KEY, settings);
  $('#briefTime').disabled = !settings.briefOn;
  syncPushNow();
  toast(settings.briefOn ? `매일 ${timeLabel(settings.briefTime)}에 오늘 할 일을 알려드려요` : '아침 브리핑을 껐어요');
});
$('#briefTime').addEventListener('change', (e) => {
  settings.briefTime = e.target.value || '08:00';
  safeSet(SETTINGS_KEY, settings);
  syncPushNow();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  renderSettings();
});
$('#installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  renderSettings();
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks, settings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `todo-backup-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.tasks;
    if (!Array.isArray(incoming)) throw new Error('형식 오류');
    const valid = incoming.filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string');
    const before = snapshot();
    const known = new Set(tasks.map((x) => x.id));
    tasks.push(...valid.filter((x) => !known.has(x.id)));
    save();
    render();
    toast(`${valid.length}개 항목을 불러왔어요`, () => restore(before));
  } catch {
    toast('백업 파일을 읽을 수 없어요');
  }
});
$('#clearDoneBtn').addEventListener('click', () => {
  const n = tasks.filter((x) => x.done).length;
  if (!n) { toast('완료 항목이 없어요'); return; }
  const before = snapshot();
  tasks = tasks.filter((x) => !x.done);
  save();
  render();
  toast(`완료 항목 ${n}개를 비웠어요`, () => restore(before));
});

/* ---------------- boot ---------------- */

let lastDay = todayStr();
function tick() {
  if (todayStr() !== lastDay) {
    lastDay = todayStr();
    if (clearExpiredPauses()) safeSet(STORE_KEY, tasks);
    render();
    syncPushNow(); // 루틴 알림 범위를 하루 앞으로 늘림
    queueFeedPublish(); // 밀린 일을 새 "오늘" 칸으로
  }
  scheduleReminders();
  // 화면을 보고 있는 동안 1분마다 다른 기기 변경 사항을 가져옴
  if (syncMeta.code && document.visibilityState === 'visible' && Date.now() - syncMeta.lastSync > 60000) syncData();
}
setInterval(tick, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); tick(); syncPushNow(); syncData(); }
});

if (clearExpiredPauses()) safeSet(STORE_KEY, tasks);
// 예전 반복 형식(평일, 요일 없는 매주)을 요일 선택 방식으로 바꿔 둠
const legacyRoutines = tasks.filter((x) => !x.done && (x.repeat === 'weekdays' || (x.repeat === 'weekly' && !x.repeatDays?.length)));
if (legacyRoutines.length) { legacyRoutines.forEach(normalizeRepeat); save(); }
render();
renderLockGuide(); // 첫 화면의 "잠금화면에 띄우기" 안내 카드
scheduleReminders();
syncData();
// 앱을 열 때마다 구독을 다시 확인 (iOS는 구독이 바뀌거나 만료될 수 있음)
if (API_BASE && 'Notification' in window && Notification.permission === 'granted') enablePush({ quiet: true });

// 알림의 버튼으로 앱이 새로 열린 경우 (?action=done&id=...)
const params = new URLSearchParams(location.search);
if (params.get('action')) {
  handleAction(params.get('action'), params.get('id'));
  history.replaceState(null, '', location.pathname);
}
