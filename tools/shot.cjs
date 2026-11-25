// node shot.cjs <url> <outPrefix> [script-json-steps]
const puppeteer = require('D:/wangye/node_modules/puppeteer-core');
(async () => {
  const [url, out, stepsArg] = process.argv.slice(2);
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new',
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--no-proxy-server'], defaultViewport: { width: 1600, height: 900 } });
  const p = await b.newPage();
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') console.log('CONSOLE[' + m.type() + ']', m.text().slice(0, 600)); });
  p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 600)));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 1000)); if (await p.evaluate(() => window.__cz?.ready)) break; }
  await new Promise(r => setTimeout(r, 6000));
  const steps = stepsArg ? JSON.parse(stepsArg) : [{ name: 'intro' }];
  for (const s of steps) {
    if (s.js) await p.evaluate(s.js);
    await new Promise(r => setTimeout(r, s.wait || 3500));
    await p.screenshot({ path: out + '_' + s.name + '.png' });
    console.log('shot', s.name, await p.evaluate(() => document.querySelector('#coords').textContent));
  }
  await b.close();
})();
