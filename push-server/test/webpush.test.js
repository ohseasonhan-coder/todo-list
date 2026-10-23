import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidJWT, b64urlEncode, b64urlDecode } from '../src/webpush.js';

test('aes128gcm payload decrypts with an independent RFC 8291 implementation', async () => {
  // 브라우저(UA) 측 키를 흉내 냄
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const message = JSON.stringify({ web_push: 8030, notification: { title: '치과 🦷', body: '오후 3시' }, id: 'abc' });

  const body = await encryptPayload(message, b64urlEncode(ua.getPublicKey()), b64urlEncode(auth));
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
  assert.equal(plain.toString('utf8'), message);
});

test('VAPID JWT is a valid ES256 signature with the expected claims', async () => {
  const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
  const jwt = await vapidJWT('https://web.push.apple.com', 'https://example.github.io/app/', jwk);
  const [h, c, s] = jwt.split('.');
  const ok = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://example.github.io/app/');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
});
