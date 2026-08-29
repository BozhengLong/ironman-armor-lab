# 项目状态与未决事项

最后更新：2026-08-29

站点：https://bozheng-long.org/ironman-armor-lab/
仓库：https://github.com/BozhengLong/ironman-armor-lab （public）

## 已具备的能力

正交六视角 · 四种爆炸模式 · 语义组刚体拆解 · 子装配体钻取 · 组内逐件浏览 ·
ASSEMBLE 穿戴动画与发光收尾 · 模型清单 · Agent 工具层 · 资源压缩管线 ·
CI 构建部署 · 移动端布局。

三个模型：hulkbuster（147 件 / 24 组）、ironman（61 / 19）、samurai（22 / 10）。

## 三层校验（改动管线时不要绕过）

1. **锁文件** `assets/assets.lock.json` —— 资源字节完整性。`fetch_models.py --verify`
2. **结构指纹** —— 压缩后重新解析 GLB 比对节点结构。manifest 以 glTF node 索引为键，
   节点被重排会静默错位，所以 `compress_models.mjs` 不一致就拒绝产出
3. **运行时绑定** `window.__verifyManifest()` —— 比对每个零件的实际世界包围盒中心
   与 manifest 记录值。`window.__scrambleMeta(1)` 是它的对照组，用来证明该校验非空

CI 另有一层：重算 manifest 并检查与入库版本逐字节一致。

## 未决事项

### 1. CC-BY 署名在站点上未真正满足（义务，优先）

三个模型均为 `CC Attribution`，而站点公开分发这些 GLB
（`assets/dist/*/model.draco.glb` 任何人可直接下载）。
目前署名只在清单项的 `title` 属性里 —— 鼠标悬停 tooltip，移动端看不到。

需要：页面上可见的署名区（作者 / 许可 / 原始链接），以及产物旁的许可文件。
这是站点公开之后才成立的问题。

### 2. 资源备份

`assets/raw/` 不入库，靠 `fetch_models.py` 重新下载。
锁文件保证完整性，不保证可用性 —— 三个模型来源均不明
（同一份文件被多个账号各自声明为自有作品），下架风险不低。

`python3 scripts/backup_assets.py --out <目录>` 会打包并**解出来验证还原**。
备份位置：`~/Backups/ironman-armor-lab/`（同盘，只挡下架不挡硬盘故障）。
**仍需另存一份到不同介质。**

新增模型后备份即过期，`--list` 会显示指纹校验结果。

### 3. Sketchfab token 轮换

token 同时存在于 `~/.sketchfab_token`、GitHub Actions secret `SKETCHFAB_TOKEN`，
以及创建它的那次对话记录里。建议在 https://sketchfab.com/settings/password 重新生成，
然后同步更新这两处。

### 4. REPULSOR 动作（未做）

需要充能曲线、闪光、后坐、点光源加 bloom。`hand/L` 组已有 1 个 `light` 材质的
发光件，位置是现成的。属于动画编排工作，值得单独一轮。

### 5. 朝前判定的第四条启发

samurai 上三条启发全部落空（无 face 材质、无 neck 组、无 foot 组），
退到默认 `+z` —— 实测恰好正确，属于走运。
`explode_plan.py --front +z|-z` 可手动指定，且输出会写明「无法判定」。

### 6. 世界观文案与第三个模型不符

HUD 文案（`ARMOR ARCHIVE` / `SUBASSEMBLY`）是按钢铁侠装甲档案写的，
samurai 是机甲。要么收敛成中性表述，要么按模型分主题。

## 反复出现的教训：失败必须有声

本项目至少四次栽在「检查悄悄没生效，却显示通过」上：

1. LFS 对空文件的状态误报 —— 权威清单要看 `git lfs ls-files`
2. `__verifyManifest` 在 explode=0 时恒为 0 —— 两边都是零向量，看不出空间错配
3. `gh api` 路径里的 `?` 被 zsh 当通配符吃掉 —— 结果每项 grep 都返回「未上传 ✓」
4. `str.replace` 前缀匹配 —— 锚点只匹配半行，行尾被甩到别处，两次

**规则：当「通过」是默认输出时，先证明这个检查能失败。**
本项目的做法是给每个校验配一个对照组（`__scrambleMeta`、radial 漂移对照、
篡改字节测试），并在所有补丁脚本里对锚点做存在性与唯一性断言。

## 常用命令

```bash
npm run dev                                    # 本地站点
npm test                                       # 两套回归测试
npm run plan                                   # 重算爆炸规划并打印指标
python3 scripts/fetch_models.py --verify       # 校验本地资源
python3 scripts/backup_assets.py --out DIR     # 仓库外备份（含还原验证）
node scripts/compress_models.mjs               # 压缩（含结构指纹校验）
node scripts/build_site.mjs                    # 组装静态站点
gh workflow run pages.yml -f deploy=true       # 手动发布（push 只构建不发布）
```
