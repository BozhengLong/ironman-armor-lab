#!/usr/bin/env python3
"""汇总所有模型的元数据，输出 assets/manifests/index.json。

页面据此渲染模型清单，不再把模型名写死在前端。

用法: python3 scripts/build_index.py
"""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from fetch_models import MODELS

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAN = ROOT / "assets" / "manifests"

# 展示用的短名与副标题，按需覆盖 MODELS 里的原始标题
DISPLAY = {
    "hulkbuster": ("HULKBUSTER", "MARK 44"),
    "ironman":    ("IRON MAN",   "MARK VI"),
    "samurai":    ("SAMURAI",    "MECH FRAME"),
}


def main() -> int:
    out = []
    for slug, meta in MODELS.items():
        mp = MAN / f"{slug}.json"
        ep = MAN / f"{slug}.explode.json"
        if not mp.exists():
            print(f"[skip] {slug}: 缺 {mp.name}，先跑 analyze_parts.py")
            continue
        man = json.loads(mp.read_text(encoding="utf-8"))
        groups = 0
        if ep.exists():
            groups = len(json.loads(ep.read_text(encoding="utf-8")).get("groups", {}))
        name, sub = DISPLAY.get(slug, (slug.upper(), ""))
        out.append({
            "slug": slug, "name": name, "subtitle": sub,
            "parts": man["usableParts"],
            "groups": groups,
            "tris": sum(p["tris"] for p in man["parts"]),
            "author": meta["author"], "license": meta["license"], "source": meta["url"],
            "preview": f"./assets/previews/{slug}.jpg",
        })
    out.sort(key=lambda m: -m["parts"])
    (MAN / "index.json").write_text(
        json.dumps({"models": out}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"index.json -> {len(out)} 个模型")
    for m in out:
        print(f"  {m['slug']:<12} {m['name']:<12} {m['parts']:>4} 件 / {m['groups']:>3} 组"
              f" / {m['tris']:>8,} 面")
    return 0


if __name__ == "__main__":
    sys.exit(main())
