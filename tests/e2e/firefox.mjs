// End-to-end test in a real Firefox DevTools, driven over Marionette, against the fake Symfony API
// of server.mjs. Firefox counterpart of run.mjs, which needs Chrome's CDP.
// Usage: node tests/e2e/firefox.mjs <firefox binary> <extension dir> <screenshot.png> [headed]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';

const [firefox, ext, shot, mode] = process.argv.slice(2);
if (!firefox || !ext || !shot) {
  console.error('Usage: node tests/e2e/firefox.mjs <firefox binary> <extension dir> <screenshot.png> [headed]');
  process.exit(2);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push({ ok: !!ok, name, detail });

async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}${last ? `: ${last.message}` : ''}`);
}
const settle = (fn, what) => waitFor(fn, what, 5000).catch(() => false);

// ---------- Marionette: "<length>:<json>" frames, commands [0, id, name, params] ----------

function marionette(port) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  let id = 0;
  const pending = new Map();
  let hello;
  const ready = new Promise((r, reject) => { hello = r; sock.on('error', reject); });
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const colon = buf.indexOf(':');
      if (colon < 0) return;
      const len = Number(buf.subarray(0, colon));
      if (buf.length < colon + 1 + len) return;
      const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len));
      buf = buf.subarray(colon + 1 + len);
      if (!Array.isArray(msg)) { hello(msg); continue; }
      const [, mid, err, res] = msg;
      const p = pending.get(mid);
      pending.delete(mid);
      err ? p.reject(new Error(`${err.error}: ${err.message}`)) : p.resolve(res);
    }
  });
  const send = (name, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    const body = Buffer.from(JSON.stringify([0, mid, name, params]));
    sock.write(`${body.length}:`);
    sock.write(body);
  });
  return { ready, send, close: () => sock.destroy() };
}

// ---------- launch ----------

const server = await startServer({ performancePanel: 'core.performance' });
const plain = await startServer();
const APP = server.base;
const port = 2828 + Math.floor(Math.random() * 1000);
const profile = mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));
writeFileSync(path.join(profile, 'user.js'), [
  ['marionette.port', port],
  ['browser.shell.checkDefaultBrowser', false],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['browser.aboutwelcome.enabled', false],
  ['devtools.toolbox.host', 'bottom'],
].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

const proc = spawn(firefox, ['--marionette', '--no-remote', '--profile', profile,
  ...(mode === 'headed' ? [] : ['--headless']), '--width', '1100', '--height', '800'], { stdio: 'ignore', env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
const m = await waitFor(async () => {
  const c = marionette(port);
  const ok = await Promise.race([c.ready, sleep(500).then(() => null)]).catch(() => null);
  if (!ok) { c.close(); return null; }
  return c;
}, 'Marionette', 60000);

const chrome = async (body, args = []) => {
  await m.send('Marionette:SetContext', { value: 'chrome' });
  // Marionette wraps the script in a plain function: an async IIFE allows await.
  return m.send('WebDriver:ExecuteScript', { script: `return (async () => { ${body} })();`, args, newSandbox: false })
    .then(r => r.value);
};
const content = async body => {
  await m.send('Marionette:SetContext', { value: 'content' });
  return m.send('WebDriver:ExecuteScript', { script: body }).then(r => r.value);
};

// Chrome-scope helper: the toolbox of the app tab and its Symfony tab.
const PANEL = `
  const { require } = ChromeUtils.importESModule('resource://devtools/shared/loader/Loader.sys.mjs');
  const { gDevTools } = require('devtools/client/framework/devtools');
  const toolbox = gDevTools.getToolboxForTab(gBrowser.tabs[0]);
  const tool = toolbox && toolbox.getAdditionalTools().find(t => t.label === 'Symfony');
  const frame = tool && toolbox.doc.getElementById('toolbox-panel-iframe-' + tool.id);
  const inner = frame && frame.contentDocument && frame.contentDocument.querySelector('browser');
`;
// The panel runs in the extension process: a frame script evaluates expressions there, with
// win and doc bound to the panel's window, and sends back their JSON value.
const FRAME_SCRIPT = `addMessageListener('e2e:eval', async ({ data }) => {
  // A system sandbox: the extension's CSP blocks a plain eval.
  const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxPrototype: content, wantXrays: true });
  sb.win = content;
  sb.doc = content.document;
  let value = null, error = null;
  try { value = JSON.parse(JSON.stringify(await Cu.evalInSandbox(data.expr, sb)) ?? 'null'); } catch (e) { error = String(e); }
  sendAsyncMessage('e2e:result', { id: data.id, value, error });
});`;
let evalId = 0;
const panel = expr => chrome(`${PANEL}
  if (!inner || !/panel\.html$/.test(inner.currentURI.spec)) throw new Error('panel not loaded');
  const mm = inner.messageManager;
  window.__e2eLoaded ??= new WeakSet();
  if (!window.__e2eLoaded.has(mm)) {
    mm.loadFrameScript('data:,' + encodeURIComponent(${JSON.stringify(FRAME_SCRIPT)}), false);
    window.__e2eLoaded.add(mm);
  }
  const id = ${++evalId};
  return new Promise((resolve, reject) => {
    const onResult = ({ data }) => {
      if (data.id !== id) return;
      mm.removeMessageListener('e2e:result', onResult);
      data.error ? reject(new Error(data.error)) : resolve(data.value);
    };
    mm.addMessageListener('e2e:result', onResult);
    mm.sendAsyncMessage('e2e:eval', { id, expr: ${JSON.stringify('(' + expr + ')')} });
  });`);

try {
  await m.send('WebDriver:NewSession', { capabilities: {} });
  const addonId = (await m.send('Addon:Install', { path: ext, temporary: true })).value;
  check('add-on installs as a temporary add-on', addonId, addonId);

  await m.send('WebDriver:Navigate', { url: `${APP}/` });
  await chrome(`
    const { require } = ChromeUtils.importESModule('resource://devtools/shared/loader/Loader.sys.mjs');
    const { gDevTools } = require('devtools/client/framework/devtools');
    await gDevTools.showToolboxForTab(gBrowser.selectedTab, { toolId: 'webconsole' });
  `);
  const toolId = await waitFor(() => chrome(`${PANEL} return tool && tool.id;`), 'Symfony tab in the toolbox');
  check('Symfony tab added to the toolbox', toolId, toolId);
  await sleep(1000); // leaves time for devtools.html to register its onRequestFinished listener

  // 1. Requests made before the Symfony tab is ever shown.
  await content(`return (async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await fetch('/api/orders'); await wait(50);
    await new Promise(ok => { const x = new XMLHttpRequest(); x.onloadend = ok; x.open('GET', '/api/orders?filter%5Bstatus%5D=open'); x.send(); }); await wait(50);
    await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Foo', tags: [1, 2] }) }); await wait(50);
    await fetch('/api/fail'); await wait(50);
    await fetch('/api/plain'); await wait(50);
    await new Promise(ok => { const i = new Image(); i.onload = i.onerror = ok; i.src = '/img.png?' + Date.now(); });
  })()`);
  await sleep(500);

  // 2. Show the Symfony tab, as a click on it would.
  await chrome(`${PANEL} await toolbox.selectTool(tool.id);`);
  await waitFor(() => panel(`doc && doc.readyState === 'complete' && !!doc.getElementById('list')`), 'panel.html');

  const rows = () => panel(`[...doc.querySelectorAll('#list .row')].map(r => ({
    status: r.querySelector('.status').textContent, method: r.querySelector('.method').textContent,
    path: r.querySelector('.path').textContent, selected: r.classList.contains('selected'),
    title: r.title, prof: r.querySelector('a.prof') ? r.querySelector('a.prof').href : null }))`);
  const detail = () => panel(`({
    url: doc.querySelector('.summary .url') && doc.querySelector('.summary .url').textContent,
    links: [...doc.querySelectorAll('.profiler-links a')].map(a => [a.textContent, a.href]),
    body: doc.querySelector('.tab-body') && doc.querySelector('.tab-body').textContent.slice(0, 300),
    tab: doc.querySelector('.tabs button.active') && doc.querySelector('.tabs button.active').textContent })`);
  const click = selector => panel(`(${selector}).click()`);
  const row = test => `[...doc.querySelectorAll('#list .row')].find(r => ${test})`;
  const tab = label => `[...doc.querySelectorAll('.tabs button')].find(b => b.textContent === ${JSON.stringify(label)})`;

  let r = await settle(async () => { const v = await rows(); return v.length >= 5 && v; }, 'rows') || await rows();
  check('captured before the panel was shown: 5 API calls, newest first',
    r.length === 5 && r[0].path === '/api/plain' && r[4].path === '/api/orders', r);
  check('XHR/fetch only hides the image (resourceType from Sec-Fetch-Dest)', !r.some(x => x.path.includes('img.png')), r);
  check('latest call selected (Follow latest)', r[0] && r[0].selected, r);
  check('URL decoded: %5B shown as [', r.some(x => x.path === '/api/orders?filter[status]=open'), r);
  const fail = r.find(x => x.status === '500');
  check('⏱ on a 500 opens the Exception panel, link built from X-Debug-Token',
    /^http:\/\/localhost:\d+\/_profiler\/tok\d+\?panel=exception$/.test(fail && fail.prof), fail);
  check('no ⏱ without X-Debug-Token', r.find(x => x.path === '/api/plain')?.prof === null, r);
  const orders = r.find(x => x.method === 'GET' && x.path === '/api/orders');
  check('⏱ read from X-Debug-Token-Link', /\/index\.php\/_profiler\/tok\d+$/.test(orders && orders.prof), orders);
  const theme = await panel(`doc.documentElement.dataset.theme`);
  check('theme follows DevTools', theme === 'light' || theme === 'dark', theme);

  // 3. Detail of GET /api/orders: body loaded through har.getContent().
  await click(row(`r.querySelector('.method').textContent === 'GET' && r.title.endsWith('/api/orders')`));
  let d = await settle(async () => {
    const v = await detail();
    return /\?panel=core\.performance$/.test(v.links.find(l => l[0] === 'Performance')?.[1]) && v;
  }, 'core.performance link') || await detail();
  check('Response tab shows the JSON tree', d.tab === 'Response' && /total: 2/.test(d.body) && /items: Array\(2\)/.test(d.body), d);
  check('profiler buttons on a 200', d.links.map(l => l[0]).join() === 'Profiler ↗,Doctrine,Logs,Performance,Request', d.links);
  check('Performance links the custom panel (fetch with host_permissions)',
    /\/_profiler\/tok\d+\?panel=core\.performance$/.test(d.links.find(l => l[0] === 'Performance')?.[1]), d.links);

  // 4. Payload and Headers tabs of the POST.
  await click(row(`r.querySelector('.method').textContent === 'POST'`));
  await click(tab('Payload'));
  d = await detail();
  check('Payload tab shows the request body', /Request body/.test(d.body) && /name: "Foo"/.test(d.body), d.body);
  await click(tab('Headers'));
  const highlighted = await panel(`[...doc.querySelectorAll('tr.highlight td:first-child')].map(td => td.textContent.toLowerCase())`);
  check('Headers tab highlights X-Debug-Token*', highlighted.includes('x-debug-token') && highlighted.includes('x-debug-token-link'), highlighted);
  await click(tab('Response'));

  // 5. Filter, keyboard.
  const setFilter = v => panel(`(() => { const f = doc.getElementById('filter'); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new win.Event('input')); })()`);
  await setFilter('post 201');
  r = await rows();
  check('filter "post 201" keeps the POST only', r.length === 1 && r[0].method === 'POST', r);
  await setFilter('');
  const before = (await rows()).findIndex(x => x.selected);
  await panel(`doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  const after = (await rows()).findIndex(x => x.selected);
  check('ArrowDown selects the next row', after === before + 1, { before, after });

  // 6. A call made while the panel is open lands on top, selected.
  await content(`fetch('/api/orders?page=2'); return true;`);
  r = await settle(async () => { const v = await rows(); return v[0]?.path === '/api/orders?page=2' && v; }, 'live row') || await rows();
  check('live call added on top and selected', r[0]?.path === '/api/orders?page=2' && r[0].selected, r.slice(0, 2));

  // 7. Unchecking XHR/fetch only shows the image.
  await click(`doc.getElementById('xhrOnly')`);
  r = await rows();
  check('unchecking XHR/fetch only shows the image', r.some(x => x.path.startsWith('/img.png')), r.map(x => x.path));
  await click(`doc.getElementById('xhrOnly')`);

  // 8. Latest profiler opens the profiler in a tab.
  const tabsBefore = await chrome(`return gBrowser.tabs.length;`);
  await click(`doc.getElementById('latestProfiler')`);
  const opened = await settle(() => chrome(`return gBrowser.tabs.length > ${tabsBefore}
    && [...gBrowser.tabs].some(t => /\\/_profiler\\/tok\\d+$/.test(t.linkedBrowser.currentURI.spec));`), 'profiler tab');
  check('Latest profiler ↗ opens the profiler in a tab', opened, 'no /_profiler/ tab');
  // Back to the app tab, whose toolbox holds the panel.
  await chrome(`gBrowser.selectedTab = gBrowser.tabs[0];`);

  // 9. A profiler without a custom performance panel keeps Symfony's 'time' panel.
  await content(`fetch(${JSON.stringify(`${plain.base}/api/orders`)}); return true;`);
  await waitFor(async () => (await rows())[0]?.selected && (await detail()).url === `${plain.base}/api/orders`, 'second API row');
  await settle(() => plain.profilerHits.length > 0, 'second profiler lookup');
  await sleep(300);
  d = await detail();
  check('Performance falls back to time without a custom panel',
    new RegExp(`^${plain.base}/index\\.php/_profiler/tok\\d+\\?panel=time$`).test(d.links.find(l => l[0] === 'Performance')?.[1]),
    { links: d.links, hits: plain.profilerHits });

  // Screenshot of the browser window, DevTools included.
  await m.send('Marionette:SetContext', { value: 'chrome' });
  const { value: png } = await m.send('WebDriver:TakeScreenshot', {});
  writeFileSync(shot, Buffer.from(png, 'base64'));

  // 10. Navigation clears the list, unless Preserve log is checked.
  const navigate = async url => {
    await m.send('Marionette:SetContext', { value: 'content' });
    await m.send('WebDriver:Navigate', { url });
  };
  await navigate(`${APP}/?reload=1`);
  r = await settle(async () => { const v = await rows(); return v.length === 0 && v; }, 'empty list') || await rows();
  check('navigation clears the list', r.length === 0, r);
  await click(`doc.getElementById('preserve')`);
  await content(`fetch('/api/orders'); return true;`);
  await waitFor(async () => (await rows()).length === 1, 'preserved row');
  await navigate(`${APP}/?reload=2`);
  await sleep(500);
  r = await rows();
  check('Preserve log keeps calls across navigation', r.length === 1, r);
} catch (e) {
  check('test ran to the end', false, e.message);
} finally {
  await m.send('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
  m.close();
  proc.kill();
  server.close();
  plain.close();
  rmSync(profile, { recursive: true, force: true });
}

for (const c of results) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!c.ok) console.log(`      ${JSON.stringify(c.detail)}`);
}
const failed = results.filter(c => !c.ok).length;
console.log(`\ne2e firefox: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
