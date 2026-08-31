#!/usr/bin/env node
/**
 * 页面静态检查：语法 + DOM id 引用。
 *
 * 为什么需要：CI 此前从头到尾没有任何一步解析过 web/index.html 里的 JS。
 * 实测过一次 —— 往 applyTransforms 注入一个必然白屏的语法错误，
 * `npm test` 与 `build_site.mjs` 双双退出码 0，CI 全绿，然后把白屏发布出去。
 * 本会话里已经踩过两次同类错误（暂时性死区、函数头被重复插入），
 * 两次都只是因为恰好手动打开了页面才发现。
 *
 * 这一步一秒钟、零依赖，专治白屏。更深的运行时校验在 test_page.mjs。
 *
 * 用法: node scripts/check_page.mjs [页面路径]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = process.argv[2] || path.join(ROOT, 'web', 'index.html');
const html = fs.readFileSync(page, 'utf8');
const fails = [];

// ---------- 1) 模块脚本的语法 ----------
const modules = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(([, attrs]) => /type\s*=\s*["']module["']/.test(attrs))
  .map(([, , body]) => body);

if (!modules.length) fails.push('页面里找不到 <script type="module"> —— 检查本身可能失效了');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'armorlab-'));
modules.forEach((src, i) => {
  const f = path.join(tmp, `mod${i}.mjs`);
  fs.writeFileSync(f, src);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n');
    fails.push(`模块脚本 #${i} 语法错误：\n${msg}`);
  }
});
fs.rmSync(tmp, { recursive: true, force: true });

// ---------- 2) JS 引用的 DOM id 必须在 HTML 里存在 ----------
// 每次改 DOM 都手动核对过这个差集，收进来自动跑。
const defined = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const js = modules.join('\n');
const referenced = new Set([
  ...[...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
]);
const missing = [...referenced].filter((id) => !defined.has(id)).sort();
if (missing.length) fails.push(`JS 引用了 HTML 里不存在的 id: ${missing.join(', ')}`);

// ---------- 3) 社交预览的占位符 ----------
// build_site.mjs 靠它注入绝对地址；不在这里也检一次的话，
// 占位符被误删只会在构建时才炸，而构建离改动已经很远了。
if (!html.includes('__SITE_URL__')) {
  fails.push('页面里找不到 __SITE_URL__ 占位符 —— build_site.mjs 会拒绝出站点');
}

if (fails.length) {
  console.error('FAIL  页面静态检查');
  for (const f of fails) console.error('  ' + f);
  process.exit(1);
}
console.log(`PASS  页面静态检查：${modules.length} 段模块脚本语法正确，`
  + `${referenced.size} 个 id 引用全部有定义`);
