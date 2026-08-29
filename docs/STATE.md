# 你在这里

最后更新：2026-08-29

站点：https://bozheng-long.org/ironman-armor-lab/
仓库：https://github.com/BozhengLong/ironman-armor-lab （public）

## 当前任务与中断点

上一批（R9）已完成但**尚未发布**：REPULSOR 动作，以及 CI 补上 samurai 的
manifest 可复现性检查。本地三个模型 × 静止/爆炸/钻取三种叠加态全部验过。
R8 的 CC-BY 署名已在线上生效。

**中断点：R9 已提交未发布。** 线上还没有 REPULSOR。
发布：`gh workflow run pages.yml -f deploy=true`

## 下一步（按优先级）

1. 发布 R9。
2. 备份异地、token 轮换 —— 都需要你动手，见下。
3. 其余为可选。

## 未决事项

### 1. CC-BY 署名 —— 已完成并上线（2026-08-29，R8）

留在这里是为了记住约束：**新增模型时署名会自动跟上**（三处内容都由
`assets/manifests/index.json` 生成），但 `MODELS` 里必须补全
`title` / `author` / `author_url` / `license` / `license_url` / `url`，
否则 `build_site.mjs` 会直接拒绝出站点 —— 这是有意的，不要绕过它。

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

### 4. REPULSOR —— 已完成（R9），留两条约束

- **发射口是推导的，不是标注的**：取臂链最远一节，且要求至少到 forearm。
  因此 **ironman 只有左手能发射**（右臂只分离到 upper_arm），这是数据决定的，
  不是 bug。新增模型若手臂没分离到小臂，按钮会自动禁用并说明原因。
- **不要为了加 bloom 引入后处理**：HUD 的 DRAW CALLS / TRIANGLES 是如实读
  `renderer.info` 的，换成 EffectComposer 会让这两个读数失真。
  当初记的方案里写了「点光源加 bloom」，实做时否决了 bloom 这一半。

（原先记的「`hand/L` 已有 1 个 light 材质发光件」只对 hulkbuster 成立，
ironman 与 samurai 的发光件数量都是 0，不能作为发射口锚点。）

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

## 六层校验（改动管线或 HUD 时不要绕过）

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

CI 另有一层：重算 manifest 并检查与入库版本逐字节一致，三个模型都覆盖（R9 补齐）。

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
