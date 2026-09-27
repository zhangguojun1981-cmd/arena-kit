import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { base32Decode, base32Encode, asciiBytes, sha1, sha256, hmac, hotp, totp, totpNow, totpRemaining, parseOtpSecret, normalizeAlgorithm } from '../src/lib/totp.js';

const hex = (u8) => Buffer.from(u8).toString('hex');

/* ── hashes vs node:crypto (boundary lengths around the 64-byte block) ── */
test('sha1 / sha256 match node:crypto for every block-boundary length', () => {
  const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096];
  for (const n of lengths) {
    const msg = crypto.randomBytes(n);
    assert.equal(hex(sha1(new Uint8Array(msg))), crypto.createHash('sha1').update(msg).digest('hex'), 'sha1 len ' + n);
    assert.equal(hex(sha256(new Uint8Array(msg))), crypto.createHash('sha256').update(msg).digest('hex'), 'sha256 len ' + n);
  }
  // FIPS 180 "abc" vectors
  assert.equal(hex(sha1(asciiBytes('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(hex(sha256(asciiBytes('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hmac matches node:crypto for short, block-size and oversized keys', () => {
  for (const keyLen of [1, 20, 32, 64, 65, 100]) {
    const key = crypto.randomBytes(keyLen);
    const msg = crypto.randomBytes(37);
    assert.equal(hex(hmac('SHA1', new Uint8Array(key), new Uint8Array(msg))), crypto.createHmac('sha1', key).update(msg).digest('hex'), 'hmac-sha1 key ' + keyLen);
    assert.equal(hex(hmac('sha-256', new Uint8Array(key), new Uint8Array(msg))), crypto.createHmac('sha256', key).update(msg).digest('hex'), 'hmac-sha256 key ' + keyLen);
  }
  assert.throws(() => normalizeAlgorithm('SHA512'), /不支持/);
});

/* ── RFC 6238 Appendix B test vectors (8 digits) ─────────────────────── */
const SEED_SHA1 = asciiBytes('12345678901234567890');
const SEED_SHA256 = asciiBytes('12345678901234567890123456789012');
const VECTORS = [
  [59, '94287082', '46119246'],
  [1111111109, '07081804', '68084774'],
  [1111111111, '14050471', '67062674'],
  [1234567890, '89005924', '91819424'],
  [2000000000, '69279037', '90698825'],
  [20000000000, '65353130', '77737706'],
];

test('totp reproduces the RFC 6238 vectors for SHA1 and SHA256', () => {
  for (const [t, sha1Code, sha256Code] of VECTORS) {
    assert.equal(totp(SEED_SHA1, { time: t * 1000, digits: 8 }), sha1Code, 'sha1 @' + t);
    assert.equal(totp(SEED_SHA256, { time: t * 1000, digits: 8, algorithm: 'SHA256' }), sha256Code, 'sha256 @' + t);
    // 6-digit codes are the same truncation modulo 10^6
    assert.equal(totp(SEED_SHA1, { time: t * 1000 }), sha1Code.slice(-6));
  }
  // the same seed as a base32 string (what an authenticator "manual entry" shows)
  const b32 = base32Encode(SEED_SHA1);
  assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(b32, { time: 59_000 }), '287082');
  assert.equal(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', { time: 59_000 }), '287082', 'spaces + lowercase tolerated');
});

test('hotp: RFC 4226 vectors (counter 0..9, 6 digits)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(SEED_SHA1, counter), code));
  assert.throws(() => hotp(SEED_SHA1, -1), /计数器/);
});

/* ── base32 ──────────────────────────────────────────────────────────── */
test('base32 decode/encode round-trip and RFC 4648 vectors', () => {
  const vec = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, enc] of vec) {
    assert.equal(base32Encode(asciiBytes(plain)), enc);
    assert.equal(Buffer.from(base32Decode(enc + '======')).toString('latin1'), plain);
  }
  assert.throws(() => base32Decode('MZXW1'), /base32/);
  for (let i = 0; i < 20; i++) {
    const bytes = new Uint8Array(crypto.randomBytes(1 + (i % 23)));
    assert.deepEqual([...base32Decode(base32Encode(bytes))], [...bytes]);
  }
});

/* ── secret parsing (bare base32 / otpauth URI) ──────────────────────── */
test('parseOtpSecret accepts bare base32 and otpauth URIs, rejects junk', () => {
  assert.deepEqual(parseOtpSecret('  jbsw y3dp ehpk 3pxp '), { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', issuer: '', account: '' });
  const uri = 'otpauth://totp/Google%3Aalice%40gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google&digits=6&period=30&algorithm=SHA1';
  assert.deepEqual(parseOtpSecret(uri), { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', issuer: 'Google', account: 'alice@gmail.com' });
  const custom = parseOtpSecret('otpauth://totp/Acme:bob?secret=jbswy3dpehpk3pxp&period=60&digits=8&algorithm=sha256');
  assert.equal(custom.period, 60); assert.equal(custom.digits, 8); assert.equal(custom.algorithm, 'SHA256'); assert.equal(custom.issuer, 'Acme'); assert.equal(custom.account, 'bob');
  assert.equal(parseOtpSecret(''), null);
  assert.equal(parseOtpSecret('short'), null, 'too short / not base32');
  assert.equal(parseOtpSecret('hello world!'), null);
  assert.equal(parseOtpSecret('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP'), null, 'counter-based not supported');
  assert.equal(parseOtpSecret('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512'), null, 'unsupported algorithm');
  assert.equal(parseOtpSecret('otpauth://totp/x'), null, 'no secret');
});

test('totp() honours the period / digits / algorithm baked into an otpauth URI', () => {
  const b32 = base32Encode(SEED_SHA256);
  const uri = `otpauth://totp/Acme:bob?secret=${b32}&digits=8&algorithm=SHA256`;
  assert.equal(totp(uri, { time: 1234567890 * 1000 }), '91819424');
  assert.throws(() => totp('nope'), /无效的 2FA 密钥/);
});

test('totpNow / totpRemaining give the dock a code plus the countdown', () => {
  const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.deepEqual(totpNow(b32, 59_000), { code: '287082', remaining: 1, period: 30, digits: 6 });
  assert.deepEqual(totpNow(b32, 60_000), { code: '359152', remaining: 30, period: 30, digits: 6 }); // counter 2 (RFC 4226 vector)
  assert.equal(totpRemaining(30, 0), 30);
  assert.equal(totpRemaining(30, 29_999), 1);
  assert.equal(totpRemaining(30, 45_000), 15);
  assert.deepEqual(totpNow('bad'), { error: '无效的 2FA 密钥' });
});
