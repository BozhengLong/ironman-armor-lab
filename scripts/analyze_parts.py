#!/usr/bin/env python3
"""解析 glTF/GLB，算出每个部件的世界空间包围盒，按人体位置自动分类，输出 parts manifest。

用法:
    python3 scripts/analyze_parts.py assets/raw/ironman/scene.gltf [--up auto|x|y|z] [--out FILE]

原理: glTF 规范要求 POSITION accessor 必须带 min/max，所以只读 JSON 就能拿到每个
primitive 的局部包围盒，无需解析 .bin 顶点数据。
"""
import argparse, base64, json, math, pathlib, struct, sys
import numpy as np

# ---------- glTF 载入 ----------

def load_gltf(path: pathlib.Path):
    """返回 (gltf_dict, buffers)。buffers 只在需要回退读顶点时才填充。"""
    data = path.read_bytes()
    if data[:4] == b"glTF":
        ver, length = struct.unpack_from("<II", data, 4)
        off, js, bins = 12, None, []
        while off < length:
            clen, ctype = struct.unpack_from("<II", data, off)
            chunk = data[off + 8 : off + 8 + clen]
            if ctype == 0x4E4F534A:
                js = json.loads(chunk.decode("utf-8"))
            elif ctype == 0x004E4942:
                bins.append(chunk)
            off += 8 + clen + (-clen % 4)
        return js, bins
    g = json.loads(data.decode("utf-8"))
    bufs = []
    for b in g.get("buffers", []):
        uri = b.get("uri", "")
        if uri.startswith("data:"):
            bufs.append(base64.b64decode(uri.split(",", 1)[1]))
        elif uri:
            import urllib.parse
            bufs.append((path.parent / urllib.parse.unquote(uri)).read_bytes())
        else:
            bufs.append(b"")
    return g, bufs


def node_matrix(n: dict) -> np.ndarray:
    if "matrix" in n:
        return np.array(n["matrix"], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in n:
        m = m @ np.diag([*n["scale"], 1.0])
    if "rotation" in n:
        x, y, z, w = n["rotation"]
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1],
        ])
        m = r @ m
    if "translation" in n:
        t = np.eye(4); t[:3, 3] = n["translation"]
        m = t @ m
    return m


# ---------- 包围盒 ----------

def primitive_bounds(g, prim):
    """局部包围盒 (min, max)，取自 POSITION accessor 的 min/max。"""
    idx = prim.get("attributes", {}).get("POSITION")
    if idx is None:
        return None
    acc = g["accessors"][idx]
    lo, hi = acc.get("min"), acc.get("max")
    if lo is None or hi is None:
        return None
    return np.array(lo, dtype=float), np.array(hi, dtype=float)


def world_aabb(lo, hi, M):
    corners = np.array([[x, y, z, 1.0]
                        for x in (lo[0], hi[0])
                        for y in (lo[1], hi[1])
                        for z in (lo[2], hi[2])])
    w = (M @ corners.T).T[:, :3]
    return w.min(axis=0), w.max(axis=0)


def collect(g, bufs):
    """遍历场景，返回每个带网格节点的世界包围盒。"""
    nodes = g.get("nodes", [])
    parent_of = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent_of[c] = i

    cache = {}
    def world_of(i):
        if i in cache:
            return cache[i]
        M = node_matrix(nodes[i])
        p = parent_of.get(i)
        cache[i] = (world_of(p) @ M) if p is not None else M
        return cache[i]

    out, skipped = [], []
    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        mesh = g["meshes"][n["mesh"]]
        M = world_of(i)
        lows, highs, tris = [], [], 0
        for prim in mesh.get("primitives", []):
            b = primitive_bounds(g, prim)
            if b is None:
                continue
            wl, wh = world_aabb(b[0], b[1], M)
            lows.append(wl); highs.append(wh)
            ia = prim.get("indices")
            if ia is not None:
                tris += g["accessors"][ia]["count"] // 3
        if not lows:
            skipped.append(n.get("name") or f"node{i}")
            continue
        lo = np.min(np.array(lows), axis=0)
        hi = np.max(np.array(highs), axis=0)
        out.append({
            "node": i,
            "name": n.get("name") or mesh.get("name") or f"node{i}",
            "min": lo, "max": hi,
            "center": (lo + hi) / 2.0,
            "size": hi - lo,
            "tris": tris,
        })
    return out, skipped


# ---------- 分类 ----------

# 高度分档，按真实人体比例校准（h = 归一化身高 0=脚底 1=头顶）
# (下界, 上界, 居中部件名, 横向部件名)
BANDS = [
    (0.90,  1.01, "helmet",  "helmet"),
    (0.84,  0.90, "neck",    "shoulder"),
    (0.78,  0.84, "chest",   "shoulder"),
    (0.68,  0.78, "chest",   "upper_arm"),
    (0.57,  0.68, "abdomen", "upper_arm"),
    (0.46,  0.57, "pelvis",  "forearm"),
    (0.38,  0.46, "thigh",   "hand"),
    (0.24,  0.38, "thigh",   "hand"),
    (0.09,  0.24, "shin",    "shin"),
    (-0.01, 0.09, "foot",    "foot"),
]
LATERAL_CUTOFF = 0.45   # |lat| 超过此值判为肢体
SIDE_CUTOFF = 0.12      # |lat| 超过此值判左右，否则居中

# 异常节点判定阈值
BASE_FLATNESS = 0.15    # 沿上方向的厚度 / 最大水平跨度，低于此值且面积很大 -> 地面/底座
BASE_SPREAD = 1.5       # 水平跨度需超过中位数的倍数
# 连体内衬的判据：不能只看「跨度多大」，还要看「跨在哪里」。
# 第三个模型（人形机甲）暴露了这一点：它的腿跨度占全高 0.57、臂占 0.57、
# 刀占 0.67，都会被单一跨度阈值误判，进而污染高度参考系、让所有分档错位。
# 真正的连体内衬是「从最底贯到最顶」——ironman 的 Object_6 是 0.00→0.87。
SHELL_HEIGHT = 0.55     # 沿上方向的跨度下限（占全高）
SHELL_BOTTOM = 0.12     # 底端须低于此高度
SHELL_TOP = 0.80        # 顶端须高于此高度（两条同时满足才算贯穿全身）

# 横向远在人形之外的物件（如立在一旁的刀），不属于身体计划。
# lat 本身按 p95 归一化，所以 1.5 意味着超出 95 分位一半 —— 是统计判据而非拍脑袋。
# 实测：两个钢铁侠模型最大 |lat| 为 1.02 与 1.10，samurai 的刀为 2.25。
ACCESSORY_LAT = 1.5

PART_ORDER = ["helmet", "neck", "shoulder", "chest", "abdomen", "pelvis",
              "upper_arm", "forearm", "hand", "thigh", "shin", "foot",
              "accessory", "body_shell", "base", "unknown"]


def robust_up_axis(parts):
    """用部件中心的 p5–p95 稳健跨度判定上方向轴，避免被地面/底座撑歪。"""
    C = np.array([p["center"] for p in parts])
    spread = np.percentile(C, 95, axis=0) - np.percentile(C, 5, axis=0)
    order = np.argsort(-spread)
    return int(order[0]), int(order[1]), spread


def flag_outliers(parts, up):
    """标记地面/底座与连体内衬。返回被标记的集合。"""
    horiz = [a for a in range(3) if a != up]
    max_horiz = np.array([max(p["size"][horiz[0]], p["size"][horiz[1]]) for p in parts])
    med_horiz = float(np.median(max_horiz))

    for p, mh in zip(parts, max_horiz):
        p["flag"] = None
        thickness = p["size"][up]
        if mh > 1e-12 and thickness / mh < BASE_FLATNESS and mh > BASE_SPREAD * med_horiz:
            p["flag"] = "base"

    kept = [p for p in parts if p["flag"] is None]
    if not kept:
        return
    lo = min(p["min"][up] for p in kept)
    hi = max(p["max"][up] for p in kept)
    H = max(hi - lo, 1e-9)
    for p in kept:
        if p["size"][up] <= SHELL_HEIGHT * H:
            continue
        bottom = (p["min"][up] - lo) / H
        top = (p["max"][up] - lo) / H
        # 必须同时贴底和贴顶，才算覆盖整个人形，而不是一条长腿或一把刀
        if bottom < SHELL_BOTTOM and top > SHELL_TOP:
            p["flag"] = "body_shell"


PAIR_H_TOL = 0.06   # 镜像对允许的高度差


def pair_symmetry(parts, up, lat):
    """把左右镜像的部件强制归为同一部位，消除分档边界与横向阈值抖动。

    指纹用三角面数：镜像不改变拓扑，所以镜像件的面数完全相同，
    比尺寸更可靠（非对称姿态下左右尺寸会有差异）。
    """
    def sig(p):
        return (p["tris"], round(p["h"] / PAIR_H_TOL))

    buckets = {}
    for p in parts:
        if p["flag"] or abs(p["lat"]) < SIDE_CUTOFF or p["tris"] < 8:
            continue
        for k in (sig(p), (p["tris"], round(p["h"] / PAIR_H_TOL) - 1)):
            buckets.setdefault(k, []).append(p)

    fixed, done = 0, set()
    for group in buckets.values():
        if len(group) != 2:
            continue
        a, b = group
        key = tuple(sorted((a["node"], b["node"])))
        if key in done:
            continue
        if a["lat"] * b["lat"] >= 0:      # 同侧，不是镜像对
            continue
        if a["part"] == b["part"]:
            continue
        # 胜出规则：优先采信有材质语义证据的一方；都没有则取 |lat| 更大者
        ha = a.get("material_hint") == a["part"]
        hb = b.get("material_hint") == b["part"]
        if ha != hb:
            win = a if ha else b
        else:
            win = a if abs(a["lat"]) > abs(b["lat"]) else b
        lose = b if win is a else a
        lose["part"] = win["part"]
        lose["paired_with"] = win["name"]
        lose["review"] = None
        done.add(key)
        fixed += 1
    return fixed


def classify(parts, up, lat):
    kept = [p for p in parts if p["flag"] is None]
    ref = kept or parts
    lo = min(p["min"][up] for p in ref)
    hi = max(p["max"][up] for p in ref)
    h_span = max(hi - lo, 1e-9)

    lat_c = float(np.median([p["center"][lat] for p in ref]))
    dev = np.abs(np.array([p["center"][lat] for p in ref]) - lat_c)
    half_w = max(float(np.percentile(dev, 95)), 1e-9)

    allmin = np.min([p["min"] for p in ref], axis=0)
    allmax = np.max([p["max"] for p in ref], axis=0)
    body_center = (allmin + allmax) / 2.0
    body_center[lat] = lat_c

    for p in parts:
        p["h"] = round(float((p["center"][up] - lo) / h_span), 4)
        p["lat"] = round(float((p["center"][lat] - lat_c) / half_w), 4)

        if p["flag"] is None and abs(p["lat"]) > ACCESSORY_LAT:
            p["flag"] = "accessory"      # 横向离群：不属于人形本体
        if p["flag"]:
            p["part"] = p["flag"]
            p["side"] = ("L" if p["lat"] < -SIDE_CUTOFF
                         else ("R" if p["lat"] > SIDE_CUTOFF else "C"))
        else:
            p["part"] = "unknown"
            for b_lo, b_hi, central, lateral in BANDS:
                if b_lo <= p["h"] < b_hi:
                    p["part"] = lateral if abs(p["lat"]) > LATERAL_CUTOFF else central
                    break
            p["side"] = ("L" if p["lat"] < -SIDE_CUTOFF
                         else ("R" if p["lat"] > SIDE_CUTOFF else "C"))

        d = p["center"] - body_center
        n = np.linalg.norm(d)
        p["explode_dir"] = [round(float(x), 4) for x in (d / n if n > 1e-9 else np.zeros(3))]

    return body_center, allmin, allmax


# 材质名语义映射：部分模型的材质是按身体部位命名的，比位置判定更可信
MATERIAL_HINTS = [
    ("legs_down", "shin"),
    ("forearm",   "forearm"),
    ("pelvis",    "pelvis"),
    ("torsi",     "chest"),
    ("torso",     "chest"),
    ("helmet",    "helmet"),
    ("face",      "helmet"),
    ("feet",      "foot"),
    ("foot",      "foot"),
    ("boot",      "foot"),
    ("legs",      "thigh"),
    ("thigh",     "thigh"),
    ("shoulder",  "shoulder"),
    ("hand",      "hand"),
    ("chest",     "chest"),
    ("abdomen",   "abdomen"),
    ("neck",      "neck"),
]
EMISSIVE_KEYS = ("light", "glow", "emissive", "reactor", "eye")


def material_semantics(g, parts):
    """按三角面占比取每个节点的主材质，映射出语义提示与发光标记。"""
    mats = [m.get("name", "") or "" for m in g.get("materials", [])]
    meshes = g.get("meshes", [])
    nodes = g.get("nodes", [])
    hits = 0
    for p in parts:
        mesh = meshes[nodes[p["node"]]["mesh"]]
        by_mat = {}
        for pr in mesh.get("primitives", []):
            mi = pr.get("material")
            if mi is None:
                continue
            ia = pr.get("indices")
            n = g["accessors"][ia]["count"] // 3 if ia is not None else 1
            by_mat[mi] = by_mat.get(mi, 0) + n
        p["material"] = None
        p["material_hint"] = None
        p["emissive"] = False
        if not by_mat:
            continue
        mi = max(by_mat, key=by_mat.get)
        name = mats[mi] if mi < len(mats) else ""
        p["material"] = name
        low = name.lower()
        if any(k in low for k in EMISSIVE_KEYS):
            p["emissive"] = True
        for key, part in MATERIAL_HINTS:
            if key in low:
                p["material_hint"] = part
                hits += 1
                break
    return hits


# 每个部位标签的合理高度区间（由 BANDS 归并而来），用于校验材质提示是否可信
EXPECTED_H = {
    "helmet": (0.90, 1.01), "neck": (0.84, 0.90), "shoulder": (0.78, 0.90),
    "chest": (0.68, 0.84), "abdomen": (0.57, 0.68), "pelvis": (0.46, 0.57),
    "upper_arm": (0.57, 0.78), "forearm": (0.46, 0.57), "hand": (0.24, 0.46),
    "thigh": (0.24, 0.46), "shin": (0.09, 0.24), "foot": (-0.01, 0.09),
}
H_TOLERANCE = 0.08   # 材质提示允许偏离合理区间的幅度


def apply_material_hints(parts):
    """材质名只作为佐证：与位置相容时采纳（用于消解肢体/躯干歧义），
    高度上明显冲突时不采纳，记入待复核 —— 建模者复用材质很常见。"""
    applied, conflicts = [], []
    for p in parts:
        hint = p.get("material_hint")
        if p["flag"] or not hint or hint == p["part"]:
            continue
        lo, hi = EXPECTED_H.get(hint, (-9, 9))
        if lo - H_TOLERANCE <= p["h"] <= hi + H_TOLERANCE:
            applied.append((p, p["part"]))
            p["part"] = hint
            p["review"] = None
        else:
            p["review"] = (f"材质 {p['material']!r} 指向 {hint}"
                           f"（合理高度 {lo:.2f}–{hi:.2f}），但实际 h={p['h']:.2f}"
                           f"，位置判定为 {p['part']}")
            conflicts.append(p)
    return applied, conflicts


AMBIGUITY_VOLUME_RATIO = 8.0   # 组内体积超过中位数此倍数 -> 标为待复核


def flag_ambiguous(parts):
    """组内体积异常大的部件很可能被错分（如大腿被判成手指），标记待复核。"""
    groups = {}
    for p in parts:
        if p["flag"]:
            continue
        groups.setdefault(p["part"], []).append(p)
    review = []
    for nm, gp in groups.items():
        if len(gp) < 4:          # 组太小，中位数不可靠
            continue
        vols = np.array([max(float(np.prod(q["size"])), 1e-12) for q in gp])
        med = float(np.median(vols))
        for q, v in zip(gp, vols):
            if v > AMBIGUITY_VOLUME_RATIO * med:
                q["review"] = f"体积为 {nm} 组中位数的 {v/med:.0f} 倍"
                review.append(q)
    return review


def apply_overrides(parts, path):
    """读取人工覆盖表 <manifest>.overrides.json: {"节点索引或名字": "部位[:L|R|C]"}"""
    if not path.exists():
        return 0
    try:
        ov = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"覆盖表解析失败 {path}: {e}")
    by_node = {str(p["node"]): p for p in parts}
    by_name = {}
    for p in parts:
        by_name.setdefault(p["name"], []).append(p)

    n = 0
    for key, val in ov.items():
        if key.startswith("_"):      # 以 _ 开头的键是注释
            continue
        targets = []
        if key in by_node:
            targets = [by_node[key]]
        elif key in by_name:
            targets = by_name[key]
        else:
            print(f"  [警告] 覆盖表里的 {key!r} 在模型中找不到，已忽略")
            continue
        part, _, side = str(val).partition(":")
        for t in targets:
            t["part"] = part
            if side:
                t["side"] = side
            t["review"] = None
            t["overridden"] = True
            n += 1
    return n


AXIS_NAME = "xyz"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gltf")
    ap.add_argument("--up", default="auto", choices=["auto", "x", "y", "z"])
    ap.add_argument("--out", default=None)
    ap.add_argument("--list", action="store_true", help="逐个列出所有部件")
    a = ap.parse_args()

    path = pathlib.Path(a.gltf)
    if not path.exists():
        sys.exit(f"文件不存在: {path}")
    g, bufs = load_gltf(path)
    parts, skipped = collect(g, bufs)
    if not parts:
        sys.exit("没有解析出任何带包围盒的网格节点")

    auto_up, auto_lat, spread = robust_up_axis(parts)
    up = auto_up if a.up == "auto" else AXIS_NAME.index(a.up)
    lat = auto_lat if up == auto_up else [i for i in np.argsort(-spread) if i != up][0]

    flag_outliers(parts, up)
    body_center, allmin, allmax = classify(parts, up, lat)
    for q in parts:
        q.setdefault("review", None)
    mat_hits = material_semantics(g, parts)
    mat_applied, mat_conflicts = apply_material_hints(parts)
    paired = pair_symmetry(parts, up, lat)
    review = flag_ambiguous(parts)

    out = pathlib.Path(a.out) if a.out else pathlib.Path("assets/manifests") / (path.parent.name + ".json")
    ov_path = out.with_suffix(".overrides.json")
    n_ov = apply_overrides(parts, ov_path)

    kept = [p for p in parts if p["flag"] is None]
    flagged = [p for p in parts if p["flag"]]
    span = allmax - allmin

    print(f"文件      : {path}")
    print(f"网格节点  : {len(parts)}  (跳过 {len(skipped)} 个无 POSITION min/max)")
    print(f"上方向轴  : {AXIS_NAME[up]}   横向轴: {AXIS_NAME[lat]}"
          + ("  (稳健跨度自动判定)" if a.up == "auto" else "  (手动指定)"))
    print(f"稳健跨度  : x={spread[0]:.2f} y={spread[1]:.2f} z={spread[2]:.2f}")
    print(f"参考尺寸  : x={span[0]:.2f} y={span[1]:.2f} z={span[2]:.2f}  (已剔除异常节点)")
    print(f"总三角面  : {sum(p['tris'] for p in parts):,}"
          + (f"  其中异常节点占 {sum(p['tris'] for p in flagged):,}" if flagged else ""))
    if paired:
        print(f"对称修正  : {paired} 对镜像部件被强制归为同一部位")
    emis = [q for q in parts if q.get("emissive")]
    if mat_hits:
        print(f"材质语义  : {mat_hits} 个部件的材质名含部位信息"
              f" -> 采纳 {len(mat_applied)} 个，高度冲突拒绝 {len(mat_conflicts)} 个")
    if emis:
        print(f"发光部件  : {len(emis)} 个 ({', '.join(sorted({q['material'] for q in emis}))})")
    if n_ov:
        print(f"人工覆盖  : {n_ov} 个部件来自 {ov_path.name}")
    if flagged:
        print(f"异常节点  : {len(flagged)} 个")
        for p in flagged:
            print(f"    [{p['flag']}] {p['name'][:28]:<28} size={[round(float(x),1) for x in p['size']]} tris={p['tris']:,}")
    print()

    groups = {}
    for p in parts:
        groups.setdefault(p["part"], []).append(p)
    print(f"{'部位':<12}{'数量':>5}{'左':>5}{'中':>5}{'右':>5}{'三角面':>10}   高度区间")
    print("-" * 68)
    for nm in PART_ORDER:
        if nm not in groups:
            continue
        gp = groups[nm]
        L = sum(1 for q in gp if q["side"] == "L")
        R = sum(1 for q in gp if q["side"] == "R")
        C = len(gp) - L - R
        hs = [q["h"] for q in gp]
        print(f"{nm:<12}{len(gp):>5}{L:>5}{C:>5}{R:>5}{sum(q['tris'] for q in gp):>10,}"
              f"   {min(hs):.2f}–{max(hs):.2f}")
    print("-" * 68)
    print(f"{'可用部件':<12}{len(kept):>5}")

    pending = [q for q in parts if q.get("review")]
    if pending:
        print(f"\n待人工复核 {len(pending)} 个（组内体积异常，很可能错分）:")
        for q in sorted(pending, key=lambda x: -float(np.prod(x["size"]))):
            print(f"  node {q['node']:>4}  {q['name'][:16]:<16} 当前判定={q['part']:<10}{q['side']}"
                  f"  h={q['h']:<7} lat={q['lat']:<8} tris={q['tris']:>6}")
            print(f"        {q['review']}")
        print(f"\n  修正方式：在 {ov_path} 写入 {{\"<node索引>\": \"<部位>:<L|R|C>\"}}")

    if a.list:
        print()
        for p in sorted(parts, key=lambda q: -q["h"]):
            print(f"  {p['name'][:14]:<14} h={p['h']:<7} lat={p['lat']:<8} "
                  f"{p['part']:<11}{p['side']}  tris={p['tris']:>6}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "source": str(path),
        "upAxis": AXIS_NAME[up],
        "latAxis": AXIS_NAME[lat],
        "bodyCenter": [round(float(x), 5) for x in body_center],
        "bounds": {"min": [round(float(x), 5) for x in allmin],
                   "max": [round(float(x), 5) for x in allmax]},
        "skipped": skipped,
        "usableParts": len(kept),
        "parts": [{
            "node": p["node"], "name": p["name"], "part": p["part"], "side": p["side"],
            "flag": p["flag"], "h": p["h"], "lat": p["lat"], "tris": p["tris"],
            "center": [round(float(x), 5) for x in p["center"]],
            "size": [round(float(x), 5) for x in p["size"]],
            "explodeDir": p["explode_dir"],
            **({"review": p["review"]} if p.get("review") else {}),
            **({"overridden": True} if p.get("overridden") else {}),
            "material": p.get("material"),
            **({"emissive": True} if p.get("emissive") else {}),
            **({"pairedWith": p["paired_with"]} if p.get("paired_with") else {}),
        } for p in sorted(parts, key=lambda q: -q["h"])],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nmanifest -> {out}")
    if skipped:
        print(f"跳过的节点: {', '.join(skipped[:10])}{' ...' if len(skipped) > 10 else ''}")


if __name__ == "__main__":
    main()
