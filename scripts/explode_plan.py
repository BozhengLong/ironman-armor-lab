#!/usr/bin/env python3
"""为每个部件规划爆炸位移，输出 <slug>.explode.json。

读取 analyze_parts.py 生成的 manifest，不修改它。

## 为什么按组刚体分离，而不是逐件散开

实测这两个模型的零件是深度嵌套互穿的壳层：hulkbuster 相邻件的中心距只有
自身包围盒对角线的 6%（中位），147 个零件中没有一个与他人无重叠。
任何基于质心的位移场，对中心几乎重合的零件必然给出几乎相同的位移 ——
径向、均匀膨胀、两级径向都绕不过这一点。

参照页面（yadongxie.com/lab/tanks）的遥测里写的是 GROUPS，它爆炸的是
drawing group 而非单个 mesh。所以主模式是把语义组当刚体整块拉开。

## 四种模式

  radial      逐件纯径向（基线，已实测失效，保留用于对比）
  semantic    逐件语义轴 + 组内均匀膨胀（部件数少时可用）
  group       语义组刚体整块分离（主模式）
  groupSpread group 模式 + 组内按秩等距展开（完整拆解观感）

用法:
    python3 scripts/explode_plan.py assets/manifests/ironman.json --metric
"""
import argparse, json, pathlib, sys
import numpy as np

AXES = "xyz"

# 单位约定：所有位移以「模型高度的分数」为单位。
# 运行时 pos = base + vec * 模型高度 * t，t∈[0,1] 即爆炸进度。
#
# 语义组轴定义在规范坐标系 (U=上, O=横向朝外, F=朝前) 中，与模型姿态解耦。
# dist 沿运动链递增，使肢体各节互相分开。相邻组的 dist 差需达到组自身
# 尺度的量级，否则看不出分离 —— 组的对角线中位数就有身高的 0.16 到 0.33。
SEMANTIC = {
    #             U      O      F     dist(占身高)
    "chest":    ( 0.25,  0.00,  0.97, 0.06),   # 躯干核心，基本不动
    "abdomen":  (-0.15,  0.00,  0.99, 0.15),
    "pelvis":   (-0.55,  0.00,  0.84, 0.24),
    "neck":     ( 0.95,  0.00,  0.10, 0.12),
    "helmet":   ( 1.00,  0.00,  0.15, 0.24),
    "shoulder": ( 0.50,  0.87,  0.00, 0.16),
    "upper_arm":( 0.12,  0.99,  0.00, 0.26),
    "forearm":  ( 0.00,  1.00,  0.00, 0.37),
    "hand":     (-0.12,  0.99,  0.00, 0.48),
    "thigh":    (-0.80,  0.60,  0.00, 0.16),
    "shin":     (-0.96,  0.45,  0.00, 0.27),
    "foot":     (-1.00,  0.40,  0.00, 0.38),
}
UNKNOWN_DIST = 0.14           # 未分类部件的径向退路
RADIAL_DIST = 0.12            # 基线模式的恒定径向幅度
DILATE = 0.30                 # semantic 模式的组内均匀膨胀系数
GROUP_SPREAD = 0.14           # groupSpread 模式分配给每组的组内总展开量（占身高）

# 钻取模式：单独查看某一组时的组内展开总量（占身高）。
# 间距按各零件在组轴上的自身厚度分配 —— 大零件给大间隙 —— 再归一化到这个总量，
# 这样 39 个手指的组不会拉成一条无限长的线。
DRILL_TOTAL = 0.55

# 组装顺序（数字越小越先归位），模拟穿戴过程：脚 -> 腿 -> 躯干 -> 臂 -> 头。
# 头盔放最后 —— 那是这套动作的收尾镜头。
ASSEMBLE_ORDER = {
    "foot": 0, "shin": 1, "thigh": 2, "pelvis": 3, "abdomen": 4, "chest": 5,
    "shoulder": 6, "upper_arm": 7, "forearm": 8, "hand": 9, "neck": 10, "helmet": 11,
}
ASSEMBLE_WINDOW = 0.30    # 单个零件的运动占整条时间轴的比例
ASSEMBLE_INTRA = 0.06     # 组内错峰幅度上限：外层壳后到，才能盖在内层上
# 组内错峰会被压到不超过组间间隔的这个比例 —— 否则一组的最外层会晚于
# 下一组起步（例如肩甲先于它所覆盖的胸甲到位），穿戴顺序就错了。
ASSEMBLE_INTRA_MAX_RATIO = 0.8
FIXED_FLAGS = ("base", "body_shell")   # 不参与爆炸，保持原位作参考基准
CLEAR_VISIBLE = 0.35          # 净间隙 / 自身尺度，超过此值才看得出明显分开


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.zeros(3)


# ---------- 规范坐标系 ----------

def canonical_frame(man, parts, front_override=None):
    up = AXES.index(man["upAxis"])
    lat = AXES.index(man["latAxis"])
    depth = ({0, 1, 2} - {up, lat}).pop()

    def centroid(names, axis):
        sel = [p for p in parts if p["part"] in names and not p.get("flag")]
        return float(np.mean([p["center"][axis] for p in sel])) if sel else None

    foot_u, head_u = centroid({"foot"}, up), centroid({"helmet"}, up)
    up_sign = -1.0 if (foot_u is not None and head_u is not None and foot_u > head_u) else 1.0

    # 朝前符号，按证据强度依次尝试
    front_sign = how = None

    # (1) 最强：材质名含 face 的零件必在头部前方
    face = [p for p in parts if not p.get("flag")
            and "face" in str(p.get("material") or "").lower()]
    head = [p for p in parts if p["part"] in ("helmet", "neck") and not p.get("flag")]
    if face and len(head) > len(face):
        rest = [p for p in head if p not in face]
        fd = float(np.mean([p["center"][depth] for p in face]))
        hd = float(np.mean([p["center"][depth] for p in rest]))
        if abs(fd - hd) > 1e-6:
            front_sign, how = (1.0 if fd > hd else -1.0), "face 材质 vs 头部其余"

    # (2) 面罩使头部质心略前于颈部
    if front_sign is None:
        h_d, n_d = centroid({"helmet"}, depth), centroid({"neck"}, depth)
        if h_d is not None and n_d is not None and abs(h_d - n_d) > 1e-6:
            front_sign, how = (1.0 if h_d > n_d else -1.0), "helmet vs neck"

    # (3) 脚趾朝前 —— 宽步/错步姿态下不可靠，故排最后
    if front_sign is None:
        f_d, s_d = centroid({"foot"}, depth), centroid({"shin"}, depth)
        if f_d is not None and s_d is not None and abs(f_d - s_d) > 1e-6:
            front_sign, how = (1.0 if f_d > s_d else -1.0), "foot vs shin"

    if front_sign is None:
        front_sign, how = 1.0, "默认 +（无法判定）"
    if front_override:
        front_sign = -1.0 if front_override.startswith("-") else 1.0
        how = "手动指定"
    return up, lat, depth, up_sign, front_sign, how


def semantic_axis(part, side, up, lat, depth, up_sign, front_sign):
    """返回 (单位轴向, 链式距离)。未知部位返回 (None, None)。"""
    spec = SEMANTIC.get(part)
    if spec is None:
        return None, None
    u, o, f, dist = spec
    outward = -1.0 if side == "L" else (1.0 if side == "R" else 0.0)
    axis = np.zeros(3)
    axis[up] += u * up_sign
    axis[lat] += o * outward
    axis[depth] += f * front_sign
    return unit(axis), dist


# ---------- 分组 ----------

def build_groups(parts):
    """按 (部位, 左右) 分组 —— 左右手是两个独立子装配体，必须分开。"""
    g = {}
    for p in parts:
        if p.get("flag"):
            continue
        g.setdefault((p["part"], p["side"]), []).append(p)
    out = {}
    for k, members in g.items():
        C = np.array([m["center"] for m in members], dtype=float)
        lo = np.min([np.array(m["center"]) - np.array(m["size"]) / 2 for m in members], axis=0)
        hi = np.max([np.array(m["center"]) + np.array(m["size"]) / 2 for m in members], axis=0)
        out[k] = {"centroid": C.mean(axis=0), "members": members,
                  "min": lo, "max": hi, "diag": float(np.linalg.norm(hi - lo))}
    return out


# ---------- 规划 ----------

def plan(man, parts, height, front_override=None):
    up, lat, depth, up_sign, front_sign, how = canonical_frame(man, parts, front_override)
    groups = build_groups(parts)
    body = np.array(man["bodyCenter"], dtype=float)

    modes = ("radial", "semantic", "group", "groupSpread", "drill")
    vecs = {m: {} for m in modes}

    # 组内排序：按「远端角在组轴上的投影」，使外层壳先走且不交叉。
    # 同时算两种组内偏移量：
    #   rank_of  —— 等距（groupSpread 用），秩 / 最大秩
    #   cum_of   —— 按各零件在轴上的厚度分配后归一化（drill 用）
    rank_of, cum_of, axis_of = {}, {}, {}
    for key, grp in groups.items():
        part, side = key
        axis, _ = semantic_axis(part, side, up, lat, depth, up_sign, front_sign)
        if axis is None:
            axis = unit(grp["centroid"] - body)
        axis_of[key] = axis
        rows = []
        for m in grp["members"]:
            c = np.array(m["center"], dtype=float)
            sz = np.array(m["size"], dtype=float)
            far = float(np.dot(c - body, axis) + 0.5 * float(np.dot(np.abs(sz), np.abs(axis))))
            thick = float(np.dot(np.abs(sz), np.abs(axis)))   # 该零件在组轴上的厚度
            rows.append((far, m["node"], thick))
        rows.sort()
        n = len(rows)
        total = sum(t for _, _, t in rows)
        acc = 0.0
        for r, (_, node, thick) in enumerate(rows):
            rank_of[node] = (r, max(n - 1, 1))
            cum_of[node] = (acc / total) if total > 1e-9 else 0.0
            acc += thick

    # 每个零件的组装起始时刻，归一化到 [0, 1-ASSEMBLE_WINDOW]
    max_order = max(ASSEMBLE_ORDER.values())
    spacing = (1.0 - ASSEMBLE_WINDOW) / (max_order + 1)
    intra = min(ASSEMBLE_INTRA, spacing * ASSEMBLE_INTRA_MAX_RATIO)
    assemble_delay = {}
    for p in parts:
        if p.get("flag") in FIXED_FLAGS:
            assemble_delay[p["node"]] = 0.0
            continue
        order = ASSEMBLE_ORDER.get(p["part"])
        base = (order if order is not None else max_order / 2) * spacing
        r, rmax = rank_of[p["node"]]
        assemble_delay[p["node"]] = round(base + (r / rmax) * intra, 5)

    for p in parts:
        node = p["node"]
        if p.get("flag") in FIXED_FLAGS:
            for m in modes:
                vecs[m][node] = np.zeros(3)
            continue

        c = np.array(p["center"], dtype=float)
        key = (p["part"], p["side"])
        grp = groups[key]
        gc = grp["centroid"]
        axis, dist = semantic_axis(p["part"], p["side"], up, lat, depth, up_sign, front_sign)
        if axis is None:
            axis, dist = unit(gc - body), UNKNOWN_DIST

        # 基线：逐件恒幅径向。方向场无散度，中心重合的零件位移相同 -> 不分开
        vecs["radial"][node] = unit(c - body) * RADIAL_DIST

        # 逐件语义轴 + 组内均匀膨胀
        vecs["semantic"][node] = axis * dist + (c - gc) / height * DILATE

        # 组刚体整块（主模式）：同组所有成员位移完全相同
        vecs["group"][node] = axis * dist

        # 组刚体 + 组内按秩等距展开
        r, rmax = rank_of[node]
        vecs["groupSpread"][node] = axis * (dist + (r / rmax) * GROUP_SPREAD)

        # 钻取：组刚体 + 组内按厚度分配的展开（仅在单独查看某组时使用）
        vecs["drill"][node] = axis * (dist + cum_of[node] * DRILL_TOTAL)

    meta = {
        "upAxis": AXES[up], "latAxis": AXES[lat], "depthAxis": AXES[depth],
        "upSign": up_sign, "frontSign": front_sign, "frontDetectedBy": how,
        "unit": "模型高度的分数", "dilate": DILATE,
        "groupSpread": GROUP_SPREAD, "drillTotal": DRILL_TOTAL,
        "assembleWindow": ASSEMBLE_WINDOW,
    }
    return vecs, meta, groups, axis_of, assemble_delay


# ---------- 指标 ----------

def _clearance(C, S, V, height):
    """对每个单元取最近邻，返回以自身尺度归一化的净新增间隙。"""
    n = len(C)
    C1 = C + V * height
    D0 = np.linalg.norm(C[:, None, :] - C[None, :, :], axis=2)
    np.fill_diagonal(D0, np.inf)
    nn = np.argmin(D0, axis=1)
    d0 = D0[np.arange(n), nn]
    d1 = np.linalg.norm(C1 - C1[nn], axis=1)
    scale = np.maximum(0.5 * (S + S[nn]), 1e-9)
    return (d1 - d0) / scale, nn


def part_metric(parts, vecs, mode, height):
    live = [p for p in parts if not p.get("flag")]
    C = np.array([p["center"] for p in live], dtype=float)
    S = np.array([np.linalg.norm(p["size"]) for p in live], dtype=float)
    V = np.array([vecs[mode][p["node"]] for p in live], dtype=float)
    clear, _ = _clearance(C, S, V, height)
    return summarize(clear, len(live))


def group_metric(groups, vecs, mode, height):
    """组级指标：把每个子装配体当一个单元，衡量组与组之间是否真的拉开。
    这才是刚体分组模式该被评判的尺度 —— 组内零件是有意保持相对位置的。"""
    keys = sorted(groups)
    C = np.array([(groups[k]["min"] + groups[k]["max"]) / 2 for k in keys], dtype=float)
    S = np.array([groups[k]["diag"] for k in keys], dtype=float)
    V = np.array([vecs[mode][groups[k]["members"][0]["node"]] for k in keys], dtype=float)
    clear, nn = _clearance(C, S, V, height)
    return summarize(clear, len(keys)), keys, clear, nn


def summarize(clear, total):
    return {
        "median": float(np.median(clear)), "p10": float(np.percentile(clear, 10)),
        "visible": int((clear >= CLEAR_VISIBLE).sum()),
        "stuck": int(((clear >= 0) & (clear < CLEAR_VISIBLE)).sum()),
        "collide": int((clear < 0).sum()), "total": total,
    }


def group_metadata(groups, vecs, height, axis_of, assemble_delay):
    """给每个子装配体生成信息面板与相机取景所需的数据。"""
    out = {}
    for key, grp in sorted(groups.items()):
        part, side = key
        ms = grp["members"]
        mats, emissive = [], 0
        for m in ms:
            mat = m.get("material")
            if mat and mat not in mats:
                mats.append(mat)
            if m.get("emissive"):
                emissive += 1

        def bounds_at(mode):
            lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
            for m in ms:
                c = np.array(m["center"], dtype=float) + vecs[mode][m["node"]] * height
                h = np.array(m["size"], dtype=float) / 2
                lo = np.minimum(lo, c - h); hi = np.maximum(hi, c + h)
            return lo, hi

        g_lo, g_hi = bounds_at("group")
        d_lo, d_hi = bounds_at("drill")
        hs = [m["h"] for m in ms]
        ds = [assemble_delay[m["node"]] for m in ms]
        out[f"{part}/{side}"] = {
            "part": part, "side": side,
            "nodes": [m["node"] for m in ms],
            "count": len(ms),
            "tris": sum(m["tris"] for m in ms),
            "materials": mats,
            "emissive": emissive,
            "hRange": [round(min(hs), 3), round(max(hs), 3)],
            "assembleOrder": ASSEMBLE_ORDER.get(part),
            "assembleDelay": [round(min(ds), 4), round(max(ds), 4)],
            "axis": [round(float(x), 4) for x in axis_of[key]],
            "bounds": {"min": [round(float(x), 4) for x in grp["min"]],
                       "max": [round(float(x), 4) for x in grp["max"]]},
            "groupBounds": {"min": [round(float(x), 4) for x in g_lo],
                            "max": [round(float(x), 4) for x in g_hi]},
            "drillBounds": {"min": [round(float(x), 4) for x in d_lo],
                            "max": [round(float(x), 4) for x in d_hi]},
        }
    return out


def exploded_bounds(parts, vecs, mode, height):
    lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
    for p in parts:
        if p.get("flag") == "base":
            continue
        c = np.array(p["center"], dtype=float) + vecs[mode][p["node"]] * height
        s = np.array(p["size"], dtype=float) / 2
        lo = np.minimum(lo, c - s); hi = np.maximum(hi, c + s)
    return lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--front", default=None, help="手动指定朝前方向，如 +z / -z")
    ap.add_argument("--metric", action="store_true")
    ap.add_argument("--detail", type=int, default=0, help="列出组级最差的 N 组")
    ap.add_argument("--mode-detail", dest="mode_detail", default="group")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    mpath = pathlib.Path(a.manifest)
    if not mpath.exists():
        sys.exit(f"manifest 不存在: {mpath}")
    man = json.loads(mpath.read_text(encoding="utf-8"))
    parts = man["parts"]
    up_i = AXES.index(man["upAxis"])
    height = float(man["bounds"]["max"][up_i] - man["bounds"]["min"][up_i])

    vecs, meta, groups, axis_of, assemble_delay = plan(man, parts, height, a.front)

    print(f"manifest  : {mpath.name}")
    print(f"规范坐标系: 上={meta['upAxis']}({meta['upSign']:+.0f}) "
          f"横向={meta['latAxis']} 深度={meta['depthAxis']}({meta['frontSign']:+.0f})")
    print(f"朝前判定  : {meta['frontDetectedBy']}")
    print(f"子装配体  : {len(groups)} 个   固定不动: "
          f"{sum(1 for p in parts if p.get('flag') in FIXED_FLAGS)} 个")

    if a.metric:
        for scope, fn in (("逐件", lambda m: part_metric(parts, vecs, m, height)),
                          ("组级", lambda m: group_metric(groups, vecs, m, height)[0])):
            print(f"\n{scope}分离指标")
            print(f"{'模式':<13}{'中位间隙':>9}{'p10':>8}{'看得出分开':>12}{'挪动不足':>10}{'碰撞':>7}")
            print("-" * 60)
            for mode in vecs:
                r = fn(mode)
                print(f"{mode:<13}{r['median']:>9.2f}{r['p10']:>8.2f}"
                      f"{r['visible']:>8}/{r['total']:<3}{r['stuck']:>10}{r['collide']:>7}")
        a_lo = np.array(man["bounds"]["min"], dtype=float)
        a_hi = np.array(man["bounds"]["max"], dtype=float)
        a_span = a_hi - a_lo
        print(f"\n{'模式':<13}{'足迹膨胀 (宽×高×深)':>28}{'最大位移':>12}")
        print("-" * 56)
        for mode in vecs:
            lo, hi = exploded_bounds(parts, vecs, mode, height)
            g = (hi - lo) / np.maximum(a_span, 1e-9)
            mx = max(float(np.linalg.norm(v)) for v in vecs[mode].values())
            print(f"{mode:<13}{g[0]:>14.2f}x{g[1]:>6.2f}x{g[2]:>6.2f}{mx:>11.2f}H")
        print(f"\n间隙以单元自身包围盒对角线为单位；>= {CLEAR_VISIBLE} 才看得出明显分开，< 0 为碰撞。")
        print("足迹膨胀 2 倍左右为宜 —— 过大则丢失空间关系，读起来像碎片散落。")
        print("刚体分组模式应看「组级」—— 组内零件是有意保持相对位置的。")

        if a.detail:
            _, keys, clear, nn = group_metric(groups, vecs, a.mode_detail, height)
            order = np.argsort(clear)
            print(f"\n{a.mode_detail} 模式组级最差的 {a.detail} 组:")
            for i in order[:a.detail]:
                k, k2 = keys[i], keys[nn[i]]
                print(f"  clearance={clear[i]:>7.3f}  {k[0]}/{k[1]} (n={len(groups[k]['members'])})"
                      f"  <-> {k2[0]}/{k2[1]}")

    out = pathlib.Path(a.out) if a.out else mpath.with_suffix(".explode.json")
    bounds = {}
    for mode in vecs:
        lo, hi = exploded_bounds(parts, vecs, mode, height)
        bounds[mode] = {"min": [round(float(x), 4) for x in lo],
                        "max": [round(float(x), 4) for x in hi]}
    payload = {
        "manifest": mpath.name, "frame": meta, "height": round(height, 5),
        "modes": list(vecs), "defaultMode": "group",
        "boundsAtFull": bounds,
        "groups": group_metadata(groups, vecs, height, axis_of, assemble_delay),
        "parts": {
            str(p["node"]): {
                "part": p["part"], "side": p["side"], "flag": p.get("flag"),
                "assembleDelay": assemble_delay[p["node"]],
                **{m: [round(float(x), 5) for x in vecs[m][p["node"]]] for m in vecs},
            } for p in parts
        },
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n-> {out}")


if __name__ == "__main__":
    main()
