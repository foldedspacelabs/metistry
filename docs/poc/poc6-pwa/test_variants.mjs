// PoC-6 debug — try VAPID header variants against the real Apple subscription.
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

const vapid = JSON.parse(fs.readFileSync(new URL('./vapid.json', import.meta.url), 'utf8'));
const subs = JSON.parse(fs.readFileSync(new URL('./subscriptions.json', import.meta.url), 'utf8'));
const sub = subs[0];
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

const key = await webcrypto.subtle.importKey('jwk', vapid.jwkPrivate, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
async function jwt(claims, headerObj = { typ:'JWT', alg:'ES256' }) {
  const si = b64url(Buffer.from(JSON.stringify(headerObj))) + '.' + b64url(Buffer.from(JSON.stringify(claims)));
  const sig = await webcrypto.subtle.sign({ name:'ECDSA', hash:{name:'SHA-256'} }, key, Buffer.from(si));
  return si + '.' + b64url(sig);
}
const aud = new URL(sub.endpoint).origin;
const now = Math.floor(Date.now()/1000);

const variants = [
  ['baseline 12h mailto:mattcolf.dev, space', async () => `vapid t=${await jwt({aud, exp: now+43200, sub:'mailto:metistry@mattcolf.dev'})}, k=${vapid.publicKey}`],
  ['no space after comma',                    async () => `vapid t=${await jwt({aud, exp: now+43200, sub:'mailto:metistry@mattcolf.dev'})},k=${vapid.publicKey}`],
  ['exp 2h',                                  async () => `vapid t=${await jwt({aud, exp: now+7200, sub:'mailto:metistry@mattcolf.dev'})},k=${vapid.publicKey}`],
  ['sub https url',                           async () => `vapid t=${await jwt({aud, exp: now+7200, sub:'https://mattcolf.dev'})},k=${vapid.publicKey}`],
  ['legacy WebPush + Crypto-Key',             async () => ['WebPush ' + await jwt({aud, exp: now+7200, sub:'mailto:metistry@mattcolf.dev'}), `p256ecdsa=${vapid.publicKey}`]],
];

for (const [name, build] of variants) {
  const built = await build();
  const headers = { 'TTL':'60' };
  if (Array.isArray(built)) { headers['Authorization'] = built[0]; headers['Crypto-Key'] = built[1]; }
  else headers['Authorization'] = built;
  const res = await fetch(sub.endpoint, { method:'POST', headers });
  const body = await res.text();
  console.log(`${res.status} | ${name} | ${body.slice(0,60)}`);
  if (res.ok) break; // stop at first success — one notification is enough
}
