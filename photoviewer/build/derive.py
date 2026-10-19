"""
派生文件生成器
==============
根据 cache/jobs.json 生成：
  thumbs/<id>.jpg   网格缩略图（最长边 512）
  view/<id>.jpg     HEIC/HEIF 的浏览器可显示版本（最长边 3200）
  poster/<id>.jpg   视频封面

可重复运行，已存在的文件自动跳过（加 --force 覆盖）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS = os.environ.get("PHOTOS_DIR") or r"D:\老电脑里的\icloud\photos"
CACHE = os.path.join(ROOT, "cache")

THUMB_MAX = 512
VIEW_MAX = 3200

# 这些格式浏览器无法直接显示，查看时需要转换
NEEDS_CONVERT = {".heic", ".heif"}


def out_path(kind: str, rel_id: str) -> str:
    return os.path.join(CACHE, kind, rel_id + ".jpg")


def _save(im: Image.Image, dst: str, max_side: int, quality: int):
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "L"):
        # 处理 RGBA / P / LA / CMYK
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    im.save(tmp, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=1)
    os.replace(tmp, dst)


def make_thumb(rel_id: str, force: bool = False):
    dst = out_path("thumbs", rel_id)
    if not force and os.path.exists(dst):
        return "skip"
    src = os.path.join(PHOTOS, rel_id.replace("/", os.sep))
    try:
        with Image.open(src) as im:
            im.load()
            _save(im, dst, THUMB_MAX, 80)
        return "ok"
    except Exception as e:  # noqa: BLE001
        return f"ERR thumb {rel_id}: {type(e).__name__}: {e}"


def make_view(rel_id: str, force: bool = False):
    dst = out_path("view", rel_id)
    if not force and os.path.exists(dst):
        return "skip"
    src = os.path.join(PHOTOS, rel_id.replace("/", os.sep))
    try:
        with Image.open(src) as im:
            im.load()
            _save(im, dst, VIEW_MAX, 88)
        return "ok"
    except Exception as e:  # noqa: BLE001
        return f"ERR view {rel_id}: {type(e).__name__}: {e}"


def make_poster(rel_id: str, force: bool = False):
    """视频封面由 ffmpeg 生成（见 transcode.py），此处兜底用 Pillow 尝试。"""
    dst = out_path("poster", rel_id)
    if not force and os.path.exists(dst):
        return "skip"
    return "defer"


def _task(job):
    kind, rel_id, force = job
    if kind == "thumb":
        return make_thumb(rel_id, force)
    if kind == "view":
        return make_view(rel_id, force)
    return "noop"


def _write_progress(done, total, phase, t0):
    try:
        with open(os.path.join(CACHE, "progress.json"), "w", encoding="utf-8") as f:
            json.dump(
                {"phase": phase, "done": done, "total": total, "elapsed": round(time.time() - t0, 1)},
                f,
            )
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", choices=["thumb", "view"], default=None)
    ap.add_argument("--workers", type=int, default=min(14, os.cpu_count() or 4))
    a = ap.parse_args()

    with open(os.path.join(CACHE, "jobs.json"), encoding="utf-8") as f:
        jobs = json.load(f)

    tasks = []
    if a.only in (None, "thumb"):
        tasks += [("thumb", i, a.force) for i in jobs["thumb"]]
    if a.only in (None, "view"):
        tasks += [("view", i, a.force) for i in jobs["view"]]

    total = len(tasks)
    print(f"[derive] {total} 个任务，{a.workers} 进程", flush=True)
    t0 = time.time()
    done = err = skip = 0
    errors = []
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        for res in pool.map(_task, tasks, chunksize=8):
            done += 1
            if res == "skip":
                skip += 1
            elif res != "ok":
                err += 1
                if len(errors) < 40:
                    errors.append(res)
            if done % 250 == 0 or done == total:
                el = time.time() - t0
                print(f"  {done}/{total}  {done / el:.1f} it/s  错误 {err}", flush=True)
                _write_progress(done, total, "缩略图", t0)
    _write_progress(total, total, "缩略图完成", t0)
    print(f"[derive] 完成 {done}（跳过 {skip}，错误 {err}）用时 {time.time() - t0:.1f}s")
    for e in errors[:20]:
        print("   ", e)


if __name__ == "__main__":
    main()
