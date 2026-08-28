#!/usr/bin/env python3
"""把 assets/raw/ 打包成仓库外备份，并验证它确实能还原。

## 为什么需要它

assets/raw/ 不入库，靠 fetch_models.py 从 Sketchfab 重新下载。
assets.lock.json 保证的是**完整性**（拿到的字节和当初一致），
不保证**可用性** —— 上游模型可能被删除或改授权。
这两个模型来源不明（同一份文件被多个账号各自标为自有作品），下架风险不低。

## 为什么要验证还原

没验证过能还原的备份不算备份。本脚本打完包会解到临时目录，
逐文件按锁文件核对 sha256，通过才认为备份成立。

## 用法

    python3 scripts/backup_assets.py --out ~/Dropbox/backups
    python3 scripts/backup_assets.py --list ~/Dropbox/backups
    python3 scripts/backup_assets.py --restore <归档路径>
"""
import argparse, datetime, hashlib, json, pathlib, shutil, sys, tarfile, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "assets" / "raw"
LOCK = ROOT / "assets" / "assets.lock.json"
PREFIX = "ironman-armor-lab-assets"


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_against_lock(root: pathlib.Path, lock: dict) -> list[str]:
    """按锁文件核对 root 下的资源，返回问题列表（空表示通过）。"""
    problems = []
    for slug, entry in lock["models"].items():
        d = root / slug
        if not d.is_dir():
            problems.append(f"{slug}: 目录缺失")
            continue
        for rel, info in entry["files"].items():
            f = d / rel
            if not f.exists():
                problems.append(f"{slug}/{rel}: 文件缺失")
            elif sha256(f) != info["sha256"]:
                problems.append(f"{slug}/{rel}: 校验和不符")
    return problems


def safe_extract(tar: tarfile.TarFile, dest: pathlib.Path) -> None:
    """防目录穿越的解包。"""
    dest = dest.resolve()
    for m in tar.getmembers():
        target = (dest / m.name).resolve()
        if not str(target).startswith(str(dest)):
            sys.exit(f"归档内有可疑路径：{m.name}")
        if m.issym() or m.islnk():
            sys.exit(f"归档内含链接，拒绝解包：{m.name}")
    # data 过滤器会拒绝绝对路径、目录穿越、设备文件与危险属性。
    # Python 3.14 起是默认行为，这里显式指定以消除版本差异。
    try:
        tar.extractall(dest, filter="data")
    except TypeError:          # Python < 3.12 没有 filter 参数
        tar.extractall(dest)


def do_backup(out_dir: pathlib.Path) -> int:
    if not LOCK.exists():
        sys.exit("找不到 assets.lock.json，先跑 fetch_models.py")
    lock = json.loads(LOCK.read_text(encoding="utf-8"))

    print("[1/4] 打包前先按锁文件核对本地资源")
    problems = check_against_lock(RAW, lock)
    if problems:
        print("      本地资源与锁文件不符，拒绝备份一份坏数据：")
        for p in problems[:10]:
            print(f"        {p}")
        return 1
    print("      通过")

    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.date.today().isoformat()
    archive = out_dir / f"{PREFIX}-{stamp}.tar.gz"

    print(f"[2/4] 打包 -> {archive}")
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(RAW, arcname="raw")
        tar.add(LOCK, arcname="assets.lock.json")   # 归档自带锁文件，可独立验证
    size = archive.stat().st_size
    print(f"      {size/1_048_576:.1f} MB")

    print("[3/4] 解到临时目录，验证真的能还原")
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        with tarfile.open(archive) as tar:
            safe_extract(tar, tmp)
        emb = json.loads((tmp / "assets.lock.json").read_text(encoding="utf-8"))
        problems = check_against_lock(tmp / "raw", emb)
        if problems:
            print("      还原验证失败：")
            for p in problems[:10]:
                print(f"        {p}")
            archive.unlink()
            print(f"      已删除不可信的归档 {archive}")
            return 1
        n = sum(len(e["files"]) for e in emb["models"].values())
        print(f"      {n} 个文件全部还原并校验通过")

    print("[4/4] 归档指纹")
    digest = sha256(archive)
    (out_dir / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")
    print(f"      sha256 {digest}")
    print(f"\n备份完成: {archive}")
    print("建议再放一份到不同介质（外接盘或另一家云），单点仍是单点。")
    return 0


def do_list(out_dir: pathlib.Path) -> int:
    items = sorted(out_dir.glob(f"{PREFIX}-*.tar.gz"))
    if not items:
        print(f"{out_dir} 下没有备份")
        return 1
    for f in items:
        side = f.with_suffix(f.suffix + ".sha256")
        ok = "?"
        if side.exists():
            ok = "✓" if side.read_text().split()[0] == sha256(f) else "✗ 指纹不符"
        print(f"  {f.name}  {f.stat().st_size/1_048_576:>6.1f} MB  {ok}")
    return 0


def do_restore(archive: pathlib.Path) -> int:
    if not archive.exists():
        sys.exit(f"归档不存在: {archive}")
    side = archive.with_suffix(archive.suffix + ".sha256")
    if side.exists():
        want = side.read_text().split()[0]
        if sha256(archive) != want:
            sys.exit("归档指纹不符，可能已损坏，拒绝还原")
        print("归档指纹校验通过")

    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        with tarfile.open(archive) as tar:
            safe_extract(tar, tmp)
        emb = json.loads((tmp / "assets.lock.json").read_text(encoding="utf-8"))
        problems = check_against_lock(tmp / "raw", emb)
        if problems:
            print("归档内容校验失败，拒绝还原：")
            for p in problems[:10]:
                print(f"  {p}")
            return 1
        if RAW.exists():
            shutil.rmtree(RAW)
        RAW.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp / "raw"), str(RAW))
        shutil.copy(tmp / "assets.lock.json", LOCK)
    print(f"已还原到 {RAW}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, help="备份目标目录")
    ap.add_argument("--list", type=pathlib.Path, metavar="DIR", help="列出目录下的备份")
    ap.add_argument("--restore", type=pathlib.Path, metavar="ARCHIVE", help="从归档还原")
    a = ap.parse_args()
    if a.restore:
        return do_restore(a.restore.expanduser())
    if a.list:
        return do_list(a.list.expanduser())
    if a.out:
        return do_backup(a.out.expanduser())
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
