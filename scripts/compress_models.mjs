#!/usr/bin/env node
/**
 * 压缩 assets/raw/<slug>/scene.gltf -> assets/dist/<slug>/model.<mode>.glb
 *
 * ## 为什么必须做结构指纹校验
 *
 * assets/manifests/*.json 与 *.overrides.json 都以 glTF 的 node 索引为键。
 * 压缩工具若重排、合并或删除节点，这些键会静默指向错误的零件 ——
 * 不会报错，只会让爆炸图和人工覆盖悄悄作用到别的地方。
 * 所以本脚本在写出后重新解析 GLB，逐项比对节点结构，不一致就拒绝产出。
 *
 * 因此也刻意不使用 flatten / join / instance 这类会改动节点图的变换。
 *
 * 用法:
 *   node scripts/compress_models.mjs                    # 全部模型，两种编码都做
 *   node scripts/compress_models.mjs --mode meshopt
 *   node scripts/compress_models.mjs ironman --mode draco
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, dedup, prune, reorder, draco, meshopt, textureCompress }
  from '@gltf-transform/functions';
import sharp from 'sharp';
import { MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'assets', 'raw');
const DIST = path.join(ROOT, 'assets', 'dist');

const args = process.argv.slice(2);
const modeArg = (() => {
  const i = args.indexOf('--mode');
  return i >= 0 ? args[i + 1] : 'both';
})();
const texSize = (() => {
  const i = args.indexOf('--tex');
  return i >= 0 ? Number(args[i + 1]) : 2048;
})();
const slugs = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--mode' && args[i - 1] !== '--tex');

const MB = (n) => (n / 1048576).toFixed(2) + ' MB';

/** 节点结构指纹：顺序敏感，覆盖名字、是否带网格、子节点数。 */
function fingerprint(json) {
  const nodes = json.nodes || [];
  return {
    count: nodes.length,
    rows: nodes.map((n, i) =>
      `${i}|${n.name ?? ''}|${n.mesh === undefined ? '-' : 'M'}|${(n.children || []).length}`),
  };
}

function readGlbJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  const total = buf.readUInt32LE(8);
  let off = 12;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    }
    off += 8 + len + ((-len % 4) + 4) % 4;
  }
  throw new Error('GLB 里没有 JSON chunk');
}

function compareFingerprints(a, b) {
  const diffs = [];
  if (a.count !== b.count) diffs.push(`节点数 ${a.count} -> ${b.count}`);
  const n = Math.min(a.rows.length, b.rows.length);
  for (let i = 0; i < n; i++) {
    if (a.rows[i] !== b.rows[i]) {
      diffs.push(`索引 ${i}: "${a.rows[i]}" -> "${b.rows[i]}"`);
      if (diffs.length >= 8) { diffs.push('...'); break; }
    }
  }
  return diffs;
}

async function makeIO() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await MeshoptEncoder.ready;
  io.registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });
  return io;
}

async function run(slug, mode, io) {
  const src = path.join(RAW, slug, 'scene.gltf');
  if (!fs.existsSync(src)) {
    console.error(`[skip] ${slug}: 找不到 ${path.relative(ROOT, src)}，先跑 fetch_models.py`);
    return null;
  }
  const srcJson = JSON.parse(fs.readFileSync(src, 'utf8'));
  const fpBefore = fingerprint(srcJson);

  // 源体积 = gltf + bin + 贴图
  const srcDir = path.join(RAW, slug);
  let srcBytes = 0;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (!e.name.startsWith('.') && !e.name.endsWith('.txt')) srcBytes += fs.statSync(p).size;
  });
  walk(srcDir);

  const doc = await io.read(src);

  // 只用不改动节点图的变换。刻意排除 flatten / join / instance。
  await doc.transform(
    weld(),                                  // 合并重复顶点
    reorder({ encoder: MeshoptEncoder }),    // 顶点缓存优化，只动图元内部顺序
    dedup(),                                 // 去重 accessor / 材质 / 贴图
    prune({ keepLeaves: true }),             // 清理未引用项，保留空叶节点以免动到节点图
    // 贴图：ironman 的 baseColor 是 4096² / 7.4MB，几何压缩碰不到它。
    // 降到 2048 转 WebP —— 模型在屏幕上不到 1000px，2048 已远超所需。
    textureCompress({
      encoder: sharp, targetFormat: 'webp',
      resize: [texSize, texSize], quality: 82,
    }),
    mode === 'draco'
      ? draco({ method: 'edgebreaker' })
      : meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );

  const outDir = path.join(DIST, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `model.${mode}.glb`);
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(outPath, glb);

  // 关键校验：重新解析产物，比对节点结构
  const fpAfter = fingerprint(readGlbJson(Buffer.from(glb)));
  const diffs = compareFingerprints(fpBefore, fpAfter);

  const outBytes = glb.byteLength;
  const pct = ((1 - outBytes / srcBytes) * 100).toFixed(1);
  console.log(`[${mode.padEnd(7)}] ${slug.padEnd(11)} ${MB(srcBytes).padStart(9)} -> ` +
              `${MB(outBytes).padStart(9)}  省 ${pct}%   节点 ${fpAfter.count}`);

  if (diffs.length) {
    console.error(`  [!!] 节点结构被改动，manifest 的 node 索引已失效：`);
    diffs.forEach((d) => console.error(`       ${d}`));
    fs.unlinkSync(outPath);
    console.error(`       已删除产物 ${path.relative(ROOT, outPath)}`);
    return { slug, mode, ok: false };
  }
  return { slug, mode, ok: true, srcBytes, outBytes, path: outPath };
}

const io = await makeIO();
const targets = slugs.length ? slugs
  : fs.readdirSync(RAW).filter((d) => fs.statSync(path.join(RAW, d)).isDirectory());
const modes = modeArg === 'both' ? ['meshopt', 'draco'] : [modeArg];

console.log(`模型: ${targets.join(', ')}   编码: ${modes.join(', ')}   贴图上限: ${texSize}px\n`);
const results = [];
for (const slug of targets) {
  for (const mode of modes) results.push(await run(slug, mode, io));
}

// 每个模型产出 index.json，列出可用编码与体积，供运行时挑最小的
const byslug = {};
for (const r of results) {
  if (r && r.ok) (byslug[r.slug] ||= {})[r.mode] = r.outBytes;
}
for (const [slug, modeMap] of Object.entries(byslug)) {
  const merged = { ...modeMap };
  const idx = path.join(DIST, slug, 'index.json');
  if (fs.existsSync(idx)) {              // 单独跑某一种编码时，保留其它已有条目
    try { Object.assign(merged, JSON.parse(fs.readFileSync(idx, 'utf8')), modeMap); }
    catch { /* 损坏就整体重写 */ }
  }
  // 去掉文件已不存在的条目
  for (const m of Object.keys(merged)) {
    if (!fs.existsSync(path.join(DIST, slug, `model.${m}.glb`))) delete merged[m];
  }
  fs.writeFileSync(idx, JSON.stringify(merged, null, 1) + '\n');
  const best = Object.entries(merged).sort((a, b) => a[1] - b[1])[0];
  console.log(`[index  ] ${slug.padEnd(11)} ${Object.keys(merged).join(', ')}` +
              `   运行时默认取 ${best[0]} (${MB(best[1])})`);
}

const bad = results.filter((r) => r && !r.ok);
if (bad.length) {
  console.error(`\n${bad.length} 项因节点结构变动被拒绝。`);
  console.error('若确认要接受新结构，需重新跑 analyze_parts.py 与 explode_plan.py，');
  console.error('并逐条核对 *.overrides.json 里的 node 索引。');
  process.exit(1);
}
console.log('\n全部产物的节点结构与源文件一致，manifest 的 node 索引依然有效。');
