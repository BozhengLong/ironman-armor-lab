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

// 页面。og:image 要求绝对 URL，而绝对地址是部署信息，不写死在 web/index.html 里，
// 在这里替换。占位符找不到就让构建失败 —— 否则社交预览会静默变成死链，
// 而「分享出去没有预览图」恰恰是没人会主动去测的那类问题。
const SITE_URL = process.env.SITE_URL || 'https://bozheng-long.org/ironman-armor-lab';
{
  const src = path.join(ROOT, 'web', 'index.html');
  let html = fs.readFileSync(src, 'utf8');
  if (!html.includes('__SITE_URL__')) {
    console.error('web/index.html 里找不到 __SITE_URL__ 占位符 —— 社交预览的绝对地址无法注入。');
    console.error('若确实要去掉社交预览，请同时删掉 build_site.mjs 里这段替换逻辑。');
    process.exit(1);
  }
  html = html.replaceAll('__SITE_URL__', SITE_URL.replace(/\/$/, ''));
  const dst = path.join(OUT, 'index.html');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, html, 'utf8');
  add('页面', fs.statSync(dst).size);
}

// 社交预览图
{
  const src = path.join(ROOT, 'assets', 'social-preview.jpg');
  if (!fs.existsSync(src)) {
    console.error('缺少 assets/social-preview.jpg —— og:image 会指向 404。');
    process.exit(1);
  }
  add('预览图', copy(src, path.join(OUT, 'social-preview.jpg')));
}

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

// 署名守卫：站点公开分发这些 GLB，CC-BY 要求随作品给出作者、许可与原始链接。
// 缺字段时必须让构建失败 —— 否则页面上的署名会静默变成空白，
// 而「站点看起来正常」恰恰是最难发现的违约方式。
const CREDIT_FIELDS = ['title', 'author', 'authorUrl', 'license', 'licenseUrl', 'source'];
const indexPath = path.join(ROOT, 'assets', 'manifests', 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error('缺少 assets/manifests/index.json —— 先跑 python3 scripts/build_index.py');
  process.exit(1);
}
const INDEX = JSON.parse(fs.readFileSync(indexPath, 'utf8')).models || [];
{
  const bad = INDEX
    .map((m) => [m.slug, CREDIT_FIELDS.filter((k) => !m[k])])
    .filter(([, missing]) => missing.length);
  if (bad.length) {
    console.error('署名字段缺失，拒绝出站点：');
    for (const [slug, missing] of bad) console.error(`  ${slug}: 缺 ${missing.join(', ')}`);
    console.error('修 scripts/fetch_models.py 的 MODELS，再跑 python3 scripts/build_index.py');
    process.exit(1);
  }
}

// 清单缩略图
const prevDir = path.join(ROOT, 'assets', 'previews');
if (fs.existsSync(prevDir)) {
  for (const f of fs.readdirSync(prevDir)) {
    if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) continue;
    add('缩略图', copy(path.join(prevDir, f), path.join(OUT, 'assets', 'previews', f)));
  }
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

// 随产物分发的署名。两份，服务两种到达方式：
//   assets/dist/<slug>/ATTRIBUTION.txt —— 有人直接下走 GLB 时，许可跟着文件走
//   CREDITS.txt                        —— 页面上「ALL CREDITS」链接的落点
// 内容一律由 index.json 驱动，不在这里写死任何作者信息。
const MODIFICATION = 'Draco / meshopt 几何压缩，贴图降采样与重编码；'
  + '网格拓扑与节点结构未改变。';
const REPO = 'https://github.com/BozhengLong/ironman-armor-lab';

const perModel = (m) => [
  `${m.title}`,
  `by ${m.author}  ${m.authorUrl}`,
  `Source: ${m.source}`,
  `License: ${m.license}  ${m.licenseUrl}`,
  ``,
  `本文件是经本站改动后的版本。Modified by ARMOR LAB:`,
  `  ${MODIFICATION}`,
  `  ${REPO}`,
  ``,
  `注意：该资源的 CC-BY 标注由上传者自行声明，来源未经独立核实。`,
  `Note: this CC-BY designation is self-declared by the uploader and has not`,
  `been independently verified.`,
  ``,
].join('\n');

for (const m of INDEX) {
  const dir = path.join(OUT, 'assets', 'dist', m.slug);
  if (!fs.existsSync(dir)) continue;      // 该模型这次没压缩，跳过
  const f = path.join(dir, 'ATTRIBUTION.txt');
  fs.writeFileSync(f, perModel(m), 'utf8');
  add('署名', fs.statSync(f).size);
}

const creditsText = [
  'ARMOR LAB — 模型署名 / MODEL CREDITS',
  REPO,
  '',
  '本站展示并分发以下 3D 模型，它们均由各自作者以 CC-BY 4.0 授权发布。',
  '本站分发的是改动过的版本：' + MODIFICATION,
  '按 CC BY 4.0 第 3(a)(1)(B) 条，在此声明作品已被改动。',
  '',
  'The models below are licensed CC BY 4.0 by their respective authors.',
  'This site distributes MODIFIED copies: geometry is Draco/meshopt-compressed',
  'and textures are downscaled and re-encoded. Mesh topology and node structure',
  'are unchanged.',
  '',
  '='.repeat(72),
  '',
  ...INDEX.flatMap((m, i) => [
    `[${i + 1}] ${m.title}`,
    `    作者 / Author   : ${m.author}`,
    `                      ${m.authorUrl}`,
    `    原作 / Source   : ${m.source}`,
    `    许可 / License  : ${m.license}`,
    `                      ${m.licenseUrl}`,
    `    改动 / Modified : ${MODIFICATION}`,
    `    本站展示名      : ${m.name}${m.subtitle ? ' · ' + m.subtitle : ''}`,
    '',
  ]),
  '='.repeat(72),
  '',
  '免责 / Disclaimer',
  '',
  '上述 CC-BY 标注由各上传者在 Sketchfab 上自行声明，本站未独立核实其权利来源。',
  '调研中发现 Sketchfab 上存在同一份模型文件被多个账号分别上传、',
  '各自声明为自有作品的情况。若您是权利人并认为此处的展示或分发不当，',
  `请在 ${REPO}/issues 提出，本站会立即下架。`,
  '',
  'These CC-BY designations are self-declared by the uploaders and have not been',
  'independently verified. If you are a rights holder and consider this display or',
  'distribution improper, please open an issue and it will be taken down.',
  '',
  '本项目是非商业的粉丝向 WebGL 实验。Iron Man 及相关角色的权利归各自权利人所有；',
  '本项目与 Marvel、Disney 无任何关联，未获其认可或授权。',
  '',
  '（本文件由 scripts/build_site.mjs 从 assets/manifests/index.json 生成）',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'CREDITS.txt'), creditsText, 'utf8');
add('署名', fs.statSync(path.join(OUT, 'CREDITS.txt')).size);

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
