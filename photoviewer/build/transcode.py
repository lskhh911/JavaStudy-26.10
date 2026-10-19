"""
视频转码 / 封面生成
===================
1) 实况照片的视频 → cache/live/<图片id>.mp4（统一 H.264，浏览器可直接播放）
2) 独立 HEVC 视频 → cache/live/<视频id>.mp4
3) 独立视频封面  → cache/poster/<id>.jpg

依赖 tools/ffmpeg 下的 ffmpeg.exe（或 PATH 中的 ffmpeg）。
可重复运行，已存在的产物会跳过。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS = os.environ.get("PHOTOS_DIR") or r"D:\老电脑里的\icloud\photos"
CACHE = os.path.join(ROOT, "cache")

CREATE_NO_WINDOW = 0x08000000


def find_ffmpeg() -> str:
    env = os.environ.get("FFMPEG")
    if env and os.path.isfile(env):
        return env
    here = os.path.join(ROOT, "tools")
    for dirpath, _dirs, files in os.walk(here):
        for f in files:
            if f.lower() == "ffmpeg.exe":
                return os.path.join(dirpath, f)
    found = shutil.which("ffmpeg")
    if found:
        return found
    sys.exit("找不到 ffmpeg.exe，请放到 tools/ 下或设置环境变量 FFMPEG")


FFMPEG = None
THREADS = 2

# 长边限制在 1440（横竖屏都适用）
SCALE_LIVE = (
    "scale=w='if(gte(iw,ih),min(1440,iw),-2)':h='if(gte(iw,ih),-2,min(1440,ih))'"
)
SCALE_POSTER = "scale=w='min(1280,iw)':h=-2"


def run(cmd: list[str], timeout: int = 180) -> tuple[int, str]:
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return p.returncode, p.stdout.decode("utf-8", "ignore")
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def out_live(rel_id: str) -> str:
    return os.path.join(CACHE, "live", rel_id + ".mp4")


def out_poster(rel_id: str) -> str:
    return os.path.join(CACHE, "poster", rel_id + ".jpg")


def transcode_live(rel_id: str, src_rel: str, force: bool = False) -> str:
    dst = out_live(rel_id)
    if not force and os.path.exists(dst) and os.path.getsize(dst) > 512:
        return "skip"
    src = os.path.join(PHOTOS, src_rel.replace("/", os.sep))
    if not os.path.exists(src):
        return f"ERR missing {src_rel}"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    cmd = [
        FFMPEG, "-nostdin", "-y", "-loglevel", "error",
        "-i", src,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", SCALE_LIVE,
        "-threads", str(THREADS),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        "-f", "mp4", dst,
    ]
    rc, out = run(cmd)
    if rc != 0 or not os.path.exists(dst) or os.path.getsize(dst) < 512:
        if os.path.exists(dst):
            try:
                os.remove(dst)
            except OSError:
                pass
        return f"ERR live {rel_id}: {out.strip()[:200]}"
    return "ok"


def make_poster(rel_id: str, force: bool = False) -> str:
    dst = out_poster(rel_id)
    if not force and os.path.exists(dst) and os.path.getsize(dst) > 512:
        return "skip"
    src = os.path.join(PHOTOS, rel_id.replace("/", os.sep))
    if not os.path.exists(src):
        return f"ERR missing {rel_id}"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    for ss in ("0.6", "0.15", "0"):
        cmd = [
            FFMPEG, "-nostdin", "-y", "-loglevel", "error",
            "-ss", ss, "-i", src, "-frames:v", "1",
            "-vf", SCALE_POSTER, "-q:v", "4", dst,
        ]
        rc, out = run(cmd, timeout=120)
        if rc == 0 and os.path.exists(dst) and os.path.getsize(dst) > 512:
            return "ok"
    return f"ERR poster {rel_id}"


def write_progress(done, total, phase, t0):
    try:
        with open(os.path.join(CACHE, "progress.json"), "w", encoding="utf-8") as f:
            json.dump({"phase": phase, "done": done, "total": total, "elapsed": round(time.time() - t0, 1)}, f)
    except OSError:
        pass


def main():
    global FFMPEG, THREADS
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) // 2))
    ap.add_argument("--threads", type=int, default=2, help="单个 ffmpeg 进程的线程数")
    ap.add_argument("--only", choices=["live", "poster"], default=None)
    a = ap.parse_args()
    FFMPEG = find_ffmpeg()
    THREADS = a.threads
    print(f"[transcode] ffmpeg = {FFMPEG}")
    print(f"[transcode] 并发 {a.workers} × 线程 {a.threads}（CPU {os.cpu_count()}）")

    with open(os.path.join(CACHE, "jobs.json"), encoding="utf-8") as f:
        jobs = json.load(f)

    t0 = time.time()
    errs = []

    if a.only in (None, "poster"):
        posters = jobs.get("poster", [])
        print(f"[poster] {len(posters)} 个封面任务", flush=True)
        done = 0
        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            for res in pool.map(lambda i: make_poster(i, a.force), posters):
                done += 1
                if res not in ("ok", "skip"):
                    errs.append(res)
        write_progress(done, len(posters), "视频封面", t0)
        print(f"[poster] 完成 {done}，错误 {len(errs)}")

    if a.only in (None, "live"):
        live_jobs = list(jobs.get("live", []))
        for vid in jobs.get("video_transcode", []):
            live_jobs.append({"id": vid, "src": vid})
        total = len(live_jobs)
        print(f"[live] {total} 个视频转码任务，{a.workers} 线程", flush=True)
        done = 0
        errs = []

        def work(job):
            return transcode_live(job["id"], job["src"], a.force)

        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            for res in pool.map(work, live_jobs):
                done += 1
                if res not in ("ok", "skip"):
                    errs.append(res)
                if done % 200 == 0 or done == total:
                    el = time.time() - t0
                    print(f"  {done}/{total}  {done / max(el, 1e-6):.1f} it/s  错误 {len(errs)}", flush=True)
                    write_progress(done, total, "实况视频", t0)
        write_progress(total, total, "全部完成", t0)
        print(f"[live] 完成 {done}，错误 {len(errs)}，用时 {time.time() - t0:.1f}s")
        for e in errs[:20]:
            print("   ", e)


if __name__ == "__main__":
    main()
