// to do list 서버 (Cloudflare Worker)
// - Web Push: 기기별 구독 저장 + 매분 cron으로 알림 시각이 된 할 일을 푸시
// - AI: Gemini로 문장을 할 일 목록으로 바꾸거나 큰 일을 잘게 쪼갬 (접근 코드 필요)

import { sendPush } from './webpush.js';
import { buildCalendar } from './ics.js';

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
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === 'GET' && pathname === '/') return json({ ok: true, service: 'todo-push' });
  if (request.method === 'GET' && pathname === '/vapid') return json({ publicKey: env.VAPID_PUBLIC_KEY });
  // Siri 단축어는 GET 한 줄로 부르기 쉬움: /inbox?s=<space>&t=<문장>
  if (request.method === 'GET' && pathname === '/inbox') {
    return inboxAdd({ space: url.searchParams.get('s'), text: url.searchParams.get('t') }, env, true);
  }
  // 아이폰 캘린더 구독: webcal://.../cal/<feed>.ics
  const cal = request.method === 'GET' && pathname.match(/^\/cal\/([a-f0-9]{32})\.ics$/);
  if (cal) return calendarFeed(cal[1], env);
  if (request.method !== 'POST') throw httpError(404, 'not-found');

  const body = await request.json().catch(() => { throw httpError(400, 'bad-json'); });
  switch (pathname) {
    case '/feed/put': return feedPut(body, env);
    case '/feed/delete': return feedDelete(body, env);
    case '/data/get': return dataGet(body, env);
    case '/data/put': return dataPut(body, env);
    case '/inbox': return inboxAdd(body, env, false);
    case '/inbox/take': return inboxTake(body, env);
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

/* ---------------- 백업·동기화 ---------------- */
// space id·쓰기 토큰·암호 키는 모두 기기가 "동기화 코드"에서 만들어 냄. 서버는 암호문만 보관

const SPACE_RE = /^[a-f0-9]{32}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const MAX_BLOB = 1_500_000;
const MAX_INBOX = 200;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function checkSpace(space) {
  if (typeof space !== 'string' || !SPACE_RE.test(space)) throw httpError(400, 'bad-space');
}
async function checkToken(row, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw httpError(400, 'bad-token');
  if (row && row.write_hash !== await sha256Hex(token)) throw httpError(403, 'bad-token');
}

async function dataGet({ space }, env) {
  checkSpace(space);
  const row = await env.DB.prepare('SELECT blob, version, updated_at FROM spaces WHERE id = ?1').bind(space).first();
  if (!row) return json({ version: 0, blob: null, updatedAt: 0 });
  return json({ version: row.version, blob: row.blob, updatedAt: row.updated_at });
}

async function dataPut({ space, token, blob, baseVersion }, env) {
  checkSpace(space);
  if (typeof blob !== 'string' || !blob || blob.length > MAX_BLOB) throw httpError(400, 'bad-blob');
  const row = await env.DB.prepare('SELECT write_hash, version FROM spaces WHERE id = ?1').bind(space).first();
  await checkToken(row, token);
  const current = row ? row.version : 0;
  if (Number(baseVersion) !== current) return json({ error: 'conflict', version: current }, 409);
  const now = Date.now();
  if (!row) {
    await env.DB.prepare('INSERT INTO spaces (id, write_hash, blob, version, updated_at) VALUES (?1, ?2, ?3, 1, ?4)')
      .bind(space, await sha256Hex(token), blob, now).run();
    return json({ ok: true, version: 1 });
  }
  // 버전이 그대로일 때만 덮어씀 (동시에 두 기기가 저장해도 한쪽이 409로 다시 합치게)
  const res = await env.DB.prepare('UPDATE spaces SET blob = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4')
    .bind(blob, now, space, current).run();
  if (!res.meta.changes) return json({ error: 'conflict' }, 409);
  return json({ ok: true, version: current + 1 });
}

async function inboxAdd({ space, text }, env, plain) {
  const reply = (msg, status = 200) => (plain
    ? new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    : json(status === 200 ? { ok: true } : { error: msg }, status));
  if (typeof space !== 'string' || !SPACE_RE.test(space)) return reply('동기화 코드가 올바르지 않아요.', 400);
  const clean = typeof text === 'string' ? text.trim().slice(0, 300) : '';
  if (!clean) return reply('추가할 내용이 비어 있어요.', 400);
  if (clean.includes('�')) return reply('글자가 깨져서 들어왔어요. 단축어에서 URL 인코딩 동작을 확인해 주세요.', 400);
  const row = await env.DB.prepare('SELECT 1 FROM spaces WHERE id = ?1').bind(space).first();
  if (!row) return reply('먼저 앱에서 자동 백업을 켜 주세요.', 404);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox WHERE space_id = ?1').bind(space).first();
  if (n >= MAX_INBOX) return reply('대기 중인 할 일이 너무 많아요. 앱을 한 번 열어 주세요.', 429);
  await env.DB.prepare('INSERT INTO inbox (space_id, text, created_at) VALUES (?1, ?2, ?3)').bind(space, clean, Date.now()).run();
  return reply(`✅ 추가했어요: ${clean}`);
}

async function inboxTake({ space, token }, env) {
  checkSpace(space);
  const row = await env.DB.prepare('SELECT write_hash FROM spaces WHERE id = ?1').bind(space).first();
  if (!row) return json({ items: [] });
  await checkToken(row, token);
  const { results } = await env.DB.prepare('SELECT id, text, created_at FROM inbox WHERE space_id = ?1 ORDER BY id LIMIT 100').bind(space).all();
  if (results.length) {
    await env.DB.prepare(`DELETE FROM inbox WHERE space_id = ?1 AND id <= ?2`).bind(space, results.at(-1).id).run();
  }
  return json({ items: results.map((r) => ({ text: r.text, createdAt: r.created_at })) });
}

/* ---------------- 캘린더 구독 피드 ---------------- */

const MAX_EVENTS = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function feedPut({ feed, token, events }, env) {
  checkSpace(feed);
  if (!Array.isArray(events)) throw httpError(400, 'bad-events');
  const row = await env.DB.prepare('SELECT write_hash FROM feeds WHERE id = ?1').bind(feed).first();
  await checkToken(row, token);
  const clean = events.slice(0, MAX_EVENTS).map((e) => {
    if (!e || typeof e.uid !== 'string' || typeof e.title !== 'string') return null;
    const base = { uid: e.uid.slice(0, 120), title: e.title.slice(0, 200), note: typeof e.note === 'string' ? e.note.slice(0, 500) : '' };
    if (e.allDay && DATE_RE.test(e.date || '')) return { ...base, allDay: true, date: e.date };
    if (!e.allDay && Number.isFinite(e.start)) return { ...base, allDay: false, start: Math.floor(e.start), minutes: Math.min(Math.max(Number(e.minutes) || 30, 5), 600) };
    return null;
  }).filter(Boolean);
  const data = JSON.stringify(clean);
  const now = Date.now();
  if (row) {
    await env.DB.prepare('UPDATE feeds SET events = ?1, updated_at = ?2 WHERE id = ?3').bind(data, now, feed).run();
  } else {
    await env.DB.prepare('INSERT INTO feeds (id, write_hash, events, updated_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(feed, await sha256Hex(token), data, now).run();
  }
  return json({ ok: true, count: clean.length });
}

async function feedDelete({ feed, token }, env) {
  checkSpace(feed);
  const row = await env.DB.prepare('SELECT write_hash FROM feeds WHERE id = ?1').bind(feed).first();
  if (!row) return json({ ok: true });
  await checkToken(row, token);
  await env.DB.prepare('DELETE FROM feeds WHERE id = ?1').bind(feed).run();
  return json({ ok: true });
}

async function calendarFeed(feed, env) {
  const row = await env.DB.prepare('SELECT events, updated_at FROM feeds WHERE id = ?1').bind(feed).first();
  if (!row) return new Response('Not found', { status: 404 });
  return new Response(buildCalendar(JSON.parse(row.events), row.updated_at), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-cache, max-age=0',
      'Content-Disposition': 'inline; filename="todo.ics"',
    },
  });
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
  const data = await callGemini(prompt, env);
  const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    console.log('gemini bad output', data?.candidates?.[0]?.finishReason, raw.slice(0, 200));
    throw httpError(502, `ai-bad-output-${data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'EMPTY'}`);
  }
  const tasks = (parsed.tasks || []).slice(0, 30).map(cleanTask).filter(Boolean);
  return json({ message: String(parsed.message || '').slice(0, 500), tasks });
}

// 모델 하나에 요청. 생각(thinking)을 최소로 해서 빨리 답하게 하고, timeoutMs 안에 안 오면 끊음
async function generateWith(model, prompt, env, timeoutMs) {
  const generationConfig = { temperature: 0.4, responseMimeType: 'application/json', responseSchema: TASK_SCHEMA };
  // 2.x 모델은 thinkingBudget, 3.x 이후·latest 별칭은 thinkingLevel로 생각을 줄임
  if (/gemini-2\./.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
      signal: ctrl.signal,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    let err = {};
    try { err = JSON.parse(text).error || {}; } catch { /* JSON 아님 */ }
    const e = new Error(err.details?.find((d) => d.reason)?.reason || err.status || 'UNKNOWN');
    e.status = res.status;
    e.detail = String(err.message || text).slice(0, 200);
    throw e;
  } catch (err) {
    if (err.name === 'AbortError') { const e = new Error('TIMEOUT'); e.status = 504; throw e; }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 설정한 모델이 없어졌으면(404) 최신 별칭 모델로 자동 전환. 실패하면 원인 코드를 그대로 돌려줌
async function callGemini(prompt, env) {
  const models = [...new Set([env.GEMINI_MODEL, 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite'].filter(Boolean))];
  let last = null;
  for (const [i, model] of models.entries()) {
    try {
      // 첫 모델은 좀 더 기다리고, 대체 모델은 빨리 포기
      return await generateWith(model, prompt, env, i === 0 ? 20000 : 12000);
    } catch (err) {
      console.log('gemini error', model, err.status, err.message, err.detail || '');
      last = err;
      // 모델이 없거나(404) 붐비거나(429·500·503) 느리면(504) 다음 모델로. 키 문제(400·403)는 바꿔도 같아서 멈춤
      if (![404, 429, 500, 503, 504].includes(err.status)) break;
    }
  }
  throw httpError(502, `ai-upstream-${last?.status || 0}-${last?.message || 'UNKNOWN'}`);
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
  return `${base}

사용자의 말을 할 일 목록으로 정리해 줘.
- "준비", "정리", "계획"처럼 여러 단계가 필요한 요청이면 실제로 해야 할 구체적인 할 일 3~8개로 나눠. (예: 여행 준비 → 항공권 예약, 숙소 예약, 렌터카 예약, 환전, 짐 싸기)
- 행사·마감 날짜가 있으면 각 할 일의 due를 그 날짜 이전으로 알맞게 나눠 배치하고, 행사 당일 할 일도 넣어.
- 단순한 할 일 하나를 말한 거면 하나만 만들어.
사용자: ${text}${ctx}`;
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
