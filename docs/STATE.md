# 你在这里

最后更新：2026-08-29

站点：https://bozheng-long.org/ironman-armor-lab/
仓库：https://github.com/BozhengLong/ironman-armor-lab （public）

## 当前任务与中断点

上一批（R7）已完成并上线：第三个模型的泛化检验、模型清单、Agent 工具层、
移动端与载入态。工作区干净，与远端一致，CI 与站点均正常。

**中断点：无进行中的工作。** 下一步由未决事项决定。

## 下一步（按优先级）

1. **补上 CC-BY 的可见署名** —— 唯一处于持续违约状态的项，见下。
2. REPULSOR 动作（唯一明确列出但未做的功能）。
3. 其余为可选。

## 未决事项

### 1. CC-BY 署名在站点上未真正满足（义务）

三个模型均为 `CC Attribution`，而站点公开分发这些 GLB
（`assets/dist/*/model.draco.glb` 任何人可直接下载）。
目前署名只在清单项的 `title` 属性里 —— 鼠标悬停 tooltip，移动端看不到。

需要：页面上可见的署名区（作者 / 许可 / 原始链接），以及产物旁的许可文件。
这是站点公开之后才成立的问题。

### 2. 资源备份仍是单点

`assets/raw/` 不入库。锁文件保证完整性，不保证可用性 —— 三个模型来源均不明，
下架风险不低。已有归档：

```
~/Backups/ironman-armor-lab/ironman-armor-lab-assets-2026-08-29.tar.gz  145.2 MB  ✓
```

覆盖全部三个模型、48 个文件，已验证可还原。**但与工作副本同盘**，
只挡上游下架、不挡硬盘故障。仍需另存一份到不同介质。
新增模型后备份即过期。

### 3. Sketchfab token 未轮换

token 同时存在于 `~/.sketchfab_token` 与 GitHub Actions secret `SKETCHFAB_TOKEN`，
且留在创建它的那次对话记录里。轮换后需同步更新这两处。

### 4. REPULSOR 动作（未做）

需要充能曲线、闪光、后坐、点光源加 bloom。`hand/L` 组已有 1 个 `light` 材质的
发光件，位置是现成的。属于动画编排工作。

### 5. 朝前判定的第四条启发

samurai 上三条启发（face 材质 / helmet-vs-neck / foot-vs-shin）全部落空，
退到默认 `+z` —— 实测恰好正确，属于走运。
`explode_plan.py --front +z|-z` 可手动指定，输出会写明「无法判定」而非假装成功。

### 6. 世界观文案与第三个模型不符

HUD 文案（`ARMOR ARCHIVE` / `SUBASSEMBLY`）按钢铁侠装甲档案写，samurai 是机甲。
要么收敛成中性表述，要么按模型分主题。

## 已评估并否决（不要重复评估）

| 方案 | 否决理由 |
|---|---|
| Git LFS 管理资源 | `assets/raw/` 是下载缓存不是源码，给缓存做版本控制在原理上就错；LFS 也不解决来源问题。改为提交校验和锁文件。`.gitattributes` 留有注释掉的规则与 Pages 不解析指针的告诫 |
| Cloudflare Pages / R2 | 仓库可见性保护不了模型 —— 部署到任何公开站点后 GLB 都可下载。既然如此，GitHub Pages 是最简路径。Cloudflare Access 是唯一能真正不公开资源的方案，若将来改变主意再评估 |
| 按连通分量拆分零件 | 任何阈值下都产出 582–1295 个零件，反而更读不出信息。数据见 `explode-design.md` |
| 用 Blender 重拆模型 | 源 mesh 并未焊死，拆分是纯程序操作，不需要 Blender（此前判断有误，已更正） |
| 径向/膨胀类爆炸场 | 零件是嵌套互穿的壳层，中心几乎重合，任何基于质心的位移场都无效 |

## 三层校验（改动管线时不要绕过）

1. **锁文件** `assets/assets.lock.json` —— 资源字节完整性。
   `python3 scripts/fetch_models.py --verify`
2. **结构指纹** —— `compress_models.mjs` 写出后重新解析 GLB 比对节点结构，
   不一致即拒绝产出。为什么必需见 `pipeline.md`
3. **运行时绑定** `window.__verifyManifest()` —— 比对每个零件的实际世界包围盒中心
   与 manifest 记录值。`window.__scrambleMeta(1)` 是它的对照组，用来证明该校验非空

CI 另有一层：重算 manifest 并检查与入库版本逐字节一致。

## 反复出现的教训：失败必须有声

本项目至少四次栽在「检查悄悄没生效，却显示通过」上：

1. `git lfs status` 对空文件误报 —— 权威清单是 `git lfs ls-files`
2. `__verifyManifest` 在 explode=0 时恒为 0 —— 两边都是零向量，掩盖了坐标空间错配
3. `gh api` 路径里的 `?` 被 zsh 当通配符吃掉，命令根本没执行 ——
   于是每项 grep 都返回「未上传 ✓」，差点让含个人记录的仓库带着未核实状态公开
4. `str.replace` 锚点只匹配半行，行尾被甩到别处（两次，第二次直接语法错误）

**规则：当「通过」是默认输出时，先证明这个检查能失败。**
做法：每个校验配对照组；补丁脚本对锚点做存在性 + 唯一性断言并带换行符强制整行匹配；
改完 DOM 后核对「JS 引用的 id」与「HTML 定义的 id」的差集。

## 文档地图

| 文件 | 角色 |
|---|---|
| `README.md` | 快速开始、目录结构、Agent 工具层用法、授权声明 |
| `docs/STATE.md` | 本文。当前状态、未决事项、已否决路径（快照，整体替换） |
| `docs/HANDOFF.md` | 变更日志，按批次，最新在上（追加在顶部） |
| `docs/explode-design.md` | 爆炸图 / 钻取 / ASSEMBLE / 连通分量否决 / 泛化检验的推导与实测 |
| `docs/pipeline.md` | 压缩管线与两层校验、贴图预算 |
| `docs/shots/` | 各阶段对比截图，含失败记录 |

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
