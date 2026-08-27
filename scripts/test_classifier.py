#!/usr/bin/env python3
"""分类器回归测试：合成一个人形 glTF，断言每个部件被正确归类。

运行: python3 scripts/test_classifier.py
"""
import json, pathlib, subprocess, sys, tempfile

# (节点名, x, y, z, 尺寸x, 尺寸y, 尺寸z, 期望部位, 期望左右)
FIXTURE = [
    ("helmet",     0.00, 1.70, 0.00, 0.20, 0.22, 0.24, "helmet",    "C"),
    ("faceplate",  0.00, 1.68, 0.10, 0.16, 0.16, 0.06, "helmet",    "C"),
    ("neck",       0.00, 1.56, 0.00, 0.12, 0.08, 0.12, "neck",      "C"),
    ("shoulder_L",-0.24, 1.48, 0.00, 0.18, 0.16, 0.20, "shoulder",  "L"),
    ("shoulder_R", 0.24, 1.48, 0.00, 0.18, 0.16, 0.20, "shoulder",  "R"),
    ("chest",      0.00, 1.36, 0.00, 0.38, 0.26, 0.22, "chest",     "C"),
    ("reactor",    0.00, 1.38, 0.12, 0.10, 0.10, 0.04, "chest",     "C"),
    ("upperarm_L",-0.30, 1.28, 0.00, 0.13, 0.30, 0.13, "upper_arm", "L"),
    ("upperarm_R", 0.30, 1.28, 0.00, 0.13, 0.30, 0.13, "upper_arm", "R"),
    ("abdomen",    0.00, 1.14, 0.00, 0.30, 0.20, 0.20, "abdomen",   "C"),
    ("forearm_L", -0.32, 0.98, 0.00, 0.11, 0.28, 0.11, "forearm",   "L"),
    ("forearm_R",  0.32, 0.98, 0.00, 0.11, 0.28, 0.11, "forearm",   "R"),
    ("pelvis",     0.00, 0.92, 0.00, 0.32, 0.18, 0.22, "pelvis",    "C"),
    ("hand_L",    -0.33, 0.76, 0.00, 0.10, 0.18, 0.10, "hand",      "L"),
    ("hand_R",     0.33, 0.76, 0.00, 0.10, 0.18, 0.10, "hand",      "R"),
    ("thigh_L",   -0.11, 0.62, 0.00, 0.17, 0.42, 0.19, "thigh",     "L"),
    ("thigh_R",    0.11, 0.62, 0.00, 0.17, 0.42, 0.19, "thigh",     "R"),
    ("shin_L",    -0.11, 0.28, 0.00, 0.14, 0.36, 0.16, "shin",      "L"),
    ("shin_R",     0.11, 0.28, 0.00, 0.14, 0.36, 0.16, "shin",      "R"),
    ("boot_L",    -0.11, 0.05, 0.04, 0.15, 0.10, 0.30, "foot",      "L"),
    ("boot_R",     0.11, 0.05, 0.04, 0.15, 0.10, 0.30, "foot",      "R"),
]


def build(path: pathlib.Path) -> None:
    nodes, meshes, accs = [], [], []
    for i, (nm, cx, cy, cz, sx, sy, sz, _p, _s) in enumerate(FIXTURE):
        accs.append({"componentType": 5126, "count": 8, "type": "VEC3",
                     "min": [-sx / 2, -sy / 2, -sz / 2],
                     "max": [sx / 2, sy / 2, sz / 2]})
        meshes.append({"name": nm, "primitives": [{"attributes": {"POSITION": i}}]})
        nodes.append({"name": nm, "mesh": i, "translation": [cx, cy, cz]})
    path.write_text(json.dumps({
        "asset": {"version": "2.0"}, "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "accessors": accs}))


def main() -> int:
    here = pathlib.Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        gltf, man = tmp / "scene.gltf", tmp / "manifest.json"
        build(gltf)
        r = subprocess.run([sys.executable, str(here / "analyze_parts.py"),
                            str(gltf), "--out", str(man)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stdout + r.stderr)
            return 1
        got = {p["name"]: (p["part"], p["side"])
               for p in json.loads(man.read_text())["parts"]}

    fails = []
    for f in FIXTURE:
        nm, want = f[0], (f[7], f[8])
        if got.get(nm) != want:
            fails.append(f"  {nm:<12} 期望 {want}  实际 {got.get(nm)}")

    if fails:
        print(f"FAIL {len(fails)}/{len(FIXTURE)}")
        print("\n".join(fails))
        return 1
    print(f"PASS  {len(FIXTURE)}/{len(FIXTURE)} 个部件分类正确")
    return 0


if __name__ == "__main__":
    sys.exit(main())
