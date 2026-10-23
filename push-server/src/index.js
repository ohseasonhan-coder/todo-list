// to do list 서버 (Cloudflare Worker)
// - Web Push: 기기별 구독 저장 + 매분 cron으로 알림 시각이 된 할 일을 푸시
// - AI: Gemini로 문장을 할 일 목록으로 바꾸거나 큰 일을 잘게 쪼갬 (접근 코드 필요)

import { sendPush } from './webpush.js';

const MAX_REMINDERS = 500;
const AI_DAILY_LIMIT = 100;
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.notify\.windows\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/];
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.expose ? err.message : 'server-error' }, status, cors);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },
};

/* ---------------- routing ---------------- */

async function route(request, env) {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/') return json({ ok: true, service: 'todo-push' });
  if (request.method === 'GET' && pathname === '/vapid') return json({ publicKey: env.VAPID_PUBLIC_KEY });
  if (request.method !== 'POST') throw httpError(404, 'not-found');

  const body = await request.json().catch(() => { throw httpError(400, 'bad-json'); });
  switch (pathname) {
    case '/subscribe': return subscribe(body, env);
    case '/sync': return syncReminders(body, env);
    case '/test': return testPush(body, env);
    case '/unsubscribe': return unsubscribe(body, env);
    case '/ai': return aiAssist(body, env);
    default: throw httpError(404, 'not-found');
  }
}

/* ---------------- push ---------------- */

async function subscribe({ deviceId, subscription }, env) {
  checkDevice(deviceId);
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') throw httpError(400, 'bad-subscription');
  let url;
  try { url = new URL(endpoint); } catch { throw httpError(400, 'bad-endpoint'); }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) throw httpError(400, 'unsupported-push-service');

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO devices (id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(id) DO UPDATE SET endpoint = ?2, p256dh = ?3, auth = ?4, updated_at = ?5`,
  ).bind(deviceId, endpoint, p256dh, auth, now).run();
  return json({ ok: true });
}

async function syncReminders({ deviceId, reminders }, env) {
  checkDevice(deviceId);
  await requireDevice(deviceId, env);
  if (!Array.isArray(reminders)) throw httpError(400, 'bad-reminders');
  const now = Date.now();
  const clean = reminders
    .filter((r) => r && typeof r.id === 'string' && r.id.length <= 64 && Number.isFinite(r.fireAt) && r.fireAt > now)
    .slice(0, MAX_REMINDERS)
    .map((r) => [String(r.id), Math.floor(r.fireAt), String(r.title || '할 일').slice(0, 200), String(r.body || '').slice(0, 300)]);

  // 테스트 알림 예약(__test__)은 동기화로 지워지지 않게 남겨 둠
  const stmts = [env.DB.prepare("DELETE FROM reminders WHERE device_id = ?1 AND task_id != '__test__'").bind(deviceId)];
  const insert = env.DB.prepare('INSERT OR REPLACE INTO reminders (device_id, task_id, fire_at, title, body) VALUES (?1, ?2, ?3, ?4, ?5)');
  for (const [id, fireAt, title, body] of clean) stmts.push(insert.bind(deviceId, id, fireAt, title, body));
  await env.DB.batch(stmts);
  return json({ ok: true, count: clean.length });
}

async function testPush({ deviceId, delaySec = 0 }, env) {
  checkDevice(deviceId);
  const device = await requireDevice(deviceId, env);
  const delay = Math.min(Math.max(Number(delaySec) || 0, 0), 600);
  if (delay > 0) {
    await env.DB.prepare('INSERT OR REPLACE INTO reminders (device_id, task_id, fire_at, title, body) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(deviceId, '__test__', Date.now() + delay * 1000, '🔔 잠금화면 테스트', '이 알림이 보이면 잠금화면 알림이 잘 동작하는 거예요.').run();
    return json({ ok: true, scheduled: true });
  }
  const result = await pushTo(device, { id: '__test__', title: '🔔 to do list 테스트', body: '서버 알림이 잘 연결됐어요.' }, env);
  return json({ ok: result.status < 300, status: result.status });
}

async function unsubscribe({ deviceId }, env) {
  checkDevice(deviceId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reminders WHERE device_id = ?1').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE id = ?1').bind(deviceId),
  ]);
  return json({ ok: true });
}

function vapid(env) {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK),
    subject: env.VAPID_SUBJECT,
  };
}

function pushTo(device, reminder, env) {
  // 반복 할 일은 "할일id@날짜"로 회차마다 따로 저장됨. 알림 묶음(tag)은 할 일 단위로
  const baseId = reminder.id.split('@')[0];
  const payload = JSON.stringify({
    // iOS 18.4+ Declarative Web Push 형식 (서비스워커가 없어도 표시됨) + 일반 서비스워커용 필드
    web_push: 8030,
    notification: {
      title: reminder.title,
      body: reminder.body || undefined,
      navigate: env.APP_URL,
      tag: baseId,
    },
    id: reminder.id,
  });
  return sendPush({ endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth }, payload, vapid(env), {
    topic: baseId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
  });
}

async function sendDueReminders(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT r.device_id, r.task_id, r.fire_at, r.title, r.body, d.endpoint, d.p256dh, d.auth
     FROM reminders r JOIN devices d ON d.id = r.device_id
     WHERE r.fire_at <= ?1 ORDER BY r.fire_at LIMIT 200`,
  ).bind(now + 15000).all();

  const done = [];
  const gone = new Set();
  await Promise.all(results.map(async (row) => {
    try {
      const res = await pushTo(row, { id: row.task_id, title: row.title, body: row.body }, env);
      if (res.status === 404 || res.status === 410) gone.add(row.device_id);
      else if (res.status >= 300) console.log('push failed', res.status, res.text.slice(0, 200));
    } catch (err) {
      console.log('push error', String(err));
    }
    done.push(env.DB.prepare('DELETE FROM reminders WHERE device_id = ?1 AND task_id = ?2 AND fire_at = ?3')
      .bind(row.device_id, row.task_id, row.fire_at));
  }));
  for (const id of gone) {
    done.push(env.DB.prepare('DELETE FROM reminders WHERE device_id = ?1').bind(id));
    done.push(env.DB.prepare('DELETE FROM devices WHERE id = ?1').bind(id));
  }
  if (done.length) await env.DB.batch(done);
}

/* ---------------- AI (Gemini) ---------------- */

const TASK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    message: { type: 'STRING' },
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          note: { type: 'STRING' },
          due: { type: 'STRING', description: 'YYYY-MM-DD 또는 빈 문자열' },
          time: { type: 'STRING', description: 'HH:MM (24시간) 또는 빈 문자열' },
          repeat: { type: 'STRING', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] },
          important: { type: 'BOOLEAN' },
        },
        required: ['title', 'due', 'time', 'repeat', 'important'],
      },
    },
  },
  required: ['message', 'tasks'],
};

async function aiAssist({ deviceId, passcode, mode, text, today, now, context }, env) {
  checkDevice(deviceId);
  if (!env.GEMINI_API_KEY) throw httpError(503, 'ai-not-configured');
  if (!env.AI_PASSCODE || passcode !== env.AI_PASSCODE) throw httpError(401, 'bad-passcode');
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw httpError(400, 'bad-text');
  if (!['plan', 'breakdown', 'today'].includes(mode)) throw httpError(400, 'bad-mode');

  const day = new Date().toISOString().slice(0, 10);
  const usage = await env.DB.prepare(
    `INSERT INTO ai_usage (device_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(deviceId, day).first();
  if (usage.count > AI_DAILY_LIMIT) throw httpError(429, 'ai-daily-limit');

  const prompt = buildPrompt(mode, text.trim(), String(today || day), String(now || ''), Array.isArray(context) ? context.slice(0, 60) : []);
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json', responseSchema: TASK_SCHEMA },
    }),
  });
  if (!res.ok) {
    console.log('gemini error', res.status, (await res.text()).slice(0, 300));
    throw httpError(502, 'ai-upstream-error');
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw httpError(502, 'ai-bad-output'); }
  const tasks = (parsed.tasks || []).slice(0, 30).map(cleanTask).filter(Boolean);
  return json({ message: String(parsed.message || '').slice(0, 500), tasks });
}

function cleanTask(t) {
  if (!t || typeof t.title !== 'string' || !t.title.trim()) return null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time || '') ? t.time : null;
  return {
    title: t.title.trim().slice(0, 200),
    note: typeof t.note === 'string' ? t.note.trim().slice(0, 500) : '',
    due,
    time: due ? time : null,
    repeat: ['daily', 'weekdays', 'weekly', 'monthly'].includes(t.repeat) ? t.repeat : 'none',
    important: !!t.important,
  };
}

function buildPrompt(mode, text, today, now, context) {
  const base = `너는 한국어 할 일 앱 "to do list"의 비서야. 오늘은 ${today}${now ? `, 지금 시각은 ${now}` : ''}이야.
규칙:
- 할 일 제목은 짧고 행동 중심으로 (예: "항공권 예약", "환전하기"). 이모지는 쓰지 마.
- due는 YYYY-MM-DD, time은 24시간 HH:MM. 정하기 어려우면 빈 문자열.
- 날짜·시간을 지어내지 마. 사용자가 말했거나 일의 성격상 분명할 때만 넣어.
- repeat은 사용자가 반복을 원할 때만 none 이외 값을 써.
- message에는 사용자에게 보여 줄 한두 문장 요약을 써.`;
  const ctx = context.length
    ? `\n현재 남은 할 일(참고용):\n${context.map((c) => `- ${String(c.title).slice(0, 80)}${c.due ? ` (${c.due}${c.time ? ` ${c.time}` : ''})` : ''}`).join('\n')}`
    : '';
  if (mode === 'breakdown') {
    return `${base}\n\n아래 할 일을 바로 실행할 수 있는 3~8개의 작은 단계로 나눠 줘. 원래 일의 마감일보다 늦은 날짜는 쓰지 마.\n할 일: ${text}${ctx}`;
  }
  if (mode === 'today') {
    return `${base}\n\n사용자의 오늘 할 일을 보고 하루 계획을 세워 줘. tasks에는 시간이 배치된 할 일을 돌려주되, 기존 할 일 제목은 그대로 쓰고 due는 오늘로 해. 새 할 일은 꼭 필요할 때만 추가해. message에 우선순위와 이유를 짧게 설명해.\n사용자 요청: ${text}${ctx}`;
  }
  return `${base}\n\n사용자의 말을 할 일 목록으로 정리해 줘. 여러 개가 필요하면 나눠서 만들어.\n사용자: ${text}${ctx}`;
}

/* ---------------- helpers ---------------- */

function checkDevice(id) {
  if (typeof id !== 'string' || !DEVICE_RE.test(id)) throw httpError(400, 'bad-device');
}
async function requireDevice(id, env) {
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?1').bind(id).first();
  if (!row) throw httpError(404, 'unknown-device');
  return row;
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
