import test from 'node:test';
import assert from 'node:assert/strict';
import { startLsWatchdog, createOwnerProbe } from '../agy-capsule/sidecars/agy_capsule/ls_watchdog.mjs';

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }) });
const timeout = () => new DOMException('timed out', 'TimeoutError');
const redirect = () => new TypeError('fetch failed', { cause: new Error('unexpected redirect') });

function fixture(replies, ownerProbe = () => 'unbound') {
  let tick, now = 0, next, probes = 0, cleared = false, unref = false;
  const exits = [];
  const timer = { unref() { unref = true; } };
  const stop = startLsWatchdog('localhost:5352', reason => exits.push({ now, reason }), {
    now: () => now, ownerProbe,
    schedule(callback, ms) { assert.equal(ms, 30_000); tick = callback; next = ms; return timer; },
    cancel(handle) { assert.equal(handle, timer); cleared = true; },
    async fetchImpl(url, options) {
      assert.equal(url, 'http://localhost:5352/'); assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
      const reply = replies[probes++];
      if (reply instanceof Error) throw reply;
      return new Response(null, { status: reply });
    },
  });
  assert.ok(unref, 'the timer alone must not keep the sidecar alive');
  return { exits, stop, get probes() { return probes; }, async advance(ms) {
    const end = now + ms;
    while (!cleared && next <= end) { now = next; next += 30_000; await tick(); }
    now = end;
  } };
}

test('idle sidecar requires a full two minutes measured from the first failed probe', async () => {
  const f = fixture([refused(), timeout(), refused(), refused(), refused()]);
  await f.advance(29_999); assert.equal(f.probes, 0);
  await f.advance(90_000); assert.equal(f.probes, 3); assert.deepEqual(f.exits, []);
  await f.advance(1);
  assert.deepEqual(f.exits, [], 'four probes span only 90 seconds');
  await f.advance(29_999); assert.deepEqual(f.exits, []);
  await f.advance(1); assert.deepEqual(f.exits, [{ now: 150_000, reason: 'language server gone' }]);
  await f.advance(90_000); assert.equal(f.probes, 5);
});

for (const [label, response] of [['success', 200], ['unauthorized', 401], ['server error', 500], ['refused redirect', redirect()]]) {
  test(label + ' proves the server is alive and resets the entire failure streak', async () => {
    const f = fixture([refused(), refused(), refused(), response, ...Array.from({ length: 5 }, refused)]);
    await f.advance(7 * 30_000); assert.deepEqual(f.exits, []);
    await f.advance(30_000); assert.deepEqual(f.exits, []);
    await f.advance(30_000); assert.deepEqual(f.exits, [{ now: 270_000, reason: 'language server gone' }]);
  });
}

test('ordinary shutdown cancels the watchdog before the fourth probe', async () => {
  const f = fixture([refused(), refused(), refused()]);
  await f.advance(90_000); f.stop(); await f.advance(90_000);
  assert.equal(f.probes, 3); assert.deepEqual(f.exits, []);
});

test('dual-stack nested refusals count; permission errors and cyclic causes alone never trigger shutdown', async () => {
  const nested = new TypeError('fetch failed', { cause: new AggregateError([
    refused(), new Error('wrapped', { cause: Object.assign(new Error(), { code: 'UND_ERR_CLOSED' }) }),
  ]) });
  const f = fixture(Array(5).fill(nested));
  await f.advance(150_000); assert.equal(f.exits.length, 1);
  const cycle = new Error('unknown'); cycle.cause = cycle;
  const mixed = Object.assign(new AggregateError([refused(), Object.assign(new Error(), { code: 'EACCES' })]), { code: 'ECONNREFUSED' });
  const unknown = fixture([cycle, mixed, cycle, mixed, cycle, mixed]);
  await unknown.advance(180_000); assert.deepEqual(unknown.exits, []);
  const interrupted = fixture([refused(), refused(), refused(), mixed, refused(), refused()]);
  await interrupted.advance(180_000); assert.deepEqual(interrupted.exits, []);
});

test('bind the actual ancestor once: late discovery, same owner, inaccessible identity and PID reuse', async () => {
  const worker = { pid: process.pid, name: 'node', birth: 100n };
  const shell = { pid: 50, name: 'cmd', birth: 90n };
  const ls = { pid: 51, name: 'language_server', birth: 80n };
  let current = null, permission = false, binds = 0;
  const probe = createOwnerProbe({ exists() {
    if (permission) throw Object.assign(new Error(), { code: 'EPERM' });
  }, rows(pid, ancestors) {
    if (ancestors) { binds++; return current ? [worker, shell, current] : [worker]; }
    assert.equal(pid, ls.pid);
    return current ? [current] : [];
  } });
  assert.equal(await probe(), 'unbound');
  current = { ...ls, birth: 95n }; assert.equal(await probe(), 'unbound', 'reused parent is younger than wrapper');
  current = ls; assert.equal(await probe(), 'alive');
  const f = fixture([], probe);
  await f.advance(180_000); assert.equal(f.probes, 0); assert.deepEqual(f.exits, []);
  permission = true; assert.equal(await probe(), 'unknown');
  await f.advance(180_000); assert.deepEqual(f.exits, []);
  permission = false; current = { ...ls, birth: 200n };
  await f.advance(120_000); assert.deepEqual(f.exits, []);
  await f.advance(30_000); assert.deepEqual(f.exits, [{ now: 510_000, reason: 'language server gone' }]);
  assert.equal(f.probes, 0, 'a new HTTP listener cannot vote for the old owner');
  assert.equal(binds, 3, 'never adopt the replacement');
});
