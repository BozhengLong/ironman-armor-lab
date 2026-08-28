#!/usr/bin/env node
/**
 * 组装可静态托管的站点到 site/。
 *
 * 页面用相对路径（./assets/... 与 ./node_modules/three/...），
 * 因此同一份产物在本地根路径与 GitHub Pages 的 /<repo>/ 子路径下都能跑。
 *
 * three 的 addon 之间只通过 importmap 互相引用，所以按原有目录层级拷贝
 * 那几个文件即可，不需要打包器。整套依赖 9 个文件约 1.85 MB，
 * 其中 draco 解码器 1 MB 只在加载 draco 模型时才会被浏览器拉取。
 *
 * 用法: node scripts/build_site.mjs [--out site]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OUT = path.join(ROOT, args[args.indexOf('--out') + 1] || 'site');

// 页面直接 import 的入口。其余依赖由下面的导入图解析自动带出 ——
// 手写清单会随 three 升级失效（实测漏过 build/three.core.js，
// 那是 three 把核心拆分后由 three.module.js 再导出的）。
const THREE_ENTRIES = [
  'build/three.module.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/loaders/DRACOLoader.js',
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/libs/meshopt_decoder.module.js',
];

// 运行时按 URL 取、不走 ES import 的资源，必须显式列出。
// DRACOLoader 通过 setDecoderPath 拉这几个文件。
const THREE_RUNTIME_ASSETS = [
  'examples/jsm/libs/draco/draco_decoder.js',
  'examples/jsm/libs/draco/draco_decoder.wasm',
  'examples/jsm/libs/draco/draco_wasm_wrapper.js',
];

const THREE_ROOT = path.join(ROOT, 'node_modules', 'three');

/** 提取一个 JS 文件里的所有模块 specifier。 */
function specifiersOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  // import ... from 'x' / export ... from 'x' / import 'x' / import('x')
  const re = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1] || m[2]);
  return [...out];
}

/** 把 specifier 解析成 three 包内的相对路径；包外或裸包名返回 null。 */
function resolveSpecifier(spec, fromRel) {
  if (spec === 'three') return 'build/three.module.js';
  if (spec.startsWith('three/addons/')) return 'examples/jsm/' + spec.slice('three/addons/'.length);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return path.normalize(path.join(path.dirname(fromRel), spec)).split(path.sep).join('/');
  }
  return null;   // 其它裸包名：three 的 addon 里不该出现，出现则忽略
}

/** 从入口出发做广度优先，返回所有可达的包内相对路径。 */
function collectThreeGraph() {
  const seen = new Set();
  const queue = [...THREE_ENTRIES];
  const missing = [];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(THREE_ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    seen.add(rel);
    for (const spec of specifiersOf(abs)) {
      const next = resolveSpecifier(spec, rel);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return { files: [...seen], missing };
}

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
};

const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const KB = (n) => (n / 1024).toFixed(1) + ' KB';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const tally = {};
const add = (k, n) => { tally[k] = (tally[k] || 0) + n; };

// 页面
add('页面', copy(path.join(ROOT, 'web', 'index.html'), path.join(OUT, 'index.html')));

// three 依赖：导入图 + 运行时按 URL 取的资源
const graph = collectThreeGraph();
if (graph.missing.length) {
  console.error('导入图里有文件不存在，先跑 npm ci：');
  graph.missing.forEach((f) => console.error(`  node_modules/three/${f}`));
  process.exit(1);
}
const threeFiles = [...new Set([...graph.files, ...THREE_RUNTIME_ASSETS])];
for (const f of threeFiles) {
  const src = path.join(THREE_ROOT, f);
  if (!fs.existsSync(src)) {
    console.error(`缺少运行时资源: node_modules/three/${f}`);
    process.exit(1);
  }
  add('three', copy(src, path.join(OUT, 'node_modules', 'three', f)));
}

// manifest：只要运行时用得到的，overrides 是 Python 侧的输入
const manDir = path.join(ROOT, 'assets', 'manifests');
let manCount = 0;
for (const f of fs.readdirSync(manDir)) {
  if (!f.endsWith('.json') || f.endsWith('.overrides.json')) continue;
  add('manifest', copy(path.join(manDir, f), path.join(OUT, 'assets', 'manifests', f)));
  manCount++;
}

// 压缩后的模型
const distDir = path.join(ROOT, 'assets', 'dist');
const models = [];
if (fs.existsSync(distDir)) {
  for (const slug of fs.readdirSync(distDir)) {
    const d = path.join(distDir, slug);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      add('模型', copy(path.join(d, f), path.join(OUT, 'assets', 'dist', slug, f)));
    }
    models.push(slug);
  }
}

// Pages 默认跑 Jekyll，会忽略下划线开头的文件；.nojekyll 关掉它
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

if (!models.length) {
  console.error('assets/dist 为空 —— 先跑 node scripts/compress_models.mjs');
  process.exit(1);
}

const total = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`站点 -> ${path.relative(ROOT, OUT)}/`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(9)} ${KB(v).padStart(10)}`);
console.log(`  ${'合计'.padEnd(9)} ${MB(total).padStart(10)}`);
console.log(`  模型 ${models.join(', ')}   manifest ${manCount} 个`);
console.log(`  three 文件 ${threeFiles.length} 个（导入图解析 ${graph.files.length} + 运行时资源 ${THREE_RUNTIME_ASSETS.length}）`);

// 首屏实际下载量：页面 + three 核心 + 一个模型 + 其 manifest
const first = (() => {
  const slug = models[0];
  const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'assets', 'dist', slug, 'index.json'), 'utf8'));
  const best = Object.entries(idx).sort((a, b) => a[1] - b[1])[0];
  // 首屏会拉整个导入图（模块图是同步解析的），但不含 draco 解码器
  const core = graph.files
    .reduce((a, f) => a + fs.statSync(path.join(OUT, 'node_modules', 'three', f)).size, 0);
  const dracoNeeded = best[0] === 'draco'
    ? ['draco_decoder.js', 'draco_wasm_wrapper.js', 'draco_decoder.wasm']
        .reduce((a, f) => a + fs.statSync(
          path.join(OUT, 'node_modules', 'three', 'examples/jsm/libs/draco', f)).size, 0)
    : 0;
  const man = fs.readdirSync(path.join(OUT, 'assets', 'manifests'))
    .filter((f) => f.startsWith(slug))
    .reduce((a, f) => a + fs.statSync(path.join(OUT, 'assets', 'manifests', f)).size, 0);
  return { slug, mode: best[0], bytes: core + dracoNeeded + best[1] + man
    + fs.statSync(path.join(OUT, 'index.html')).size };
})();
console.log(`\n首屏下载量（${first.slug} / ${first.mode}）: ${MB(first.bytes)}`);
