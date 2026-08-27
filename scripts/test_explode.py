#!/usr/bin/env python3
"""爆炸规划回归测试。

最重要的一条是姿态无关性：同一套装甲，直立与弓身两种姿态下，
语义组的爆炸轴向必须一致。这是 group / groupSpread 模式的立论基础 ——
实测中它使前倾姿态的 hulkbuster 在爆炸态下呈现为直立技术图版。

运行: python3 scripts/test_explode.py
"""
import json, pathlib, subprocess, sys, tempfile
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import explode_plan as ep

# (名字, 部位, 左右, 中心xyz, 尺寸xyz)
STANDING = [
    ("helmet",     "helmet",   "C", (0.00, 1.70, 0.00), (0.20, 0.22, 0.24)),
    ("faceplate",  "helmet",   "C", (0.00, 1.68, 0.10), (0.16, 0.16, 0.06)),
    ("neck",       "neck",     "C", (0.00, 1.56, 0.00), (0.12, 0.08, 0.12)),
    ("shoulder_L", "shoulder", "L", (-0.24, 1.48, 0.00), (0.18, 0.16, 0.20)),
    ("shoulder_R", "shoulder", "R", (0.24, 1.48, 0.00), (0.18, 0.16, 0.20)),
    ("chest_out",  "chest",    "C", (0.00, 1.36, 0.06), (0.38, 0.26, 0.10)),
    ("chest_in",   "chest",    "C", (0.00, 1.36, -0.02), (0.34, 0.24, 0.08)),
    ("uarm_L",     "upper_arm","L", (-0.30, 1.28, 0.00), (0.13, 0.30, 0.13)),
    ("uarm_R",     "upper_arm","R", (0.30, 1.28, 0.00), (0.13, 0.30, 0.13)),
    ("abdomen",    "abdomen",  "C", (0.00, 1.14, 0.00), (0.30, 0.20, 0.20)),
    ("farm_L",     "forearm",  "L", (-0.32, 0.98, 0.00), (0.11, 0.28, 0.11)),
    ("farm_R",     "forearm",  "R", (0.32, 0.98, 0.00), (0.11, 0.28, 0.11)),
    ("pelvis",     "pelvis",   "C", (0.00, 0.92, 0.00), (0.32, 0.18, 0.22)),
    ("hand_L",     "hand",     "L", (-0.33, 0.76, 0.00), (0.10, 0.18, 0.10)),
    ("hand_R",     "hand",     "R", (0.33, 0.76, 0.00), (0.10, 0.18, 0.10)),
    ("thigh_L",    "thigh",    "L", (-0.11, 0.62, 0.00), (0.17, 0.42, 0.19)),
    ("thigh_R",    "thigh",    "R", (0.11, 0.62, 0.00), (0.17, 0.42, 0.19)),
    ("shin_L",     "shin",     "L", (-0.11, 0.28, 0.00), (0.14, 0.36, 0.16)),
    ("shin_R",     "shin",     "R", (0.11, 0.28, 0.00), (0.14, 0.36, 0.16)),
    ("boot_L",     "foot",     "L", (-0.11, 0.05, 0.06), (0.15, 0.10, 0.30)),
    ("boot_R",     "foot",     "R", (0.11, 0.05, 0.06), (0.15, 0.10, 0.30)),
]


def hunch(c):
    """把直立姿态改成弓身：上半身前倾下沉，越高的部位偏移越大。"""
    x, y, z = c
    t = max(y - 0.9, 0.0)          # 骨盆以上才前倾
    return (x, y - 0.35 * t, z + 0.75 * t)


def make_manifest(rows, poser=lambda c: c):
    parts = []
    for i, (name, part, side, c, s) in enumerate(rows):
        c = poser(c)
        parts.append({"node": i, "name": name, "part": part, "side": side,
                      "flag": None, "center": list(c), "size": list(s),
                      "material": "face" if name == "faceplate" else "iron",
                      "h": 0.0, "lat": 0.0})
    C = np.array([p["center"] for p in parts]); S = np.array([p["size"] for p in parts])
    lo = (C - S / 2).min(axis=0); hi = (C + S / 2).max(axis=0)
    return {"upAxis": "y", "latAxis": "x",
            "bodyCenter": ((lo + hi) / 2).tolist(),
            "bounds": {"min": lo.tolist(), "max": hi.tolist()},
            "parts": parts, "usableParts": len(parts)}


def run(man):
    height = man["bounds"]["max"][1] - man["bounds"]["min"][1]
    vecs, meta, groups = ep.plan(man, man["parts"], height)
    return vecs, meta, groups, height


def main():
    fails = []
    def check(cond, msg):
        if not cond:
            fails.append(msg)

    man = make_manifest(STANDING)
    vecs, meta, groups, height = run(man)
    by_name = {p["name"]: p["node"] for p in man["parts"]}
    G = vecs["group"]

    # --- 规范坐标系 ---
    check(meta["upSign"] == 1.0, f"上方向符号应为 +1，实为 {meta['upSign']}")
    check(meta["frontSign"] == 1.0,
          f"朝前符号应为 +1（faceplate 在 z 正向），实为 {meta['frontSign']}")

    # --- 方向正确性 ---
    check(G[by_name["helmet"]][1] > 0, "头盔应向上")
    check(G[by_name["boot_L"]][1] < 0, "靴子应向下")
    check(G[by_name["chest_out"]][2] > 0, "胸甲应向前")
    check(G[by_name["shoulder_L"]][0] < 0 < G[by_name["shoulder_R"]][0],
          "左右肩应分别朝各自外侧")
    check(G[by_name["hand_L"]][0] < G[by_name["farm_L"]][0]
          < G[by_name["uarm_L"]][0] < 0, "左臂应沿运动链由内向外递增位移")

    # --- 链式距离单调 ---
    chain = ["shoulder_L", "uarm_L", "farm_L", "hand_L"]
    mags = [float(np.linalg.norm(G[by_name[n]])) for n in chain]
    check(all(a < b for a, b in zip(mags, mags[1:])),
          f"手臂链位移应单调递增，实为 {[round(m,3) for m in mags]}")

    # --- group 模式：同组成员位移必须完全一致（刚体）---
    a, b = G[by_name["chest_out"]], G[by_name["chest_in"]]
    check(np.allclose(a, b), "group 模式下同组成员位移必须相同（刚体整块）")

    # --- groupSpread 模式：同组成员必须分开 ---
    sa = vecs["groupSpread"][by_name["chest_out"]]
    sb = vecs["groupSpread"][by_name["chest_in"]]
    check(not np.allclose(sa, sb), "groupSpread 模式下同组成员应分开")
    # 外层（z 更大）应走得更远
    check(np.linalg.norm(sa) > np.linalg.norm(sb),
          "groupSpread 应让外层壳走得更远（按远端角排秩）")

    # --- 固定件不动 ---
    man2 = make_manifest(STANDING)
    man2["parts"][0]["flag"] = "body_shell"
    v2, _, _, _ = run(man2)
    check(np.allclose(v2["group"][0], 0), "body_shell 应保持原位")

    # --- 核心性质：姿态无关性 ---
    manH = make_manifest(STANDING, poser=hunch)
    vH, metaH, _, _ = run(manH)
    check(metaH["frontSign"] == 1.0, "弓身姿态下朝前判定不应翻转")
    worst = 0.0
    for name, node in by_name.items():
        d1 = G[node]; d2 = vH["group"][node]
        n1, n2 = np.linalg.norm(d1), np.linalg.norm(d2)
        if n1 < 1e-9 or n2 < 1e-9:
            continue
        cos = float(np.dot(d1, d2) / (n1 * n2))
        worst = max(worst, 1.0 - cos)
        if cos < 0.999:
            fails.append(f"姿态无关性失败: {name} 的爆炸轴向随姿态变化 (cos={cos:.4f})")
    print(f"姿态无关性: 最大方向偏差 1-cos = {worst:.2e}")

    # --- 对照：radial 模式必然随姿态变化，证明上面那条不是空测试 ---
    drifted = 0
    for name, node in by_name.items():
        d1, d2 = vecs["radial"][node], vH["radial"][node]
        n1, n2 = np.linalg.norm(d1), np.linalg.norm(d2)
        if n1 < 1e-9 or n2 < 1e-9:
            continue
        if float(np.dot(d1, d2) / (n1 * n2)) < 0.999:
            drifted += 1
    check(drifted > 0,
          "对照失败：radial 模式本应随姿态漂移，若未漂移说明姿态变换没生效")
    print(f"对照 radial: {drifted}/{len(by_name)} 个部件的方向随姿态漂移")

    if fails:
        print(f"\nFAIL {len(fails)} 项")
        for f in fails:
            print("  " + f)
        return 1
    print(f"\nPASS  全部断言通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
