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
let settings = { defaultTime: '09:00', ...safeGet(SETTINGS_KEY, {}) };
let view = safeGet(VIEW_KEY, 'today');
if (!['today', 'upcoming', 'all', 'done'].includes(view)) view = 'today';

function save() {
  safeSet(STORE_KEY, tasks);
  scheduleReminders();
  queuePushSync();
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

const REPEAT_LABEL = { none: '', daily: '매일', weekdays: '평일', weekly: '매주', monthly: '매월' };
const REMIND_LABEL = { 0: '정시', 5: '5분 전', 10: '10분 전', 30: '30분 전', 60: '1시간 전', 1440: '하루 전' };

function stepRepeat(dateStr, repeat, anchorDay) {
  switch (repeat) {
    case 'daily': return addDays(dateStr, 1);
    case 'weekdays': {
      let n = addDays(dateStr, 1);
      while ([0, 6].includes(parseYmd(n).getDay())) n = addDays(n, 1);
      return n;
    }
    case 'weekly': return addDays(dateStr, 7);
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
  let n = stepRepeat(task.due, task.repeat, task.anchorDay);
  while (n < t) n = stepRepeat(n, task.repeat, task.anchorDay);
  return n;
}

/* ---------------- 루틴 일시정지 ---------------- */

const isRoutine = (x) => !x.done && x.repeat && x.repeat !== 'none' && x.due;
const isPaused = (x) => !!x.pausedUntil && x.pausedUntil > todayStr();

// start부터 반복 규칙대로 넘겨 target 이후 첫 날짜를 찾음
function firstOnOrAfter(task, start, target) {
  let n = start;
  while (n < target) n = stepRepeat(n, task.repeat, task.anchorDay);
  return n;
}
function pauseTask(x, until) {
  if (!isRoutine(x)) return false;
  if (!x.pausedUntil) x.pauseFrom = x.due;
  x.pausedUntil = until;
  x.due = firstOnOrAfter(x, x.pauseFrom || x.due, until);
  x.snoozeUntil = null;
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
  if (task.done || !task.due || task.remind == null) return null;
  if (task.snoozeUntil) return task.snoozeUntil;
  const base = at(task.due, task.time || settings.defaultTime);
  return base - task.remind * 60000;
}
// 이미 지난 알림 시각으로 저장하면 곧바로 울리지 않도록 처리
function settleReminder(task) {
  const f = fireTime(task);
  task.notifiedKey = f != null && f <= Date.now() ? String(f) : null;
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
  const out = { title: '', due: null, time: null, repeat: 'none', important: false, anchorDay: null };
  const t = todayStr();
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    if (fn(m) === false) return false;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return true;
  };

  // 반복
  take(new RegExp(`\\s매주\\s?${WD_RE}(?:마다)?${PARTICLE}${END}`), (m) => {
    out.repeat = 'weekly';
    out.due = upcomingWeekday(WD.indexOf(m[1]));
  }) ||
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
  take(new RegExp(`\\s(?:평일|주중)(?:마다)?${PARTICLE}${END}`), () => { out.repeat = 'weekdays'; }) ||
  take(new RegExp(`\\s매주(?:마다)?${END}`), () => { out.repeat = 'weekly'; }) ||
  take(new RegExp(`\\s(?:매달|매월)(?:마다)?${END}`), () => { out.repeat = 'monthly'; });

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

  // 시간
  const AP = '(오전|오후|아침|낮|점심|저녁|밤|새벽)?\\s?';
  take(new RegExp(`\\s${AP}(\\d{1,2})시\\s?(?:(\\d{1,2})분|(반))?${PARTICLE}${END}`), (m) => setTime(m[1], +m[2], m[4] ? 30 : +(m[3] || 0))) ||
  take(new RegExp(`\\s${AP}(\\d{1,2}):(\\d{2})${PARTICLE}${END}`), (m) => setTime(m[1], +m[2], +m[3])) ||
  take(new RegExp(`\\s정오${PARTICLE}${END}`), () => setTime('', 12, 0));
  function setTime(ap, h, mi) {
    if (h > 24 || mi > 59) return false;
    if (['오후', '저녁', '밤'].includes(ap) && h < 12) h += 12;
    else if (['낮', '점심'].includes(ap) && h <= 6) h += 12;
    else if (['오전', '아침', '새벽'].includes(ap) && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 6) h += 12; // "3시" → 오후 3시
    if (h === 24) h = 0;
    out.time = `${pad(h)}:${pad(mi)}`;
  }

  // 중요
  take(/\s(?:!+|중요)(?=\s)/, () => { out.important = true; });

  if (out.time && !out.due) out.due = at(t, out.time) > Date.now() ? t : addDays(t, 1);
  if (out.repeat !== 'none' && !out.due) out.due = t;
  if (out.repeat === 'weekdays' && out.due) {
    while ([0, 6].includes(parseYmd(out.due).getDay())) out.due = addDays(out.due, 1);
  }
  if (out.repeat === 'monthly' && !out.anchorDay && out.due) out.anchorDay = parseYmd(out.due).getDate();

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
  if (x.due) {
    const late = !x.done && x.due < t;
    const showDate = !(view === 'today' && x.due === t) && !(view === 'upcoming');
    let label = showDate ? dateLabel(x.due) : '';
    if (x.time) label = `${label} ${timeLabel(x.time)}`.trim();
    const pastTime = !x.done && x.due === t && x.time && at(x.due, x.time) < Date.now();
    const soon = !x.done && x.due === t && x.time && !pastTime && at(x.due, x.time) - Date.now() < 3600e3;
    if (label) meta.push(`<span class="${late || pastTime ? 'late' : soon ? 'soon' : ''}">${late ? '⚠ ' : ''}${esc(label)}</span>`);
  }
  if (x.repeat && x.repeat !== 'none') meta.push(`<span>🔁 ${REPEAT_LABEL[x.repeat]}</span>`);
  if (!x.done && isPaused(x)) meta.push(`<span class="paused">⏸ ${esc(dateLabel(x.pausedUntil, false))}까지 쉬는 중</span>`);
  if (!x.done && x.due && x.remind != null) meta.push(`<span title="알림">🔔 ${x.snoozeUntil ? `${SNOOZE_MIN}분 뒤` : REMIND_LABEL[x.remind] ?? ''}</span>`);
  return `
    <article class="task${x.done ? ' done' : ''}${x.important ? ' important' : ''}" data-id="${x.id}">
      <button class="check" aria-label="${x.done ? '완료 취소' : '완료'}">${CHECK_SVG}</button>
      <div class="task-body">
        <div class="task-title">${esc(x.title)}</div>
        ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
        ${x.note ? `<div class="note-preview">${esc(x.note)}</div>` : ''}
      </div>
      <button class="star${x.important ? ' on' : ''}" aria-label="중요 표시" aria-pressed="${!!x.important}">${STAR_SVG(x.important)}</button>
    </article>`;
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
        <div class="section-head ${g.cls || ''}">${esc(g.title)} <span class="count">${g.items.length}</span></div>
        ${g.items.map(taskHTML).join('')}
      </section>`).join('');
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
  const apply = () => {
    if (!x.done && x.repeat && x.repeat !== 'none' && x.due) {
      tasks.push({ ...x, id: uid(), repeat: 'none', done: true, doneAt: Date.now(), notifiedKey: null, snoozeUntil: null, pausedUntil: null, pauseFrom: null });
      x.pausedUntil = null;
      x.pauseFrom = null;
      x.due = nextDue(x);
      x.snoozeUntil = null;
      settleReminder(x);
      toast(`완료! 다음 일정: ${dateLabel(x.due)}`, () => restore(before));
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
  const el = animate && list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) {
    if (!x.done) el.classList.add('done');
    setTimeout(() => el.classList.add('leaving'), 160);
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

function addTask(data) {
  const task = {
    id: uid(),
    title: data.title,
    note: data.note || '',
    due: data.due || null,
    time: data.time || null,
    remind: data.remind ?? null,
    repeat: data.repeat || 'none',
    anchorDay: data.anchorDay || null,
    important: !!data.important,
    done: false,
    doneAt: null,
    createdAt: Date.now(),
    notifiedKey: null,
    snoozeUntil: null,
  };
  settleReminder(task);
  tasks.push(task);
  save();
  render();
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
  if (p.time) pills.push(`⏰ ${timeLabel(p.time)}`);
  if (p.repeat !== 'none') pills.push(`🔁 ${REPEAT_LABEL[p.repeat]}`);
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
  form.repeat.value = src.repeat || 'none';
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
  if (!due) { hint.textContent = '날짜를 정하면 알림이 울려요.'; return; }
  const f = at(due, form.time.value || settings.defaultTime) - Number(remind) * 60000;
  const d = new Date(f);
  const when = `${dateLabel(ymd(d))} ${timeLabel(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}`;
  hint.textContent = f < Date.now() ? `⚠ 알림 시각(${when})이 이미 지났어요.` : `🔔 ${when}에 알려드려요.`;
}

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
    important: form.important.checked,
  };
  if ((data.time || data.repeat !== 'none') && !data.due) data.due = todayStr();
  data.anchorDay = data.repeat === 'monthly' && data.due ? parseYmd(data.due).getDate() : null;

  if (editingId) {
    const x = findTask(editingId);
    const timingChanged = x.due !== data.due || x.time !== data.time || x.remind !== data.remind;
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
  };
  if (!data.due) return;
  downloadICS(data);
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

list.addEventListener('click', (e) => {
  const row = e.target.closest('.task');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.check')) toggleDone(id);
  else if (e.target.closest('.star')) toggleImportant(id);
  else if (e.target.closest('.task-body')) openEditor(findTask(id));
});

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
  const rule = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' }[t.repeat];
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
  if (x.time) parts.push(`${x.due === todayStr() ? '' : `${dateLabel(x.due)} `}${timeLabel(x.time)}`);
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
        x.notifiedKey = String(fireTime(x));
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

function handleAction(action, id) {
  if (!id || !findTask(id)) return;
  if (action === 'done') { const x = findTask(id); if (!x.done) toggleDone(id, { animate: false }); }
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

function reminderBody(x, fireAt) {
  const fireDay = ymd(new Date(fireAt));
  const parts = [];
  const d = parseYmd(x.due);
  const dayText = x.due === fireDay ? '' : `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
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
  const reminders = tasks
    .map((x) => ({ x, f: fireTime(x) }))
    .filter(({ x, f }) => f != null && f > now && x.notifiedKey !== String(f))
    .sort((a, b) => a.f - b.f)
    .slice(0, 500)
    .map(({ x, f }) => ({ id: x.id, fireAt: f, title: x.title, body: reminderBody(x, f) }));
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
    toast(AI_ERRORS[err.code] || 'AI 응답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.');
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
    const meta = [x.due ? dateLabel(x.due) : '', x.time ? timeLabel(x.time) : '', x.repeat !== 'none' ? `🔁 ${REPEAT_LABEL[x.repeat]}` : '', x.important ? '⭐' : '']
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
    const task = {
      id: uid(), title: p.title, note: p.note || '', due: p.due, time: p.time,
      remind: p.time ? 0 : null, repeat: p.repeat, important: p.important,
      anchorDay: p.repeat === 'monthly' && p.due ? parseYmd(p.due).getDate() : null,
      done: false, doneAt: null, createdAt: Date.now() + added, notifiedKey: null, snoozeUntil: null,
    };
    if (task.repeat !== 'none' && !task.due) task.due = todayStr();
    settleReminder(task);
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
  }
  scheduleReminders();
}
setInterval(tick, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); tick(); syncPushNow(); }
});

if (clearExpiredPauses()) safeSet(STORE_KEY, tasks);
render();
scheduleReminders();
// 앱을 열 때마다 구독을 다시 확인 (iOS는 구독이 바뀌거나 만료될 수 있음)
if (API_BASE && 'Notification' in window && Notification.permission === 'granted') enablePush({ quiet: true });

// 알림의 버튼으로 앱이 새로 열린 경우 (?action=done&id=...)
const params = new URLSearchParams(location.search);
if (params.get('action')) {
  handleAction(params.get('action'), params.get('id'));
  history.replaceState(null, '', location.pathname);
}
