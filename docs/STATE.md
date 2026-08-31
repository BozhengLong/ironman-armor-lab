# 你在这里

最后更新：2026-08-31

站点：https://bozheng-long.org/ironman-armor-lab/
仓库：https://github.com/BozhengLong/ironman-armor-lab （public）

## 当前状态

**项目处在一个刻意的收尾状态。** 工作区干净、与远端同步、CI 绿、线上已验、
未决清单为空。最近一批（R14）把页面级校验放进了 CI —— 在此之前 CI 从头到尾
没有任何一步解析过页面的 JS。

逐批的经过、原因与踩过的坑在 `HANDOFF.md`（R1–R14），本文不复述。

**中断点：无进行中的工作。**

## 下一步：没有必要做的事了

2026-08-31 逐项评估过一轮候选（验收覆盖补全、键盘提示、CI 缓存、第四个模型），
结论是**没有一项是必要的**。判据是「永远不做会怎样」：

| 候选 | 不做的后果 |
|---|---|
| 把 playAssemble / playRepulsor / focusPart / TOUR 纳入验收 | 演示少一步，没人会察觉 |
| 键盘提示与可发现性 | 少数访客探索得少一点；光标已会变手型 |
| CI 缓存浏览器 | 构建多花约一分钟 |
| 第四个模型 | 什么也不会发生 |

对比真正必要过的那些 —— CC-BY 是站点公开期间**持续**的违约；媒体查询失效让
**每个**移动端访客看到坏 HUD；CI 拦不住白屏可能发布死站点 —— 后果会持续、会累积。
上表这些不会。

**什么情况下它们才值得做：**

- 要重构 agent 层 → 先补验收覆盖，那时它从整洁变成防护
- 有别人开始改这个仓库 → 护栏价值上升，因为你不再是唯一会破坏它的人
- 站点真有人用且在意留存 → 键盘与可发现性才有意义

唯一还有上行空间的是**一篇对外的构建说明**：这个项目的命题是「把 Web 当表达
介质」，而「怎么做出来的」目前只存在于 `docs/` 里。那属于内容工作，不是工程欠债。

## 约束与已定结论（不要重新提起）


### 1. CC-BY 署名 —— 已完成并上线（2026-08-29，R8）

留在这里是为了记住约束：**新增模型时署名会自动跟上**（三处内容都由
`assets/manifests/index.json` 生成），但 `MODELS` 里必须补全
`title` / `author` / `author_url` / `license` / `license_url` / `url`，
否则 `build_site.mjs` 会直接拒绝出站点 —— 这是有意的，不要绕过它。

### 2. 资源备份仍是单点（2026-08-30 决定：暂不做异地）

`assets/raw/` 不入库。锁文件保证完整性，不保证可用性 —— 三个模型来源均不明，
下架风险不低。已有归档：

```
~/Backups/ironman-armor-lab/ironman-armor-lab-assets-2026-08-29.tar.gz  145.2 MB  ✓
```

覆盖全部三个模型、48 个文件，已验证可还原。**但与工作副本同盘**，
只挡上游下架、不挡硬盘故障。

**已决定暂不做异地副本。** 现有归档挡住的是主要风险（上游删除或改授权），
挡不住的是硬盘故障 —— 后者一旦发生，模型能否重新获取取决于上游是否还在。
不必再提；要做时是一条命令：`python3 scripts/backup_assets.py --out <外置盘路径>`。
新增模型后备份即过期。

### 3. Sketchfab token（2026-08-30 决定：不轮换）

**不必再提。** 决定的依据是实际暴露面，不是「反正没出事」：

- `~/.sketchfab_token` 权限 600
- GitHub Actions secret（写入后不可读回）
- 创建它的那次对话记录

2026-08-30 核对过：该 token **未出现在工作区任何文件，也未出现在 git 全历史的
任何 blob 里**。也就是说它从未进入公开物。核对方法本身用一个必然存在的字符串
（`SKETCHFAB_TOKEN`）做过对照，确认能命中 —— 否则「没找到」可能只是命令没生效。

重新核对：

```bash
TOK=$(tr -d '\n\r ' < ~/.sketchfab_token)
git rev-list --objects --all | awk '{print $1}' \
  | git cat-file --batch-check='%(objecttype) %(objectname)' \
  | awk '$1=="blob"{print $2}' \
  | while read -r o; do git cat-file blob "$o" | grep -qF "$TOK" && echo "$o"; done
```

**唯一会推翻这个决定的情况**：token 进入了任何公开物（提交、日志、截图、
CI 输出）。那时轮换就不再是卫生问题而是必须。

### 4. REPULSOR —— 已完成（R9），留两条约束

- **发射口是推导的，不是标注的**：取臂链最远一节，且要求至少到 forearm。
  因此 **ironman 只有左手能发射**（右臂只分离到 upper_arm），这是数据决定的，
  不是 bug。新增模型若手臂没分离到小臂，按钮会自动禁用并说明原因。
- **不要为了加 bloom 引入后处理**：HUD 的 DRAW CALLS / TRIANGLES 是如实读
  `renderer.info` 的，换成 EffectComposer 会让这两个读数失真。
  当初记的方案里写了「点光源加 bloom」，实做时否决了 bloom 这一半。

（原先记的「`hand/L` 已有 1 个 light 材质发光件」只对 hulkbuster 成立，
ironman 与 samurai 的发光件数量都是 0，不能作为发射口锚点。）

### 5. 朝前判定 —— 结论是删掉两条，不是加第四条（2026-08-30）

核对真值（从 +z 渲染正视图，三个模型都朝 +z）后发现：helmet-vs-neck 与
foot-vs-shin **错多于对**，只是在 hulkbuster 上被 face 材质压住没暴露。
调阈值救不了 —— samurai 上 helmet-vs-neck 以 5.02% 身高的差额给出错答案，
比 face 材质给出正确答案时的差额还大。两条已删除。

现只剩 face 材质一条；其余退回默认 `+z` 并如实写「无法判定」。
三条启发各自的结论与差额记进 `frame.frontEvidence`，分歧可见。
推导与数据见 `explode-design.md`。

该遗留已在 R13 解决：先立「重复体标签必须一致」这条不变量，再把 `face` 改成
整词匹配。顺带把 samurai 的 node 54/56 从 `helmet` 纠正为 `neck`（渲染核对过，
那两件是悬在兜下方的𩊱/颈甲，不属于兜本身）。见 `explode-design.md`。

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

## 七层校验（改动管线或 HUD 时不要绕过）

**第 3–7 层现在由 CI 自动跑**（`npm run test:page`，无头浏览器加载构建产物），
不再依赖「记得手动跑」。而且它同时验两件事：校验通过 + **每条校验确实能失败**。

**但覆盖面要说清楚，别把这句话读得太大**（2026-08-31 核过）：验收只调了 11 个
agent 命令里的 5 个，`playAssemble` / `playRepulsor` / `focusPart` 与整个 TOUR
都不在内 —— 也就是说 REPULSOR 的后坐数学、组装编排、导览这三样只有人工验过。
另外 `startTour` 捕获异常后会继续下一步，工具改名只会让导览静静跳过一步。
评估后判定不必补（后果止于「演示少一步」），但重构 agent 层之前应当先补上。


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
6. **发射口推导** `window.__verifyRepulsor()` —— 发射口算错不会报错，
   只会「光从胳膊肘冒出来」，肉眼还未必看得准。判据：发射口必须比末端组中心
   更远离躯干、射流不得指向躯干内部。对照组 `window.__scrambleRepulsor('flip')`
7. **衬底覆盖** `window.__verifyScrim()` —— HUD 文字压在模型上，靠 `.scrim`
   保证可读性；衬底尺寸写死而面板由内容撑开，**加一个按钮就可能长出衬底之外**，
   不报错、只是变得看不清。加 LINK / TOUR 两个按钮时就发生过，是它找出来的

CI 另有一层：重算 manifest 并检查与入库版本逐字节一致，三个模型都覆盖（R9 补齐）。

回归测试里还有一条**数据不变量**：三角面数与尺寸完全相同的零件必须拿到相同的
部位标签（`side` 可不同）。它自带对照组 —— 故意改坏一组后检查必须报错。
这条不变量是修 `MATERIAL_HINTS` 子串缺陷的前提，见 `explode-design.md`。

## 反复出现的教训：失败必须有声

本项目至少六次栽在「检查悄悄没生效，却显示通过」上：

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
6. `__verifyRepulsor` 第一版的两条判据**都恒真**：发射口由
   `中心 + 方向 × reach` 构造，而 reach 取自包围盒角点投影的最大值，
   必然非负、必然不超过半对角线，两条判据在数学上就不可能失败。
   写完校验先问一句「什么输入能让它变红」，答不上来就是恒真

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
