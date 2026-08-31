#!/usr/bin/env node
/**
 * 站点运行时验收：在无头浏览器里加载构建产物，跑页面自带的那几个校验钩子。
 *
 * ## 为什么必须进 CI
 *
 * 页面里有五个 `__verify*` 钩子，但它们此前**只在有人记得手动跑的时候才存在**。
 * `__verifyScrim` 当初一上来就逮出两处衬底失覆盖 —— 可下次谁加个按钮，
 * 没有任何东西会自动发现。署名块尤其要紧：CC-BY 是持续义务，
 * 而保证它可见的检查不在任何自动流程里。
 *
 * 对一个反复栽在「检查悄悄没生效」上的项目来说，
 * 让检查本身依赖「我记得跑」，是同一个毛病的最后一处残留。
 *
 * ## 它同时验两件事
 *
 * 1. 各项校验通过
 * 2. **各项校验确实能失败** —— 每条都配对照组，故意破坏后必须报错。
 *    只验第 1 条的话，一个恒真的检查会永远显示绿色。
 *
 * 用法: node scripts/test_page.mjs          （需要先 node scripts/build_site.mjs）
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(SITE, 'index.html'))) {
  console.error('site/ 里没有 index.html —— 先跑 node scripts/build_site.mjs');
  process.exit(1);
}

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--root', SITE],
  { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

let browser = null;
try {
  // 起不来时要把 stderr 带出来。第一版只等 "ready"，端口被占用就只报「超时」，
  // 真正的 EADDRINUSE 全被吞掉了。
  await new Promise((res, rej) => {
    const t = setTimeout(
      () => rej(new Error(`服务器启动超时${serverErr ? '：\n' + serverErr.trim() : ''}`)), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); res(); } });
    server.on('exit', (code) => {
      clearTimeout(t);
      rej(new Error(`服务器退出（code ${code}）${serverErr ? '：\n' + serverErr.trim() : ''}`));
    });
  });

  browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    // favicon 的 404 与验收无关，站点本来就没放 favicon
    if (m.type() === 'error' && !/favicon/.test(m.text())) consoleErrors.push(m.text());
  });
  // 模块级语法错误走 pageerror，不进 console。只听 console 的话，页面白屏会表现为
  // 「等 __ready 超时」，看不出真正原因 —— 实测踩过：site/ 里带着一个注入的语法错误，
  // 表现只是干等 90 秒。
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).split('\n')[0]));
  // URL 回写是 400ms 防抖，而相机阻尼会持续发 change 事件不断把防抖顶掉 ——
  // 镜头没停稳之前 URL 根本不会写。所以取链接前必须等场景稳定，
  // 不能靠固定 sleep 猜（第一版就是这么错的：拿到的是还在补间中途的角度）。
  const readyOrDie = async (tag) => {
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 45000 });
    } catch {
      const why = pageErrors.length ? pageErrors.join(' | ')
        : await page.evaluate(() => window.__error
            ?? document.getElementById('loadStage')?.textContent ?? '未知');
      throw new Error(`${tag}: 页面没能就绪 —— ${why}`);
    }
  };

  const models = JSON.parse(
    fs.readFileSync(path.join(SITE, 'assets', 'manifests', 'index.json'), 'utf8')).models;

  // ---------- 每个模型 × 桌面/移动两种视口 ----------
  for (const m of models) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/?model=${m.slug}`);
      await readyOrDie(`${m.slug} ${w}x${h}`);
      await page.waitForTimeout(250);
      const tag = `${m.slug} ${w}x${h}`;
      const r = await page.evaluate(() => ({
        manifest: window.__verifyManifest().maxDeviationInHeights,
        credit: window.__verifyCredit(),
        hud: window.__verifyHud(),
        scrim: window.__verifyScrim(),
        repulsor: window.__verifyRepulsor(),
      }));
      ok(r.manifest < 1e-3, `${tag}: manifest 偏差 ${r.manifest}`);
      ok(r.credit.ok, `${tag}: 署名 ${JSON.stringify(r.credit.problems)}`);
      ok(r.hud.ok, `${tag}: HUD 重叠 ${JSON.stringify(r.hud.overlaps)}`);
      ok(r.scrim.ok, `${tag}: 衬底 ${JSON.stringify(r.scrim.problems)}`);
      ok(r.repulsor.ok, `${tag}: 发射口 ${JSON.stringify(r.repulsor.problems)}`);
    }
  }

  // ---------- 深链往返 ----------
  // 要断言的性质是「一条链接能还原出它自己写着的状态」。
  // 第一版是「等场景停稳 -> 拍快照 -> 重载 -> 两次快照相同」，那依赖动画收敛：
  // CI 用软件渲染 54 万面，帧率只有几帧，靠等收敛判稳必然超时（实测 20 秒不够，
  // 而且快照被采样在补间中途，除 az/el 外其余字段其实全对）。
  // 改成拿 URL 自身作为基准 —— 写链接那一刻相机是否还在动就无关紧要了。
  const FIELD = { az: 'az', el: 'el', z: 'zoom', ex: 'explode',
                  mode: 'mode', g: 'group', p: 'focus' };
  const NUM = new Set(['az', 'el', 'z', 'ex', 'p']);
  const expectedFromUrl = (u) => {
    const q = new URL(u).searchParams;
    const want = {};
    for (const [key, field] of Object.entries(FIELD)) {
      if (q.has(key)) want[field] = NUM.has(key) ? Number(q.get(key)) : q.get(key);
    }
    want.debris = q.get('debris') === '1';
    return want;
  };
  // 连续量（角度/缩放/爆炸进度）经 URL 取整往返，只能带容差；离散量必须相等。
  const compare = (want, got, tol = 0.5) => Object.entries(want).flatMap(([k, v]) => {
    const g = got[k];
    if (typeof v === 'number' && k !== 'focus') {
      return Math.abs(v - g) <= tol ? [] : [`${k}: 链接写 ${v}，还原成 ${g}`];
    }
    return v === g ? [] : [`${k}: 链接写 ${JSON.stringify(v)}，还原成 ${JSON.stringify(g)}`];
  });

  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${BASE}/?model=${models[0].slug}`);
  await readyOrDie('深链往返 去程');
  await page.evaluate(async () => {
    const s = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.armorLab.call('setView', { name: 'SIDE' });
    await window.armorLab.call('setExplodeMode', { mode: 'semantic' });
    await window.armorLab.call('setExplode', { value: 0.62 });
    await s(300);
    const g = (await window.armorLab.call('listGroups', {}))[0];
    await window.armorLab.call('focusGroup', { key: g.key ?? g });
  });

  // 等 URL 把状态写出来（回写是 400ms 节流，这里给足余量）
  let link = null;
  for (let i = 0; i < 60 && !link; i++) {
    await page.waitForTimeout(250);
    if (/[?&]ex=/.test(page.url()) && /[?&]g=/.test(page.url())) link = page.url();
  }
  ok(link, `URL 始终没有写出状态参数，当前是 ${page.url()}`);

  if (link) {
    const want = expectedFromUrl(link);
    await page.goto(link);
    await readyOrDie('深链往返 回程');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.__stateSnapshot());
    const diffs = compare(want, after);
    ok(diffs.length === 0, `深链往返不一致:\n    ${diffs.join('\n    ')}\n    链接 ${link}`);

    // 容差给宽了这个比较就变成恒真。改掉参数再进来，必须比出不同。
    const tampered = link.replace(/ex=[\d.]+/, 'ex=0.11').replace(/g=[^&]*/, 'g=__nope__');
    await page.goto(tampered);
    await readyOrDie('往返对照');
    await page.waitForTimeout(500);
    ok(compare(want, await page.evaluate(() => window.__stateSnapshot())).length > 0,
       '往返对照失效：改掉链接参数后仍判定为一致 —— 这个比较是恒真的');
  }


  // ---------- 对照组：每条校验都必须能失败 ----------
  // 这一段才是重点。只验「通过」的话，一个恒真的检查会永远显示绿色。
  await page.goto(`${BASE}/?model=${models[0].slug}`);
  await readyOrDie('对照组');
  await page.waitForTimeout(250);
  const ctrl = await page.evaluate(() => {
    const out = {};

    const credit = document.getElementById('credit');
    const snap = credit.innerHTML;
    document.getElementById('crLine1').textContent = '';
    document.getElementById('crLine2').textContent = '';
    out.credit = window.__verifyCredit().ok;
    credit.innerHTML = snap;

    const roster = document.getElementById('roster');
    const prev = { d: roster.style.display, t: roster.style.top };
    roster.style.display = 'block';
    roster.style.top = '12px';
    out.hud = window.__verifyHud().ok;
    roster.style.display = prev.d; roster.style.top = prev.t;

    const sb = document.getElementById('scrimB');
    const w = sb.style.width;
    sb.style.width = '120px';
    out.scrim = window.__verifyScrim().ok;
    sb.style.width = w;

    window.__scrambleRepulsor('flip');
    out.repulsor = window.__verifyRepulsor().ok;
    window.__scrambleRepulsor('restore');

    out.restored = window.__verifyCredit().ok && window.__verifyHud().ok
                && window.__verifyScrim().ok && window.__verifyRepulsor().ok;

    // manifest 的对照放最后：__scrambleMeta 会永久打乱绑定，之后这一页就废了
    window.__scrambleMeta(1);
    out.manifest = window.__verifyManifest().maxDeviationInHeights;
    return out;
  });
  ok(ctrl.credit === false, '对照失效：清空署名后 __verifyCredit 仍然通过');
  ok(ctrl.hud === false, '对照失效：制造重叠后 __verifyHud 仍然通过');
  ok(ctrl.scrim === false, '对照失效：缩窄衬底后 __verifyScrim 仍然通过');
  ok(ctrl.repulsor === false, '对照失效：掉转方向后 __verifyRepulsor 仍然通过');
  ok(ctrl.restored === true, '对照复原失败：破坏后没能恢复到全部通过');
  ok(ctrl.manifest > 1e-2, `对照失效：打乱绑定后 manifest 偏差仅 ${ctrl.manifest}`);

  ok(pageErrors.length === 0, `页面级错误:\n    ${pageErrors.slice(0, 3).join('\n    ')}`);
  ok(consoleErrors.length === 0, `控制台报错:\n    ${consoleErrors.slice(0, 5).join('\n    ')}`);
} finally {
  // browser 的创建必须在 try 之内：第一版放在外面，launch 一失败服务器就泄漏，
  // 下次运行直接撞 EADDRINUSE。
  if (browser) await browser.close();
  server.kill();
}

if (fails.length) {
  console.error(`FAIL  站点运行时验收 ${fails.length} 项`);
  for (const f of fails) console.error('  ' + f);
  process.exit(1);
}
console.log('PASS  站点运行时验收：各项校验通过，且每条都验证过能失败');
