#!/usr/bin/env python3
"""从 Sketchfab 下载模型的 glTF 包并解压到 assets/raw/<slug>/。

## 为什么 assets/raw/ 不入 git

那些文件不是源码，是本脚本从 Sketchfab 拉取的下载缓存。给缓存做版本控制
在原理上就是错的，与体积无关。仓库里改为提交 assets/assets.lock.json ——
逐文件的 sha256 与字节数，使重建可验证。

锁文件保证的是「完整性」（拿到的字节和当初一致），不保证「可用性」
（上游模型可能被删除或改授权）。所以另外做一份仓库外的私人备份。

## 需要 Sketchfab API token

按优先级读取：
  1. 环境变量 SKETCHFAB_TOKEN
  2. ~/.sketchfab_token 文件
获取地址：https://sketchfab.com/settings/password

## 用法

    python3 scripts/fetch_models.py                  # 下载缺失的，并按锁文件校验
    python3 scripts/fetch_models.py ironman          # 只下指定模型
    python3 scripts/fetch_models.py --verify         # 只校验本地文件，不下载
    python3 scripts/fetch_models.py --relock         # 上游确实变了，重写锁文件
"""
import argparse, hashlib, json, os, pathlib, sys, urllib.error, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "assets" / "raw"
LOCK = ROOT / "assets" / "assets.lock.json"

# 署名字段以 Sketchfab v3 接口为准（GET /v3/models/<uid> 的 user.displayName /
# user.profileUrl / license.url）。CC-BY 要求按作者「指定的方式」署名，
# Sketchfab 页面上显示的是 displayName 而不是 username —— 早期这里记的是
# username，站点署名与上游显示不一致，已更正。
MODELS = {
    "hulkbuster": {
        "uid": "11645b0747db4e9bbe4f56568802e01a",
        "title": "Iron Man",
        # 上游标题就叫 Iron Man，但模型实为 Mark 44 Hulkbuster。
        # 署名必须用上游标题原文，这条注记只用于我们自己的展示名。
        "note": "实为 Mark 44 Hulkbuster",
        "author": "o0ozexo0o",
        "author_url": "https://sketchfab.com/dadndan0091",
        "url": "https://sketchfab.com/3d-models/iron-man-11645b0747db4e9bbe4f56568802e01a",
        "license": "CC-BY-4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
    },
    # 第三个模型：用于检验整套管线在「没调过参」的数据上是否成立。
    # 选它的理由：35 个独立命名节点（class C）、命名是 Maya 默认的 polySurfaceNNN
    # 不含语义、风格与前两者迥异，且带两把刀 —— 人体计划之外的物件是好的压力测试。
    "samurai": {
        "uid": "43cfb1207bc046b89a106e740f2f826e",
        "title": "High Poly Samurai Mech",
        "note": "",
        "author": "Johnny Kaddissi",
        "author_url": "https://sketchfab.com/johnnykaddissi",
        "url": "https://sketchfab.com/3d-models/high-poly-samurai-mech-43cfb1207bc046b89a106e740f2f826e",
        "license": "CC-BY-4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
    },
    "ironman": {
        "uid": "1a21e1b8f2844956a30d28838d5f816a",
        "title": "Iron Man",
        "note": "",
        "author": "Vfx Boy",
        "author_url": "https://sketchfab.com/saini.hitesh16061980",
        "url": "https://sketchfab.com/3d-models/iron-man-1a21e1b8f2844956a30d28838d5f816a",
        "license": "CC-BY-4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
    },
}

# 锁文件只锁「来自上游的内容」。本脚本自己产出的文件必须排除 ——
# 否则改一次这些文件的文案，锁文件就对不上了：CI 全新下载会写出新文案，
# 而锁里存的是改动前那份的哈希。ATTRIBUTION.txt 正是这样踩过一次。
# license.txt 来自 Sketchfab 的压缩包，属于上游内容，保留在锁里。
SKIP_IN_LOCK = {".complete", "ATTRIBUTION.txt", "gltf.zip"}


def token() -> str:
    t = os.environ.get("SKETCHFAB_TOKEN", "").strip()
    if t:
        return t
    p = pathlib.Path.home() / ".sketchfab_token"
    if p.exists():
        return p.read_text().strip()
    sys.exit(
        "找不到 Sketchfab token。\n"
        "  1. 登录 https://sketchfab.com/settings/password 复制 API Token\n"
        "  2. printf '%s' '<TOKEN>' > ~/.sketchfab_token && chmod 600 ~/.sketchfab_token"
    )


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan(slug: str) -> dict:
    """返回 {相对路径: {sha256, size}}，路径分隔符统一为 /。"""
    d = RAW / slug
    out = {}
    for p in sorted(d.rglob("*")):
        if not p.is_file() or p.name in SKIP_IN_LOCK:
            continue
        rel = p.relative_to(d).as_posix()
        out[rel] = {"sha256": sha256(p), "size": p.stat().st_size}
    return out


def load_lock() -> dict:
    if not LOCK.exists():
        return {"models": {}}
    try:
        return json.loads(LOCK.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"锁文件解析失败 {LOCK}: {e}")


def save_lock(lock: dict) -> None:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    # 不写时间戳：保持文件确定性，便于 diff 与 review
    LOCK.write_text(json.dumps(lock, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")


def compare(expected: dict, actual: dict):
    """返回 (缺失, 多出, 不一致) 三个列表。"""
    missing = [k for k in expected if k not in actual]
    extra = [k for k in actual if k not in expected]
    changed = [k for k in expected
               if k in actual and actual[k]["sha256"] != expected[k]["sha256"]]
    return missing, extra, changed


def report(slug: str, missing, extra, changed) -> bool:
    if not (missing or extra or changed):
        return True
    print(f"[!!  ] {slug} 与锁文件不一致")
    for k in missing:
        print(f"        缺失: {k}")
    for k in changed:
        print(f"        内容变化: {k}")
    for k in extra:
        print(f"        锁文件中没有: {k}")
    return False


def verify(slug: str, lock: dict) -> bool:
    entry = lock["models"].get(slug)
    if entry is None:
        print(f"[skip] {slug} 锁文件里没有记录")
        return True
    if not (RAW / slug).exists():
        print(f"[!!  ] {slug} 本地不存在，需要先下载")
        return False
    ok = report(slug, *compare(entry["files"], scan(slug)))
    if ok:
        n = len(entry["files"])
        total = sum(f["size"] for f in entry["files"].values())
        print(f"[ok  ] {slug} {n} 个文件校验通过（{total/1_048_576:.1f} MB）")
    return ok


def get_json(url: str, tok: str):
    req = urllib.request.Request(url, headers={"Authorization": f"Token {tok}"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def attribution_text(meta: dict) -> str:
    """assets/raw/<slug>/ATTRIBUTION.txt 的内容。

    这份对应的是「未经改动的原始下载」。站点分发的是压缩过的版本，
    按 CC-BY 3(a)(1)(B) 必须额外声明有改动 —— 那份由 build_site.mjs 生成。
    """
    note = f"（{meta['note']}）" if meta.get("note") else ""
    return (
        f"{meta['title']}{note}\n"
        f"by {meta['author']}  {meta['author_url']}\n"
        f"{meta['url']}\n"
        f"License: {meta['license']}  {meta['license_url']}\n"
        f"Sketchfab uid: {meta['uid']}\n"
        "本目录内为未经改动的原始下载。\n\n"
        "注意：该资源的 CC-BY 标注由上传者自行声明，来源未经独立核实。\n"
        "调研发现 Sketchfab 上存在多个上传者把同一文件各自标为自己作品的情况。\n"
    )


def fetch(slug: str, meta: dict, tok: str) -> None:
    out = RAW / slug
    print(f"[get ] {slug} <- {meta['uid']}")
    try:
        links = get_json(f"https://api.sketchfab.com/v3/models/{meta['uid']}/download", tok)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        sys.exit(f"下载接口失败 {e.code}: {body}")
    if "gltf" not in links:
        sys.exit(f"{slug} 没有 gltf 下载项，可选：{list(links)}")

    out.mkdir(parents=True, exist_ok=True)
    zpath = out / "gltf.zip"
    print(f"       {links['gltf'].get('size', 0)/1_048_576:.1f} MB ...")
    urllib.request.urlretrieve(links["gltf"]["url"], zpath)

    with zipfile.ZipFile(zpath) as z:
        for n in z.namelist():          # 防目录穿越
            if n.startswith("/") or ".." in pathlib.PurePosixPath(n).parts:
                sys.exit(f"压缩包内有可疑路径：{n}")
        z.extractall(out)
    zpath.unlink()

    (out / "ATTRIBUTION.txt").write_text(attribution_text(meta), encoding="utf-8")
    (out / ".complete").touch()
    print(f"[ok  ] {slug} -> {out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="*", help="要处理的模型，默认全部")
    ap.add_argument("--verify", action="store_true", help="只校验本地文件，不下载")
    ap.add_argument("--relock", action="store_true", help="用当前本地文件重写锁文件")
    ap.add_argument("--force", action="store_true", help="即使已存在也重新下载")
    ap.add_argument("--reattribute", action="store_true",
                    help="只按当前元数据重写 ATTRIBUTION.txt，不重新下载")
    a = ap.parse_args()

    want = a.models or list(MODELS)
    for slug in want:
        if slug not in MODELS:
            sys.exit(f"未知模型 {slug}，可选：{list(MODELS)}")

    if a.reattribute:
        # ATTRIBUTION.txt 由本脚本生成、且在 SKIP_IN_LOCK 里，改元数据不会自动同步到
        # 已下载的目录。用这个开关刷新，免得为了改一行署名重下 145 MB。
        n = 0
        for slug in want:
            d = RAW / slug
            if not (d / ".complete").exists():
                print(f"[skip] {slug}: 未下载")
                continue
            (d / "ATTRIBUTION.txt").write_text(attribution_text(MODELS[slug]), encoding="utf-8")
            print(f"[ok  ] {slug}/ATTRIBUTION.txt 已重写")
            n += 1
        return 0 if n else 1

    lock = load_lock()

    if a.verify:
        allok = all(verify(slug, lock) for slug in want)
        if not allok:
            print("\n校验失败。若确认上游资源已变更，用 --relock 重写锁文件。")
        return 0 if allok else 1

    tok = None
    dirty = False
    for slug in want:
        present = (RAW / slug / ".complete").exists()
        if present and not a.force and not a.relock:
            if not verify(slug, lock):
                print("      （如需重新下载：--force）")
                dirty = True
            continue
        if not a.relock:
            tok = tok or token()
            fetch(slug, MODELS[slug], tok)

        files = scan(slug)
        entry = lock["models"].get(slug)
        if entry and not a.relock:
            if not report(slug, *compare(entry["files"], files)):
                print("      上游内容与锁文件不符。确认无误后用 --relock 更新。")
                dirty = True
                continue
        lock["models"][slug] = {
            "uid": MODELS[slug]["uid"], "source": MODELS[slug]["url"],
            "author": MODELS[slug]["author"], "license": MODELS[slug]["license"],
            "files": files,
        }
        save_lock(lock)
        print(f"[lock] {slug} 已写入 {LOCK.relative_to(ROOT)}（{len(files)} 个文件）")

    return 1 if dirty else 0


if __name__ == "__main__":
    sys.exit(main())
