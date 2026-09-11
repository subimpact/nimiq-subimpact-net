/**
 * Live end-to-end: signed wallet login against the DEPLOYED worker.
 * Generates a fresh Nimiq keypair, signs a real nonce challenge,
 * and drives /api/auth/verify + /api/entitlement + tamper cases.
 */
import { KeyPair } from '@nimiq/core';

const BASE = 'https://nimiq-api.subimpact.net';
const ORIGIN = 'https://nimiq.subimpact.net';

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  // 1. nonce
  const nonceRes = await fetch(`${BASE}/api/auth/nonce`, { headers: { Origin: ORIGIN } });
  const { nonce, message, expiresInMs } = await nonceRes.json();
  console.log('1. nonce:', nonce.slice(0, 24) + '…', '| expiresInMs:', expiresInMs);

  // 2. sign exactly as specified
  const kp = KeyPair.generate();
  const prefix = '\x16Nimiq Signed Message:\n';
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix + message.length + message)),
  );
  const sig = new Uint8Array(kp.sign(digest).serialize());
  const pub = new Uint8Array(kp.publicKey.serialize());
  const address = kp.publicKey.toAddress().toUserFriendlyAddress();
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  console.log('2. signed | address:', address, '| sig:', hex(sig).slice(0, 16) + '…');

  // 3. verify → expect entitled:false (fresh wallet), authToken present
  const v = await post('/api/auth/verify', {
    address,
    signerPublicKey: hex(pub),
    signature: hex(sig),
    nonce,
  });
  console.log('3. verify:', v.status, '| entitled:', v.json?.entitled, '| reason:', v.json?.reason,
    '| authToken:', v.json?.authToken ? 'yes' : 'no', '| requiredLuna:', v.json?.requiredLuna);
  const authToken = v.json?.authToken;

  // 4. entitlement re-check with auth token → expect entitled:false
  const e = await post('/api/entitlement', undefined, authToken);
  console.log('4. entitlement:', e.status, '| entitled:', e.json?.entitled, '| reason:', e.json?.reason);

  // 5. tamper: flip one signature byte → expect 401
  const bad = new Uint8Array(sig); bad[10] ^= 0xff;
  const t = await post('/api/auth/verify', {
    address, signerPublicKey: hex(pub), signature: hex(bad), nonce,
  });
  console.log('5. tampered signature:', t.status, '|', t.json?.error);

  // 6. replay: same nonce reused with good sig on a *different* key is fine (new verify),
  //    but reuse of a *consumed* nonce must still fail validation? (nonce is stateless: age-bound)
  const t2 = await post('/api/auth/verify', {
    address, signerPublicKey: hex(pub), signature: hex(sig), nonce: nonce + 'x',
  });
  console.log('6. corrupted nonce:', t2.status, '|', t2.json?.error);

  const pass = v.status === 200 && v.json?.entitled === false && authToken
    && e.status === 200 && e.json?.entitled === false
    && t.status === 401 && t2.status === 401;
  console.log('\nRESULT:', pass ? 'ALL LIVE CHECKS PASS ✓' : 'SOMETHING FAILED ✗');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
