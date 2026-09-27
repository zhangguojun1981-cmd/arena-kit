/* RFC 6238 TOTP (+ RFC 4226 HOTP) in dependency-free JS.
 *
 * Why hand-rolled: the same code runs in three places — the desktop dock
 * (tauri://localhost, where WebCrypto is not guaranteed), the Android
 * embedded dock and the page-side login helper (injected/totp.gen.js,
 * generated from this file by scripts/bundle-dock.mjs so the accounts.google.com
 * 2-step page can fill the code without any IPC). Synchronous SHA-1 / SHA-256
 * + HMAC are ~80 lines and are checked against node:crypto in tests/totp.test.mjs.
 *
 * Secrets are what authenticator apps show: base32 (spaces / dashes / case /
 * padding tolerated) or a full `otpauth://totp/...?secret=...` URI. Defaults
 * follow Google Authenticator: 6 digits, 30 s, SHA-1. */

export const TOTP_DEFAULTS = Object.freeze({ digits: 6, period: 30, algorithm: 'SHA1' });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* RFC 4648 base32 → bytes. Case-insensitive; whitespace, '-', '_' and '='
 * padding are ignored (what people paste from "manual entry" screens). */
export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s\-_=]/g, '');
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('无效的 base32 字符: ' + ch);
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function base32Encode(bytes) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/* Only used for the RFC test vectors and otpauth secrets given as raw ASCII. */
export function asciiBytes(str) {
  const s = String(str || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/* ── SHA-1 / SHA-256 (FIPS 180-4), big-endian, message < 2^53 bits ─────── */
function padMessage(bytes, blockSize) {
  const ml = bytes.length;
  const total = Math.ceil((ml + 1 + 8) / blockSize) * blockSize;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = ml * 8;
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  return { buf, dv, total };
}

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

export function sha1(bytes) {
  const { dv, total } = padMessage(bytes, 64);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h, false));
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(bytes) {
  const { dv, total } = padMessage(bytes, 64);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + (ch >>> 0) + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + (maj >>> 0)) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

const HASHES = {
  SHA1: { fn: sha1, block: 64 },
  SHA256: { fn: sha256, block: 64 },
};

export function normalizeAlgorithm(name) {
  const a = String(name || 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (a === 'SHA1' || a === 'SHA256') return a;
  throw new Error('不支持的算法: ' + name + '（支持 SHA1 / SHA256）');
}

/* RFC 2104 HMAC over one of the hashes above. */
export function hmac(algorithm, key, message) {
  const { fn, block } = HASHES[normalizeAlgorithm(algorithm)];
  let k = key;
  if (k.length > block) k = fn(k);
  const kp = new Uint8Array(block);
  kp.set(k);
  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + fn(new Uint8Array(0)).length);
  for (let i = 0; i < block; i++) { inner[i] = kp[i] ^ 0x36; outer[i] = kp[i] ^ 0x5c; }
  inner.set(message, block);
  outer.set(fn(inner), block);
  return fn(outer);
}

/* RFC 4226 dynamic truncation → zero-padded decimal string. */
export function hotp(key, counter, { digits = TOTP_DEFAULTS.digits, algorithm = TOTP_DEFAULTS.algorithm } = {}) {
  if (!Number.isFinite(counter) || counter < 0) throw new Error('无效的计数器');
  const d = Math.max(4, Math.min(10, Number(digits) || TOTP_DEFAULTS.digits));
  const msg = new Uint8Array(8);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, Math.floor(counter / 0x100000000), false);
  dv.setUint32(4, counter >>> 0, false);
  const mac = hmac(algorithm, key, msg);
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** d).padStart(d, '0');
}

/* Parse what the user pasted: an otpauth:// URI or a bare base32 secret.
 * Returns { secret (clean base32), digits, period, algorithm, issuer, account }
 * or null when there is nothing usable. */
export function parseOtpSecret(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^otpauth:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    if (u.host.toLowerCase() !== 'totp') return null; // hotp / steam etc. are not supported
    const secret = (u.searchParams.get('secret') || '').toUpperCase().replace(/[\s\-_=]/g, '');
    if (!secret) return null;
    let label = '';
    try { label = decodeURIComponent(u.pathname.replace(/^\/+/, '')); } catch (_) { label = u.pathname.replace(/^\/+/, ''); }
    const [labelIssuer, account] = label.includes(':') ? label.split(':', 2) : ['', label];
    const out = {
      secret,
      digits: Number(u.searchParams.get('digits')) || TOTP_DEFAULTS.digits,
      period: Number(u.searchParams.get('period')) || TOTP_DEFAULTS.period,
      algorithm: TOTP_DEFAULTS.algorithm,
      issuer: u.searchParams.get('issuer') || labelIssuer.trim(),
      account: account.trim(),
    };
    try { out.algorithm = normalizeAlgorithm(u.searchParams.get('algorithm') || 'SHA1'); } catch (_) { return null; }
    return validSecret(out.secret) ? out : null;
  }
  const secret = raw.toUpperCase().replace(/[\s\-_=]/g, '');
  if (!validSecret(secret)) return null;
  return { secret, digits: TOTP_DEFAULTS.digits, period: TOTP_DEFAULTS.period, algorithm: TOTP_DEFAULTS.algorithm, issuer: '', account: '' };
}

function validSecret(s) {
  return typeof s === 'string' && s.length >= 8 && /^[A-Z2-7]+$/.test(s);
}

/* Current code for a secret (base32 string, otpauth URI or raw key bytes). */
export function totp(secret, { time = Date.now(), period = TOTP_DEFAULTS.period, digits = TOTP_DEFAULTS.digits, algorithm = TOTP_DEFAULTS.algorithm, t0 = 0 } = {}) {
  let key;
  let p = period, d = digits, alg = algorithm;
  if (secret instanceof Uint8Array) key = secret;
  else {
    const parsed = parseOtpSecret(secret);
    if (!parsed) throw new Error('无效的 2FA 密钥（需要 base32 或 otpauth:// 链接）');
    key = base32Decode(parsed.secret);
    if (/^otpauth:/i.test(String(secret))) { p = parsed.period; d = parsed.digits; alg = parsed.algorithm; }
  }
  const step = Math.max(1, Number(p) || TOTP_DEFAULTS.period);
  const counter = Math.floor((Math.floor(time / 1000) - t0) / step);
  return hotp(key, counter, { digits: d, algorithm: alg });
}

/* Seconds until the current code rolls over. */
export function totpRemaining(period = TOTP_DEFAULTS.period, time = Date.now()) {
  const step = Math.max(1, Number(period) || TOTP_DEFAULTS.period);
  return step - (Math.floor(time / 1000) % step);
}

/* One call for UIs: { code, remaining, period, digits } or { error }. */
export function totpNow(secret, time = Date.now()) {
  try {
    const parsed = parseOtpSecret(secret);
    if (!parsed) return { error: '无效的 2FA 密钥' };
    const code = hotp(base32Decode(parsed.secret), Math.floor(Math.floor(time / 1000) / parsed.period), { digits: parsed.digits, algorithm: parsed.algorithm });
    return { code, remaining: totpRemaining(parsed.period, time), period: parsed.period, digits: parsed.digits };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}
