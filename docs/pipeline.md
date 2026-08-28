# 资源压缩管线

2026-08-28

## 结果

| | 源 | meshopt | draco |
|---|---|---|---|
| hulkbuster | 30.94 MB | 3.47 MB (−88.8%) | **1.99 MB (−93.6%)** |
| ironman | 18.02 MB | **2.47 MB (−86.3%)** | 4.51 MB (−74.9%) |

两个模型合计 **49 MB → 4.5 MB**。本地加载 127–149ms → 56–66ms。

哪种编码更优取决于模型，实测不一致：hulkbuster 上 draco 明显更好，ironman 上
meshopt 更好。运行时按 `?src=` 选择，默认优先 meshopt。

## 最大的杠杆是贴图，不是几何

只压几何时 ironman 只降到 9.43 MB —— 因为它 18 MB 里有 8.1 MB 是贴图，
其中 baseColor 是 4096²/7.42 MB。降到 2048² 转 WebP 后才有质变。

模型在屏幕上占不到 1000px，2048 已远超所需。

## 必须做结构指纹校验

`assets/manifests/*.json` 与 `*.overrides.json` 都**以 glTF 的 node 索引为键**。
压缩工具若重排、合并或删除节点，这些键会静默指向错误的零件 ——
不报错，只是让爆炸方向和人工覆盖悄悄作用到别的地方。

所以 `compress_models.mjs` 在写出后重新解析 GLB 的 JSON chunk，逐项比对
`索引|名字|是否带网格|子节点数`，不一致就删除产物并以非零码退出。

因此也刻意**不使用** `flatten` / `join` / `instance` —— 这些会改动节点图。
实际使用的变换：`weld` → `reorder` → `dedup` → `prune({keepLeaves:true})`
→ `textureCompress` → `meshopt|draco`。

## 运行时二次校验

结构指纹只能证明节点没被重排，不能证明运行时按索引取到的确实是那个零件。
`window.__verifyManifest()` 进一步比对每个零件的实际世界包围盒中心与
manifest 记录值（换算到同一坐标系后）：

| | 爆炸 40% | 钻取中 | 对照：绑定错位一格 |
|---|---|---|---|
| ironman raw / meshopt | 0.000003 | 0.000003 | 1.163 |
| hulkbuster raw / draco | 0 / 0.000002 | 同上 | 1.148 |

单位为模型身高。压缩后的 2×10⁻⁶ 正是量化误差（raw 恰好为 0），
而错位对照相差 5 到 6 个数量级 —— 证明该校验不是空测试。

写这个钩子时踩过一次坑：期望位移一度用了 `p.vecLocal`（已变换到父节点局部
空间），而 `meta.center` 在 glTF 场景空间，两者混用。爆炸为 0 时两边都是零
向量所以看不出来。必须用 plan 里的原始向量。

## 用法

```bash
node scripts/compress_models.mjs                      # 全部模型，两种编码
node scripts/compress_models.mjs ironman --mode meshopt
node scripts/compress_models.mjs --tex 1024           # 贴图上限改 1024
```

产物在 `assets/dist/`，同样不入库（可由源资源重建）。

## 关于部署

若部署到 GitHub Pages，注意 Pages 不解析 Git LFS 指针 —— 本项目未用 LFS，
资源需在 CI 构建时由 `fetch_models.py` + `compress_models.mjs` 生成后发布。
