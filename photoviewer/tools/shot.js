/**
 * CDP 截图 / 页面驱动工具
 * =====================
 * 需要先启动带远程调试的浏览器：
 *   msedge --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\pv-cdp about:blank
 *
 * 用法：
 *   node shot.js out.png --w=1600 --h=1000 --url=http://127.0.0.1:7788/ \
 *        --wait=1500 --eval="document.querySelector('.cell').click()" --wait=1200
 */
'use strict';

const fs = require('fs');
const http = require('http');

const argv = process.argv.slice(2);
const out = argv.find((a) => !a.startsWith('--')) || 'shot.png';
const opt = (name, dflt) => {
  const hit = argv.filter((a) => a.startsWith(`--${name}=`)).pop();
  return hit ? hit.slice(name.length + 3) : dflt;
};
const all = (name) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const PORT = Number(opt('port', 9333));
const WIDTH = Number(opt('w', 1600));
const HEIGHT = Number(opt('h', 1000));
const URL_ = opt('url', 'http://127.0.0.1:7788/');
const TIMEOUT = Number(opt('timeout', 60000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJSON(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const hs = this.events.get(msg.method) || [];
        hs.forEach((h) => h(msg.params));
      }
    });
  }
  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }
}

async function main() {
  // 复用现有 target
  let list = await httpJSON('/json/list');
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    target = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(JSON.parse(b)));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  if (!argv.includes('--cache')) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.navigate', { url: URL_ });
  await Promise.race([loaded, sleep(15000)]);

  // 等 App 就绪（#app 可见）
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 20000) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `!document.querySelector('#app').hidden && document.querySelectorAll('.cell').length > 0`,
      returnByValue: true,
    });
    if (r.result.value) {
      ready = true;
      break;
    }
    await sleep(200);
  }
  console.error(ready ? 'app ready' : 'app not ready (继续截图)');

  // 依次执行 --evalfile / --eval / --wait
  const steps = [];
  for (const a of argv) {
    if (a.startsWith('--evalfile=')) steps.push({ type: 'eval', v: fs.readFileSync(a.slice(11), 'utf8') });
    else if (a.startsWith('--eval=')) steps.push({ type: 'eval', v: a.slice(7) });
    else if (a.startsWith('--js=')) steps.push({ type: 'eval', v: a.slice(5) });
    else if (a.startsWith('--wait=')) steps.push({ type: 'wait', v: Number(a.slice(7)) });
  }
  for (const s of steps) {
    if (s.type === 'wait') {
      await sleep(s.v);
    } else {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: s.v,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          console.error('eval error:', d.text, '|', d.exception?.description || JSON.stringify(d.exception || {}));
        } else if (r.result && r.result.value !== undefined) console.error('eval →', JSON.stringify(r.result.value));
      } catch (e) {
        console.error('eval failed:', e.message);
      }
    }
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.error('saved', out, fs.statSync(out).size, 'bytes');

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
