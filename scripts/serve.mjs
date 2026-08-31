// 最小静态服务器：只为本地开发，不做生产用途。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8732);

// 默认服务仓库根（`/` 映射到 web/index.html，边改边看）。
// `--root site` 则直接服务构建产物，供 test_page.mjs 按线上目录结构验收。
const ai = process.argv.indexOf('--root');
const CUSTOM = ai >= 0;
const ROOT = CUSTOM ? path.resolve(process.argv[ai + 1]) : REPO;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = url === '/' ? (CUSTOM ? '/index.html' : '/web/index.html') : url;
  const file = path.join(ROOT, rel);

  // 防目录穿越
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  // 仓库根找不到时退到 site/：CREDITS.txt 这类只在构建时生成的根文件，
  // 线上位于站点根、开发时不在仓库根，不退这一步本地链接就是死的。
  const send = (f) => fs.stat(f, (err, st) => {
    if (err || !st.isFile()) {
      const built = path.join(ROOT, 'site', rel);
      if (!CUSTOM && f !== built && built.startsWith(path.join(ROOT, 'site') + path.sep)
          && fs.existsSync(built)) return send(built);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(f).pipe(res);
  });
  send(file);
}).listen(PORT, () => console.log(`ready http://localhost:${PORT}/  root=${ROOT}`));
