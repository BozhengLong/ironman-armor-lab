# Iron Man Armor Lab

浏览器里的 3D 装甲交互档案。正交相机 + 工程图式 HUD + 按语义组的爆炸拆解视图。

形态参照 [yadongxie.com/lab/tanks](https://www.yadongxie.com/lab/tanks)（红警坦克 3D 查看器），
主题换成钢铁侠装甲。这是一个研究 Web 作为空间表达介质的实验项目。

## 快速开始

```bash
npm install
python3 scripts/fetch_models.py     # 下载 3D 资源，需要 Sketchfab token
node scripts/compress_models.mjs    # 压缩：49MB -> 4.5MB（可选但推荐）
npm run dev                         # http://localhost:8732/
```

URL 参数：`?model=hulkbuster|ironman|samurai`、`?src=auto|raw|meshopt|draco`。

交互：拖拽旋转、滚轮缩放、**点击任一部件钻取该子装配体**、
**← → 逐件浏览组内零件**、ESC 逐级退出。
底部有视角预设、爆炸模式、爆炸进度滑块，以及 **ASSEMBLE 组装动画**
（按穿戴顺序逐组归位，收尾点亮反应堆）。

### Sketchfab token

3D 资源不在仓库里（见下），需要 token 才能拉取：

1. 登录 [sketchfab.com/settings/password](https://sketchfab.com/settings/password) 复制 API Token
2. `printf '%s' '<TOKEN>' > ~/.sketchfab_token && chmod 600 ~/.sketchfab_token`

## 3D 资源为什么不在仓库里

`assets/raw/` 里的文件不是源码，是 `scripts/fetch_models.py` 从 Sketchfab 拉取的
**下载缓存**。给缓存做版本控制在原理上就是错的，与体积无关（这两个模型共约 49 MB）。

仓库里提交的是 `assets/assets.lock.json` —— 逐文件的 sha256 与字节数，使重建可验证：

```bash
python3 scripts/fetch_models.py --verify   # 校验本地文件与锁文件一致
python3 scripts/fetch_models.py --relock   # 确认上游确实变了，重写锁文件
```

锁文件保证的是**完整性**（拿到的字节和当初一致），不保证**可用性** ——
上游模型可能被删除或改授权。所以另外做一份仓库外的私人备份。

## 目录结构

```
scripts/
  fetch_models.py      从 Sketchfab 下载 + 校验和锁定
  analyze_parts.py     glTF -> 部件分类 manifest（四层机制，见下）
  explode_plan.py      manifest -> 爆炸位移规划（五种模式 + 分离指标）
  build_index.py       汇总模型元数据 -> index.json，前端据此渲染清单
  backup_assets.py     仓库外备份，打包后解出来按锁文件验证还原
  compress_models.mjs  几何与贴图压缩 + 节点结构指纹校验
  test_classifier.py   分类器回归测试
  test_explode.py      爆炸规划回归测试（含姿态无关性）
  serve.mjs            本地静态服务器

web/index.html         Three.js 场景 + 正交相机 + HUD

assets/
  assets.lock.json     资源校验和锁文件（入库）
  manifests/           部件与爆炸规划（入库，需要可 diff）
  raw/                 下载缓存（不入库）
  dist/                压缩产物（不入库，可重建）

docs/
  explode-design.md    爆炸图与钻取交互设计记录，含失败路径
  pipeline.md          压缩管线与两层校验
  shots/               对比截图
```

## 两个核心处理步骤

### 部件分类（`analyze_parts.py`）

源模型的 mesh 没有语义命名（`Object001`…`Object081`）。按四层机制推断部位：

1. **稳健上方向判定** —— 用部件中心的 p5–p95 跨度，而非整体包围盒
   （地面碎石会把跨度撑歪）
2. **异常节点剔除** —— 地面/底座、跨满全身的连体内衬
3. **材质语义佐证** —— 仅在与位置判定相容时采纳；建模者复用材质很常见
4. **镜像对称配对** —— 指纹用三角面数（镜像不改变拓扑）

外加待复核队列与人工覆盖表（`*.overrides.json`）。

### 爆炸规划（`explode_plan.py`）

实测这些零件是深度嵌套互穿的壳层，**任何基于质心的位移场都无法分离它们**。
改为按语义组作刚体整块分离，组内展开留给钻取交互。
完整推导与失败路径见 [docs/explode-design.md](docs/explode-design.md)。

### 压缩（`compress_models.mjs`）

49 MB → 4.5 MB。因为 manifest 以 glTF node 索引为键，管线带**结构指纹校验**，
节点一旦被重排就拒绝产出。详见 [docs/pipeline.md](docs/pipeline.md)。

## 测试

```bash
npm test        # 两个回归测试套件
npm run plan    # 重算爆炸规划并打印分离指标
```

## 授权与免责

代码采用 MIT。

3D 模型来自 Sketchfab，均标注为 CC-BY 4.0。

**仓库不含模型文件，站点则会分发它们** —— 这两件事要分开说。`assets/raw/` 与
`assets/dist/` 都在 `.gitignore` 里，clone 下来只有获取脚本与校验和；但部署出去的
站点必须把压缩后的 GLB 公开给浏览器取用，任何人都能直接下载。既然构成分发，
CC-BY 的署名义务就成立，站点因此提供三处署名：

- HUD 右下角常驻的署名块（移动端退到底部控制栈末行），含作者、许可与原作链接
- 站点根的 `CREDITS.txt`，页面上「ALL CREDITS」的落点
- 每个产物目录下的 `ATTRIBUTION.txt`，让许可跟着被下载的 GLB 一起走

三处内容都由 `assets/manifests/index.json` 生成，署名字段缺失时
`build_site.mjs` 直接让构建失败。站点分发的是压缩过的版本，
按 CC BY 4.0 第 3(a)(1)(B) 条已声明「有改动」。

**注意：这些 CC-BY 标注未经独立核实。** 选型调研中发现，Sketchfab 上存在同一份
模型文件被多个账号分别上传、各自声明为自有作品的情况（可由三角面数完全相同判定）。
使用前请自行确认授权状况；若你是权利人并认为此处的展示或分发不当，提 issue 即下架。

本项目是非商业的粉丝向 WebGL 实验，用于研究 Web 上的交互式 3D 表达。
Iron Man 及相关角色的权利归各自权利人所有。本项目与 Marvel、Disney 无任何关联，
未获其认可或授权。

当前状态与未决事项见 [docs/STATE.md](docs/STATE.md)，变更日志见 [docs/HANDOFF.md](docs/HANDOFF.md)。

## Agent 工具层

这个项目最初的命题是「Agent 能把 Web 当作表达介质做到什么程度」。
场景的每种状态变化都是一个纯粹的原语，收成带 schema 的命令集后，
LLM 就能用自然语言意图驱动它，而不需要懂 Three.js。

页面自身不调用任何 LLM —— 它只暴露命令面与 schema，由外部决定调用序列。

```js
window.armorLab.schema()          // function-calling 格式的工具定义
window.armorLab.call('listGroups')
await window.armorLab.run([       // 「展示胸甲的内部结构」
  { tool: 'setExplodeMode', args: { mode: 'group' } },
  { tool: 'setView',        args: { name: '3/4F' } },
  { tool: 'setExplode',     args: { value: 0.45 } },
  { tool: 'focusGroup',     args: { key: 'chest/C' } },
  { tool: 'focusPart',      args: { index: 2 } },
])
```

共 10 个命令：`listModels` `loadModel` `listGroups` `setView` `setExplode`
`setExplodeMode` `focusGroup` `focusPart` `playAssemble` `getState`。

## 泛化检验

前两个模型上调出的所有参数，用第三个**完全没调过**的模型验证过一遍。
它暴露了一个级联失败（连体内衬判据只看跨度大小、不看跨在哪里），
也确认了材质提示的高度相容性检查确实拦住了误导性的材质名。
过程与数据见 [docs/explode-design.md](docs/explode-design.md)。
