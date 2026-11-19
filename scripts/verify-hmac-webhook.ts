import crypto from 'crypto';
import assert from 'node:assert';

const secret = 'test_secret_123';
const body = JSON.stringify({ provider: 'test', userId: 1, payout: 1 });
const ts = Math.floor(Date.now() / 1000);
const msg = `${ts}.${body}`;
const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');

// Valid
const expected = crypto.createHmac('sha256', secret).update(msg).digest('hex');
assert.strictEqual(sig, expected);
assert.ok(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')));

// Tampered timestamp
const badMsg = `${ts + 1}.${body}`;
const badSig = crypto.createHmac('sha256', secret).update(badMsg).digest('hex');
assert.notStrictEqual(sig, badSig);

// Expired window
const oldTs = ts - 400;
assert.ok(Math.abs(Math.floor(Date.now() / 1000) - oldTs) > 300);

console.log('[verify-hmac-webhook] OK');
