# 你在这里

最后更新：2026-08-29

站点：https://bozheng-long.org/ironman-armor-lab/
仓库：https://github.com/BozhengLong/ironman-armor-lab （public）

## 当前任务与中断点

上一批（R8）已完成：CC-BY 可见署名（HUD 署名块 + `CREDITS.txt` +
随产物分发的 `ATTRIBUTION.txt`），以及顺带发现并修复的移动端媒体查询失效。
本地已构建校验通过。

**中断点：R8 已提交但尚未发布。** 站点上现在还是旧版本 —— 署名要生效需要
`gh workflow run pages.yml -f deploy=true`。在此之前站点仍处于署名不合规状态。

## 下一步（按优先级）

1. **发布**，让署名真正上线 —— 在此之前义务仍未履行。
2. REPULSOR 动作（唯一明确列出但未做的功能）。
3. 其余为可选。

## 未决事项

### 1. CC-BY 署名（代码已完成，等发布）

三个模型均为 `CC Attribution`，站点公开分发这些 GLB，署名义务因此成立。
R8 已实现三处署名，内容全部由 `assets/manifests/index.json` 生成：
HUD 常驻署名块、站点根 `CREDITS.txt`、每个产物目录下的 `ATTRIBUTION.txt`，
并按 3(a)(1)(B) 声明了「已改动（压缩）」。缺字段时 `build_site.mjs` 拒绝出站点。

**剩下的只有发布这一步。** 线上仍是旧版本。

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

### 6. 世界观文案与第三个模型不符 —— 复核后判定为不成立

R8 逐条清点了 HUD 上的全部文案，**没有任何钢铁侠专属表述**：
`ARMOR LAB` / `ARMOR ARCHIVE` 对人形机甲同样成立，`SUBASSEMBLY` 是中性工程词，
组标签是解剖学词汇（helmet / chest / thigh），机甲也适用；
而三个模型的副标题早已按模型区分（`MARK 44` / `MARK VI` / `MECH FRAME`）。
此条为此前记录时的高估，不必再做。留在这里是为了别再被重新提出来。

## 已评估并否决（不要重复评估）

| 方案 | 否决理由 |
|---|---|
| Git LFS 管理资源 | `assets/raw/` 是下载缓存不是源码，给缓存做版本控制在原理上就错；LFS 也不解决来源问题。改为提交校验和锁文件。`.gitattributes` 留有注释掉的规则与 Pages 不解析指针的告诫 |
| Cloudflare Pages / R2 | 仓库可见性保护不了模型 —— 部署到任何公开站点后 GLB 都可下载。既然如此，GitHub Pages 是最简路径。Cloudflare Access 是唯一能真正不公开资源的方案，若将来改变主意再评估 |
| 按连通分量拆分零件 | 任何阈值下都产出 582–1295 个零件，反而更读不出信息。数据见 `explode-design.md` |
| 用 Blender 重拆模型 | 源 mesh 并未焊死，拆分是纯程序操作，不需要 Blender（此前判断有误，已更正） |
| 径向/膨胀类爆炸场 | 零件是嵌套互穿的壳层，中心几乎重合，任何基于质心的位移场都无效 |

## 五层校验（改动管线或 HUD 时不要绕过）

1. **锁文件** `assets/assets.lock.json` —— 资源字节完整性。
   `python3 scripts/fetch_models.py --verify`
2. **结构指纹** —— `compress_models.mjs` 写出后重新解析 GLB 比对节点结构，
   不一致即拒绝产出。为什么必需见 `pipeline.md`
3. **运行时绑定** `window.__verifyManifest()` —— 比对每个零件的实际世界包围盒中心
   与 manifest 记录值。`window.__scrambleMeta(1)` 是它的对照组，用来证明该校验非空
4. **署名可见性** `window.__verifyCredit()` —— 不只查字符串填没填，而是查读者
   是否真的看得见：尺寸、可见性、是否落在视口内，以及三条必需链接的 href
   是否与 index.json 一致。构建期另有守卫，字段缺失直接让 `build_site.mjs` 失败
5. **HUD 不重叠** `window.__verifyHud()` —— 各面板都是手写坐标各自 fixed 定位，
   撞在一起不会报错、只是文字叠着还能读一半。这个函数把「没撞」变成可断言的事实

CI 另有一层：重算 manifest 并检查与入库版本逐字节一致 ——
**但只覆盖 hulkbuster 与 ironman，samurai 不在其中**，是个已知缺口。

## 反复出现的教训：失败必须有声

本项目至少五次栽在「检查悄悄没生效，却显示通过」上：

1. `git lfs status` 对空文件误报 —— 权威清单是 `git lfs ls-files`
2. `__verifyManifest` 在 explode=0 时恒为 0 —— 两边都是零向量，掩盖了坐标空间错配
3. `gh api` 路径里的 `?` 被 zsh 当通配符吃掉，命令根本没执行 ——
   于是每项 grep 都返回「未上传 ✓」，差点让含个人记录的仓库带着未核实状态公开
4. `str.replace` 锚点只匹配半行，行尾被甩到别处（两次，第二次直接语法错误；
   R8 又犯一次，少吃一个 `}` 写出重复右括号）
5. **整个移动端媒体查询从来没生效过**：它写在样式表开头，而 `#tele` / `#roster` /
   `#ctl` / `#scrim*` 的基础规则写在后面 —— 同为 id 选择器、特异性相同，
   媒体查询不增加特异性，后写的一律胜出。唯一生效的是 `html,body{font-size}`，
   因为那条基础规则恰好写在前面。**而验收证据（`docs/shots/mobile.png`）是单模型
   时期拍的**：那时没有清单可撞、副标题也短，坏掉的布局恰好看起来正常。
   教训：截图只能证明「拍的那一刻那个配置下没问题」，不能证明规则生效

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
python3 scripts/fetch_models.py --reattribute  # 只重写署名文件，不重新下载
python3 scripts/build_index.py                 # 元数据 -> index.json（署名的唯一来源）
python3 scripts/backup_assets.py --out DIR     # 仓库外备份（含还原验证）
node scripts/compress_models.mjs               # 压缩（含结构指纹校验）
node scripts/build_site.mjs                    # 组装静态站点
gh workflow run pages.yml -f deploy=true       # 手动发布（push 只构建不发布）
```
