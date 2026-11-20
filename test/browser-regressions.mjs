// Optional real-browser checks; runtime and node:test tests stay dependency-free.
// node test/browser-regressions.mjs [path to playwright module] [browser channel]
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UI_HTML } from '../agy-capsule/sidecars/agy_capsule/server.mjs';
import { DEFAULT_SETTINGS } from '../agy-capsule/sidecars/agy_capsule/settings.mjs';
import { buildRuntimeBundle, startDeckInjector } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';
import { hostFixture } from './cdp-host-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const launch = { headless: true, ...(process.argv[3] ? { channel: process.argv[3] } : {}) };
const owner = 1234;
const apply = (page, data) => page.evaluate(({ data, owner }) => globalThis.__agyCapsuleDeck.apply(data, location.pathname, owner), { data, owner });
const snapshot = () => ({
  uiVersion: Number(UI_HTML.match(/d\.uiVersion !== (\d+)/)[1]),
  contextTokens: 128000, maxContextTokens: 256000, cachedIn: 100000,
  turn0Tokens: 20000, totalOutputTokens: 24000, totalThinkingTokens: 12000,
  lastStepEpochMs: Date.now(),
  generation: { requestIndex: 4, tps: 100, output: 400, ttft: 1, streaming: 3, duration: 4 },
  turnSpeed: { userStepIndex: 20, generation: { requestIndex: 4, tps: 100 }, hasActiveStep: false, completedAtMs: Date.now() },
  prefs: { ...DEFAULT_SETTINGS, showSpeed: false },
  quotaGroups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: .58 }, { window: 'weekly', remainingFraction: .55 }] }],
});

await test('Footer probe and capsule follow the visible composer and release the old one', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const panel = (id, style) => `<section id="${id}" style="${style}"><div class="agy-composer-footer"><div><button>Gemini</button></div></div></section>`;
  await page.setContent([
    panel('hidden', 'display:none'), panel('invisible', 'visibility:hidden'), panel('transparent', 'opacity:0'),
    panel('offscreen', 'position:fixed;left:110vw;width:950px'), panel('flat', 'width:0'),
    panel('small', 'width:320px'), panel('active', 'width:800px'),
  ].join(''));
  await page.evaluate(buildRuntimeBundle(owner).code);
  const probe = () => page.evaluate(owner => globalThis.__agyCapsuleDeck.readState(owner).hasFooter, owner);
  const host = page.locator('#agy-capsule-host');
  const mountedIn = () => host.evaluate(el => el.closest('section').id);
  const data = snapshot();
  assert.equal(await probe(), true);
  await apply(page, data);
  assert.equal(await mountedIn(), 'active');

  await page.locator('#active').evaluate(el => {
    el.querySelector('.agy-composer-footer > div').classList.add('dk-fl-squeezed');
    el.hidden = true;
  });
  await apply(page, data);
  assert.equal(await mountedIn(), 'small');
  assert.equal(await page.locator('#active .dk-fl-squeezed').count(), 0);
  await page.locator('#small').evaluate(el => { el.hidden = true; });
  assert.equal(await probe(), false);
  await apply(page, data);
  assert.equal(await host.count(), 0);
  await page.locator('#hidden').evaluate(el => { el.style.display = 'block'; });
  assert.equal(await probe(), true);
  await apply(page, data);
  assert.equal(await mountedIn(), 'hidden');
});

await test('Child capsules follow the transcript in side and main views without borrowing the parent', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const main = '11111111-1111-1111-1111-111111111111';
  const first = '22222222-2222-2222-2222-222222222222';
  const second = '33333333-3333-3333-3333-333333333333';
  await page.route('http://agy.test/**', route => route.fulfill({ body: '', contentType: 'text/html' }));
  await page.goto('http://agy.test/c/' + main);
  await page.setContent(`
    <div style="display:flex;gap:10px">
      <main data-testid="conversation-view" data-cascade-id="${main}" style="width:600px;min-height:150px">
        <div class="agy-composer-footer"><div><button>Parent model</button></div></div>
      </main>
      <aside style="width:220px">
        <div data-testid="subagent-tab-conversation" data-cascade-id="${first}" style="height:150px"></div>
        <div data-testid="subagent-tab-composer"></div>
      </aside>
      <aside hidden>
        <div data-testid="subagent-tab-conversation" data-cascade-id="${second}" style="height:150px"></div>
        <div data-testid="subagent-tab-composer"></div>
      </aside>
    </div>
  `);
  await page.evaluate(buildRuntimeBundle(owner).code);
  const state = () => page.evaluate(owner => globalThis.__agyCapsuleDeck.readState(owner), owner);
  const applyMain = (id, data) => page.evaluate(({ owner, id, data }) =>
    globalThis.__agyCapsuleDeck.apply(data, location.pathname, owner, id), { owner, id, data });
  const applyChild = (id, data) => page.evaluate(({ owner, id, data }) =>
    globalThis.__agyCapsuleDeck.applySubagent(data, location.pathname, owner, id), { owner, id, data });
  const parent = page.locator('#agy-capsule-host');
  const child = page.locator('[data-agy-capsule-subagent]');
  const nativeStyle = page.locator('#agy-capsule-native-layout');
  const firstData = { ...snapshot(), subagent: { model: 'Child model (High)' }, contextTokens: 64000,
    turnQueue: { waits: [60], turnTerminal: true } };
  assert.deepEqual((await state()).subagentIds, [first], 'a retained hidden tab is ignored');
  await apply(page, snapshot());
  assert.equal(await parent.locator('[data-k="pillCtx"]').textContent(), '50%');
  await page.evaluate(() => history.replaceState({}, '', '/'));
  assert.equal((await state()).conversationId, main);
  assert.equal((await state()).hasFooter, true, 'an ordinary main composer survives without a /c/ route');
  assert.equal(await applyMain(main, snapshot()), true);
  assert.equal(await parent.locator('[data-k="pillCtx"]').textContent(), '50%');
  assert.equal(await child.count(), 0);
  assert.equal(await applyChild(first, firstData), true);
  assert.equal(await child.locator('[data-el="childModel"]').textContent(), 'Child model (High)');
  assert.equal(await child.locator('[data-el="grpCtx"] [data-k="pillCtx"]').textContent(), '25%');
  assert.equal(await child.locator('[data-el="grpQuota"]').isVisible(), false);
  assert.equal(await child.locator('[data-el="grpError"]').getAttribute('data-alert-mode'), 'queue');
  assert.ok((await child.locator('#deck-metrics-strip').boundingBox()).width <= 220);
  await child.locator('[data-el="grpCtx"] .dk-pill').click();
  assert.equal(await child.locator('.dk-ctx-pop').isVisible(), true);
  assert.equal(await parent.locator('[data-k="pillCtx"]').textContent(), '50%');

  await page.locator('aside:not([hidden]) [data-testid="subagent-tab-conversation"]').evaluate((el, id) => {
    el.dataset.cascadeId = id;
  }, second);
  assert.equal(await child.count(), 0, 'the same URL must not keep the previous child strip');
  assert.deepEqual((await state()).subagentIds, [second]);
  assert.equal(await nativeStyle.count(), 1, 'side cleanup preserves the main native layout');
  assert.equal(await applyChild(first, firstData), false, 'reject a delayed snapshot for the previous child');
  const incomplete = { ...firstData, subagent: { model: '' }, maxContextTokens: 0,
    requestError: { kind: 'rate_limited' } };
  await applyChild(second, incomplete);
  assert.equal(await child.locator('[data-el="childModel"]').isVisible(), false);
  assert.equal(await child.locator('[data-el="grpCtx"]').isVisible(), false);
  assert.equal(await child.locator('[data-el="grpError"]').getAttribute('data-alert-mode'), 'error');

  await page.evaluate(id => {
    document.querySelector('aside:not([hidden])').remove();
    document.querySelector('main').dataset.cascadeId = id;
    document.querySelector('.agy-composer-footer').remove();
  }, second);
  assert.deepEqual((await state()).subagentIds, [second], 'read the displayed transcript ID, not the old URL');
  assert.equal(await parent.count(), 0);
  await applyChild(second, null);
  assert.equal(await child.count(), 0, 'no verified child snapshot means no strip');
  await page.evaluate(id => history.pushState({}, '', '/c/' + id), second);
  assert.deepEqual((await state()).subagentIds, [second]);
  await applyChild(second, firstData);
  assert.equal(await page.locator('main > [data-agy-capsule-subagent]').count(), 1);
  await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend',
    '<div><div class="agy-composer-footer"><div style="min-height:24px"></div></div></div>'));
  assert.equal((await state()).hasFooter, true);
  await apply(page, firstData);
  assert.equal(await child.count(), 1);
  assert.equal(await parent.count(), 0, 'a child in the main composer is still read-only');
  await page.locator('main').evaluate((el, id) => { el.dataset.cascadeId = id; }, main);
  assert.equal(await child.count(), 0, 'main transcript changes also clear the current child');
  assert.equal(await applyMain(second, firstData), false, 'reject a delayed snapshot for the old main transcript');
  assert.equal(await applyMain(main, snapshot()), true);
  assert.equal(await parent.count(), 1, 'the visible normal transcript still wins over the stale URL');
  await page.evaluate(() => globalThis.__agyCapsuleDeck.dispose());
  assert.equal(await child.count(), 0);
  assert.equal(await parent.count(), 0);
});

await test('Sidebar clears empty or missing quotas and renders a later fresh snapshot', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = snapshot();
  let authorized = true;
  await page.route('http://agy.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/context') {
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().headers()['x-sidecar-token'], 'panel-fixture');
      assert.equal(new URL(route.request().url()).search, '');
      if (!authorized) return route.fulfill({ status: 401, contentType: 'text/plain', body: 'Unauthorized' });
      return route.fulfill({ json: data });
    }
    if (path === '/preload.js') return route.fulfill({ body: '' });
    return route.fulfill({ contentType: 'text/html', body: UI_HTML });
  });
  await page.goto('http://agy.test/?token=panel-fixture');
  await page.waitForFunction(() => document.querySelectorAll('#quota-root .quota-group').length === 1);
  const quotas = data.quotaGroups;
  for (const empty of [[], null]) {
    data.quotaGroups = empty;
    await page.waitForFunction(() => document.getElementById('quota-root').childElementCount === 0, null, { timeout: 3000 });
    assert.equal(await page.locator('#quota-root').textContent(), '');
    data.quotaGroups = quotas;
    await page.waitForFunction(() => document.querySelectorAll('#quota-root .quota-group').length === 1);
  }
  assert.deepEqual(errors, []);
  authorized = false;
  await page.locator('#panel-auth-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.sidebar-content').isVisible(), false);
  assert.match(await page.locator('#panel-auth-notice').textContent(), /Antigravity/);
  assert.match(await page.locator('#panel-auth-notice').textContent(), /S1/);
});

await test('Chinese health notice debounces failures, prioritizes sidebar data and recovers without losing statistics', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
  const data = snapshot(); data.prefs.language = 'zh-CN';
  let failure = 0;
  await page.addInitScript(() => {
    const interval = window.setInterval;
    window.setInterval = (fn, ms, ...args) => {
      if (fn.name !== 'refresh') return interval(fn, ms, ...args);
      window.testRefresh = fn;
    };
  });
  await page.route('http://agy.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/context') {
      if (failure === 1) return route.abort();
      if (failure === 2) return route.fulfill({ status: 503, body: 'busy' });
      if (failure === 3) return route.fulfill({ body: '{' });
      if (failure === 4) return route.fulfill({ status: 403, body: '' });
      return route.fulfill({ json: data });
    }
    return route.fulfill(path === '/preload.js' ? { body: '' } : { contentType: 'text/html', body: UI_HTML });
  });
  await page.goto('http://agy.test/?token=fixture');
  await page.waitForFunction(() => document.querySelector('#used-pct').textContent === '50%');
  const tick = () => page.evaluate(() => window.testRefresh());
  const box = page.locator('#cdp-notice'), badge = box.locator('#health-code');
  data.deckCdp = 'unverified'; await tick(); assert.equal(await box.isVisible(), false);
  await tick(); assert.equal(await badge.textContent(), '代码 F2');
  assert.match(await box.textContent(), /侧栏统计不受影响/);
  assert.equal(await box.locator('details').isVisible(), false);
  assert.equal(await box.locator('#cdp-fix-btn').isVisible(), false);
  failure = 1; await tick(); failure = 0; await tick();
  assert.ok(await box.isVisible(), 'an already-confirmed F2 must not flicker after a failed poll');
  assert.equal(await badge.textContent(), '代码 F2');
  data.deckCdp = 'ok'; await tick(); assert.equal(await box.isVisible(), false);
  data.health = { code: 'S3' }; await tick(); assert.equal(await box.isVisible(), false);
  await tick(); assert.equal(await badge.textContent(), '代码 S3');
  data.health = null; await tick(); assert.equal(await box.isVisible(), false);
  data.health = { code: 'S4' }; await tick(); assert.equal(await badge.textContent(), '代码 S4');
  for (const f of [1, 2, 3, 1]) { failure = f; await tick(); assert.equal(await badge.textContent(), '代码 S4'); }
  failure = 2; await tick(); assert.equal(await badge.textContent(), '代码 S2');
  assert.match(await box.textContent(), /数据可能已过时/);
  assert.equal(await page.locator('#sidebar-stats').getAttribute('data-stale'), 'true');
  assert.equal(await page.locator('#used-pct').textContent(), '50%');
  data.health = null; data.deckCdp = 'ok'; failure = 0; await tick();
  assert.equal(await box.isVisible(), false);
  assert.equal(await page.locator('#sidebar-stats').getAttribute('data-stale'), 'false');
  data.deckCdp = 'missing'; await tick(); assert.equal(await box.isVisible(), false);
  await tick(); assert.equal(await badge.textContent(), '代码 F1'); assert.equal(await box.locator('details').isVisible(), true);
  data.deckCdp = 'ok'; await tick(); assert.equal(await box.isVisible(), false);
  data.deckCdp = 'unreachable'; await tick(); assert.equal(await box.isVisible(), false);
  await tick(); assert.equal(await badge.textContent(), '代码 F1');
  for (const [state, code] of [['inject-failed', 'F4'], ['no-anchor', 'F3']]) {
    data.deckCdp = state; await tick(); assert.equal(await badge.textContent(), '代码 ' + code);
    assert.equal(await box.locator('details').isVisible(), false);
  }
  data.deckCdp = 'ok'; await tick(); assert.equal(await box.isVisible(), false);
  data.deckCdp = 'unverified'; await tick(); await tick();
  assert.ok(await box.isVisible());
  failure = 4; await tick();
  const auth = page.locator('#panel-auth-notice');
  assert.ok(await auth.isVisible()); assert.match(await auth.innerText(), /S1/);
  assert.equal(await box.isVisible(), false);
  const bounds = await auth.boundingBox();
  assert.ok(bounds.x >= 10 && bounds.x + bounds.width <= 350, 'S1 has margins at 360px');
  failure = 0; data.deckCdp = 'ok'; await page.reload();
  await page.waitForFunction(() => document.querySelector('#used-pct').textContent === '50%');
  assert.equal(await auth.isVisible(), false); assert.equal(await box.isVisible(), false);
});

await test('Footer reveals and wider speed values never overlap the native controls', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>
    *{box-sizing:border-box}:root{--foreground:#eee;--muted-foreground:#aaa;--background:#141414;--card:#222;--border:#444}
    body{margin:16px;font:13px Arial}.agy-composer-footer{display:flex;align-items:center;gap:4px;padding:2px;position:absolute;bottom:40px}
    .footer-left{display:flex;align-items:center;flex:1;min-width:0}.model{display:flex;white-space:nowrap}
    .right{display:flex;align-items:center;gap:2px;flex-shrink:0}button{font:inherit;white-space:nowrap}
    [data-testid=permissions-selector-trigger]{display:flex;align-items:center;gap:4px;padding:6px;border:0;height:28px}
    [data-testid=permissions-selector-trigger] svg{width:14px;height:14px;flex-shrink:0}
    </style><div class="agy-composer-footer"><div class="footer-left"><button>+</button><div class="model"><button>Gemini 4 Argon Medium</button></div></div><div class="right"><button data-testid="permissions-selector-trigger"><svg></svg><span>Turbo</span><svg></svg></button><button>Send</button></div></div>`);
  await page.evaluate(buildRuntimeBundle(owner).code);
  const samples = () => page.evaluate(async () => {
    const gaps = [];
    for (let i = 0; i < 18; i++) {
      await new Promise(requestAnimationFrame);
      const strip = document.getElementById('agy-capsule-host').shadowRoot.getElementById('deck-metrics-strip');
      const bounds = strip.getBoundingClientRect(), controls = document.querySelector('.right').getBoundingClientRect();
      if (bounds.width > 0) gaps.push(bounds.right - controls.left);
    }
    return gaps;
  });
  for (const width of [260, 300, 340, 380, 420, 460, 500, 540, 580]) {
    await page.locator('.agy-composer-footer').evaluate((element, value) => element.style.width = value + 'px', width);
    const data = snapshot();
    await apply(page, data);
    await page.waitForTimeout(250);
    data.prefs.showSpeed = true;
    await apply(page, data);
    assert.ok((await samples()).every(overlap => overlap <= 1), `Speed reveal overlaps at ${width}px`);
    data.turnSpeed.generation.tps = 10000;
    await apply(page, data);
    assert.ok((await samples()).every(overlap => overlap <= 1), `Wider text overlaps at ${width}px`);
  }
  assert.deepEqual(errors, []);
});

await test('Pinned popovers fit a narrower clipping container and regain their width when it grows', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<style>
    body{font:13px Arial}#clipper{width:400px;overflow:hidden;position:absolute;bottom:50px;left:100px;padding-top:330px}
    .agy-composer-footer{display:flex;align-items:center;gap:4px}.footer-left{display:flex;align-items:center;flex:1;min-width:0}
    </style><div id="clipper"><div class="agy-composer-footer"><div class="footer-left"><button>Gemini</button></div><button>Send</button></div></div>`);
  await page.evaluate(buildRuntimeBundle(owner).code);
  const data = snapshot();
  data.prefs = { ...data.prefs, panelLayout: 'matched', quotaIndicator: 'bar', resetFormat: 'localized' };
  data.quotaGroups[0].buckets[0].resetTime = new Date(Date.now() + 5 * 86400000 + 3 * 3600000).toISOString();
  data.requestError = { kind: 'rate_limited', diagnostic: 'Too many requests: ' + 'x'.repeat(110) };
  assert.equal(await apply(page, data), true);
  const clipper = page.locator('#clipper');
  for (const name of ['Ctx', 'Quota', 'Error']) {
    const group = page.locator(`#agy-capsule-host [data-el="grp${name}"]`);
    const panel = group.locator('.dk-pop');
    await group.locator('.dk-pill').click();
    const wide = await panel.boundingBox();
    assert.ok(wide.width >= 228);
    await clipper.evaluate(el => { el.style.width = '210px'; });
    await page.waitForFunction(name => {
      const root = document.getElementById('agy-capsule-host').shadowRoot;
      const pop = root.querySelector(`[data-el="grp${name}"] .dk-pop`);
      const { left, right } = document.getElementById('clipper').getBoundingClientRect();
      const bounds = pop.getBoundingClientRect();
      return bounds.width > 0 && bounds.left >= left + 3 && bounds.right <= right - 3;
    }, name, { timeout: 2500 });
    assert.equal(await group.getAttribute('data-pinned'), 'true');
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${name} content fits the constrained panel`);
    await clipper.evaluate(el => { el.style.width = '400px'; });
    await page.waitForFunction(({ name, width }) => {
      const root = document.getElementById('agy-capsule-host').shadowRoot;
      return Math.abs(root.querySelector(`[data-el="grp${name}"] .dk-pop`).getBoundingClientRect().width - width) <= 1;
    }, { name, width: wide.width }, { timeout: 2500 });
    await page.keyboard.press('Escape');
  }
});

await test('A newer injector takes over the same bundle and rejects an in-flight write from the old owner', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://127.0.0.1:5351/', route => route.fulfill({ body: '<!doctype html>', contentType: 'text/html' }));
  await page.goto('https://127.0.0.1:5351/');
  await page.setContent('<div class="agy-composer-footer" style="display:flex;width:600px"><div style="display:flex;flex:1"><button>Gemini</button></div><button>Send</button></div>');

  const directory = mkdtempSync(join(tmpdir(), 'agy-cdp-takeover-'));
  const portFile = join(directory, 'port');
  writeFileSync(portFile, '12345\n');
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  const fixture = hostFixture(directory);
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 'page', type: 'page', url: page.url(), webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/page/page' }] });
  globalThis.WebSocket = class {
    constructor() {
      page.context().newCDPSession(page).then(session => {
        this.session = session;
        for (const method of ['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared']) {
          session.on(method, params => this.onmessage?.({ data: JSON.stringify({ method, params }) }));
        }
        this.readyState = 1; this.onopen?.();
      });
    }
    async send(raw) {
      const { id, method, params } = JSON.parse(raw);
      let result;
      try { result = await this.session.send(method, params); } catch {}
      this.onmessage?.({ data: JSON.stringify({ id, result }) });
    }
    close() { this.readyState = 3; void this.session.detach().catch(() => {}); this.onclose?.(); }
  };
  const data = contextTokens => ({ ...snapshot(), contextTokens, maxContextTokens: 1000 });
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  let startedRace = false, superseded = false;
  const old = startDeckInjector(async () => {
    if (!startedRace) return data(100);
    waiting.resolve();
    await release.promise;
    return data(200);
  }, { ...fixture, portFile, instanceTs: owner, onSuperseded: () => { superseded = true; } });
  const newer = startDeckInjector(async () => data(800), { ...fixture, portFile, instanceTs: owner + 1 });
  try {
    await old.tick();
    const pill = page.locator('#agy-capsule-host [data-k="pillCtx"]');
    assert.equal(await pill.textContent(), '10%');
    startedRace = true;
    const oldTick = old.tick();
    await waiting.promise;
    await newer.tick();
    assert.equal(await pill.textContent(), '80%');
    assert.equal(await page.evaluate(() => globalThis.__agyCapsuleDeck.owner), owner + 1);
    release.resolve();
    await oldTick;
    assert.equal(superseded, true);
    assert.equal(await pill.textContent(), '80%');
  } finally {
    release.resolve();
    await old.stop();
    await newer.stop();
    Object.assign(globalThis, originals);
    rmSync(directory, { recursive: true, force: true });
  }
});

await test('Model picker submits one host option and releases the native trigger', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<textarea>draft</textarea><div class="agy-composer-footer" style="position:fixed;bottom:12px;width:90vw;display:flex"><div style="flex:1;display:flex"><button data-testid="model-selector-trigger">Native menu</button></div><div>Send</div></div>');
  const trigger = page.getByTestId('model-selector-trigger');
  await trigger.evaluate(button => {
    const options = ['Claude (Low)', 'Argon (Low)', 'Argon (High)', 'Fixed'].map(label => ({ label }));
    options.push({ label: 'Disabled', disabled: true });
    let selected = options[0];
    window.calls = [];
    button.__reactFiber$fixture = { memoizedProps: { conversationId: 'fixture', placement: 'top' }, return: {
      memoizedProps: { value: {
        visibleModelConfigs: options, getModelConfigForConversation: () => selected,
        setModelConfigByLabelForConversation(label, conversation, persist) {
          window.calls.push([label, conversation, persist]);
          selected = options.find(option => option.label === label);
        },
      } },
    } };
  });
  await page.evaluate(buildRuntimeBundle(owner).code);
  const data = snapshot();
  await apply(page, data);
  const picker = page.locator('[data-el="modelPicker"]');
  assert.equal(await picker.count(), 0);
  data.prefs.modelEffortPicker = true;
  await apply(page, data);
  assert.equal(await trigger.evaluate(el => el.getBoundingClientRect().width), 22);
  await picker.click();
  assert.equal(await page.getByRole('menuitem', { name: 'Disabled', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: 'Argon (Low)', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Argon (High)', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), [['Argon (High)', 'fixture', false]]);
  assert.equal(await picker.textContent(), 'Argon High');
  assert.equal(await page.locator('textarea').inputValue(), 'draft');
  await picker.click();
  await trigger.evaluate(button => { button.__reactFiber$fixture.memoizedProps.conversationId = 'other'; });
  await page.getByRole('menuitem', { name: 'Fixed', exact: true }).click();
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  data.prefs.modelEffortPicker = false;
  await apply(page, data);
  assert.equal(await picker.count(), 0);
  assert.equal(await trigger.getAttribute('data-deck-model-bubble'), null);
});

await test('2.33 model picker shows the inherited effort, can hide previews, and restores the native button', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div class="agy-composer-footer" style="position:fixed;bottom:12px;width:90vw;display:flex"><div style="flex:1;display:flex"><button data-testid="model-selector-trigger">Native menu</button></div><div>Send</div></div>');
  const trigger = page.getByTestId('model-selector-trigger');
  await trigger.evaluate(button => {
    const modelOptions = ['Claude (Low)', 'Argon (Low)', 'Argon (Medium)', 'Argon (High)', 'Fixed (High)']
      .map((label, value) => ({ label, value }));
    window.calls = [];
    const selector = {
      modelOptions,
      selectedModel: modelOptions[0],
      setSelectedModel(option) {
        window.calls.push({ label: option.label, exact: modelOptions.includes(option) });
        this.selectedModel = option;
      },
    };
    button.__reactFiber$fixture = { memoizedProps: { value: selector }, return: {
      memoizedProps: { conversationId: 'fixture', placement: 'top-start' },
    } };
  });
  await page.evaluate(buildRuntimeBundle(owner).code);
  const data = snapshot();
  Object.assign(data.prefs, { modelEffortPicker: true, keepNativeModelEntry: false });
  await apply(page, data);
  const picker = page.locator('[data-el="modelPicker"]');
  assert.equal(await trigger.getAttribute('data-deck-model-bubble'), 'hidden');
  await picker.click();
  const argon = page.locator('button.dk-model-row[data-family="Argon"]');
  assert.equal(await argon.locator('.dk-mp-effort').textContent(), 'Low');
  await argon.click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ label: 'Argon (Low)', exact: true }]);

  data.prefs.hideDefaultEffort = true;
  await apply(page, data);
  assert.equal(await picker.textContent(), 'Argon Low');
  await picker.click();
  assert.equal(await argon.locator('.dk-mp-effort').count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: 'Fixed (High)', exact: true }).textContent(), 'Fixed');
  await argon.hover();
  assert.equal(await page.getByRole('menuitem', { name: 'Argon (High)', exact: true }).isVisible(), true);

  data.prefs.modelEffortPicker = false;
  await apply(page, data);
  assert.equal(await picker.count(), 0);
  assert.equal(await trigger.getAttribute('data-deck-model-bubble'), null);
});
