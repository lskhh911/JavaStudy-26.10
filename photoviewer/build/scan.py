"""
iCloud 照片库扫描器
===================
扫描 photos/YYYY/MM/DD 结构，把「静态图片 + 同名实况视频」合并为一条媒体记录，
提取 EXIF / 日期 / 尺寸信息，输出 cache/index.json 与 cache/jobs.json（派生任务清单）。

用法：
    python scan.py            # 扫描并写出 index.json + jobs.json
    python scan.py --stats    # 额外打印统计
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip install pillow")

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_OK = True
except ImportError:  # pragma: no cover
    HEIF_OK = False

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS = os.environ.get("PHOTOS_DIR") or r"D:\老电脑里的\icloud\photos"
CACHE = os.path.join(ROOT, "cache")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".gif", ".webp", ".bmp", ".avif", ".tif", ".tiff"}
VIDEO_EXT = {".mov", ".mp4", ".m4v"}

# 实况视频的几种命名变体 → 统一回图片基名
_HEVC_RE = re.compile(r"(?i)(_livephoto)?_hevc$")
_COPY_RE = re.compile(r"(?i)\(\d+\)$")


def normalize_video_base(base: str) -> str:
    b = _HEVC_RE.sub("", base)
    b = _COPY_RE.sub("", b)
    return b.strip()


def norm_name(name: str) -> str:
    return name.strip().lower()


# ---------------------------------------------------------------- EXIF helpers
def _rational(v):
    try:
        if isinstance(v, tuple) and len(v) == 2:
            return v[0] / v[1] if v[1] else None
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _parse_exif_dt(s: str):
    if not isinstance(s, str):
        return None
    s = s.strip().strip("\x00")
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt)
        except ValueError:
            continue
    return None


def _gps_to_deg(coord, ref):
    try:
        d, m, s = (_rational(x) or 0.0 for x in coord)
        val = d + m / 60.0 + s / 3600.0
        if isinstance(ref, bytes):
            ref = ref.decode("ascii", "ignore")
        if str(ref).upper().startswith(("S", "W")):
            val = -val
        return round(val, 6)
    except (TypeError, ValueError):
        return None


def read_meta(path: str, ext: str):
    """返回 dict：尺寸、EXIF 时间、相机、曝光、GPS。失败时返回最小信息。"""
    out = {
        "w": 0,
        "h": 0,
        "dt": None,      # 拍摄时间（秒级 ISO 字符串）
        "make": "",
        "model": "",
        "lens": "",
        "iso": None,
        "fnum": None,
        "expo": None,
        "focal": None,
        "gps": None,
    }
    if ext in (".heic", ".heif") and not HEIF_OK:
        return out
    try:
        with Image.open(path) as im:
            ow, oh = im.size
            out["w"], out["h"] = ow, oh
            try:
                ex = im.getexif()
            except Exception:
                return out
            if not ex:
                return out
            try:
                exif_ifd = ex.get_ifd(0x8769) or {}
            except Exception:
                exif_ifd = {}
            try:
                gps_ifd = ex.get_ifd(0x8825) or {}
            except Exception:
                gps_ifd = {}

            dt = (
                _parse_exif_dt(exif_ifd.get(0x9003))
                or _parse_exif_dt(ex.get(0x0132))
                or _parse_exif_dt(exif_ifd.get(0x9004))
            )
            if dt:
                # 亚秒（SubSecTimeOriginal）补足排序精度
                out["dt"] = dt.isoformat(timespec="seconds")

            out["make"] = (ex.get(0x010F) or "").strip() if isinstance(ex.get(0x010F), str) else ""
            out["model"] = (ex.get(0x0110) or "").strip() if isinstance(ex.get(0x0110), str) else ""
            lens = exif_ifd.get(0xA434) or ex.get(0xA434)
            out["lens"] = lens.strip() if isinstance(lens, str) else ""
            iso = exif_ifd.get(0x8827)
            if isinstance(iso, (list, tuple)):
                iso = iso[0] if iso else None
            out["iso"] = int(iso) if isinstance(iso, (int, float)) and iso else None
            out["fnum"] = _rational(exif_ifd.get(0x829D))
            out["expo"] = _rational(exif_ifd.get(0x829A))
            out["focal"] = _rational(exif_ifd.get(0x920A))

            lat = _gps_to_deg(gps_ifd.get(2), gps_ifd.get(1)) if gps_ifd.get(2) else None
            lon = _gps_to_deg(gps_ifd.get(4), gps_ifd.get(3)) if gps_ifd.get(4) else None
            if lat is not None and lon is not None and abs(lat) < 90 and abs(lon) < 180:
                out["gps"] = [lat, lon]
    except Exception:
        pass
    return out


# ------------------------------------------------------------ per-file worker
def inspect_file(args):
    path, ext = args
    try:
        st = os.stat(path)
    except OSError:
        return None
    meta = read_meta(path, ext)
    try:
        rel = os.path.relpath(path, PHOTOS).replace("\\", "/")
    except ValueError:
        return None
    meta.update(
        {
            "path": rel,
            "ext": ext,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
        }
    )
    return meta


def video_probe(path: str):
    """轻量解析 MOV/MP4：编码、时长、宽高。

    moov 可能在文件尾部（未做 faststart），所以头尾各读一段再拼接搜索。
    """
    info = {"codec": "?", "dur": None, "vw": 0, "vh": 0}
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(min(size, 4_000_000))
            tail = b""
            if size > 4_000_000:
                fh.seek(max(0, size - 4_000_000))
                tail = fh.read()
        data = head + tail
        for tag in ("hvc1", "hev1", "avc1", "av01", "vp09"):
            if tag.encode() in data:
                info["codec"] = "hevc" if tag in ("hvc1", "hev1") else "h264" if tag == "avc1" else tag
                break
        # mvhd 时长
        i = data.find(b"mvhd")
        if i > 0 and i + 40 < len(data):
            ver = data[i + 4]
            if ver == 0:
                ts = int.from_bytes(data[i + 16 : i + 20], "big")
                du = int.from_bytes(data[i + 20 : i + 24], "big")
            else:
                ts = int.from_bytes(data[i + 24 : i + 28], "big")
                du = int.from_bytes(data[i + 28 : i + 36], "big")
            if ts:
                d = du / ts
                info["dur"] = round(d, 2) if 0 < d < 3600 else None
        # stsd 采样尺寸
        j = data.find(b"avc1") if info["codec"] == "h264" else data.find(b"hvc1")
        if j < 0:
            j = data.find(b"avc1")
        if j > 0 and j + 32 < len(data):
            w = int.from_bytes(data[j + 28 : j + 30], "big")
            h = int.from_bytes(data[j + 30 : j + 32], "big")
            if 0 < w < 20000 and 0 < h < 20000:
                info["vw"], info["vh"] = w, h
    except OSError:
        pass
    return info


# ---------------------------------------------------------------------- scan
def scan(stats: bool = False):
    t0 = time.time()
    if not os.path.isdir(PHOTOS):
        sys.exit(f"找不到照片目录：{PHOTOS}")

    days = {}
    for dirpath, dirnames, filenames in os.walk(PHOTOS):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, PHOTOS)
        parts = [] if rel_dir == "." else rel_dir.split(os.sep)
        if len(parts) < 3:
            continue
        year, month, day = parts[0], parts[1], parts[2]
        if not (year.isdigit() and month.isdigit() and day.isdigit()):
            continue
        try:
            folder_dt = datetime(int(year), int(month), int(day))
        except ValueError:
            continue
        items = []
        for fn in sorted(filenames):
            ext = os.path.splitext(fn)[1].lower()
            if ext in IMAGE_EXT:
                items.append((os.path.join(dirpath, fn), ext, "img"))
            elif ext in VIDEO_EXT:
                items.append((os.path.join(dirpath, fn), ext, "vid"))
        if items:
            days[dirpath] = (folder_dt, items)

    total_files = sum(len(v[1]) for v in days.values())
    print(f"[scan] {len(days)} 天 / {total_files} 个文件，开始提取元数据…", flush=True)

    # 并行读取图片 EXIF
    tasks = [(p, e) for _, items in days.values() for p, e, k in items if k == "img"]
    metas = {}
    workers = min(16, max(2, (os.cpu_count() or 4)))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for i, m in enumerate(pool.map(inspect_file, tasks, chunksize=32), 1):
            if m:
                metas[m["path"]] = m
            if i % 2000 == 0:
                print(f"  … {i}/{len(tasks)}", flush=True)
    print(f"[scan] 元数据完成 {len(metas)} 张，用时 {time.time() - t0:.1f}s", flush=True)

    media = []
    by_id = {}
    live_pairs = 0
    orphan_videos = 0
    unreadable = []

    for dirpath, (folder_dt, items) in sorted(days.items()):
        rel_dir = os.path.relpath(dirpath, PHOTOS).replace("\\", "/")
        img_by_base = {}
        vids = []
        for path, ext, kind in items:
            base = os.path.splitext(os.path.basename(path))[0]
            if kind == "img":
                img_by_base.setdefault(norm_name(base), []).append(path)
            else:
                vids.append(path)

        used_imgs = set()
        for path, ext, kind in items:
            if kind != "img":
                continue
            rel = os.path.relpath(path, PHOTOS).replace("\\", "/")
            m = metas.get(rel)
            if m is None or not m["w"]:
                unreadable.append(rel)
            dt = None
            if m and m.get("dt"):
                try:
                    dt = datetime.fromisoformat(m["dt"])
                except ValueError:
                    dt = None
            if dt and abs((dt - folder_dt).total_seconds()) > 3 * 86400:
                dt = None  # EXIF 与目录日期严重不符 → 信任目录
            shot = dt or folder_dt
            rec = {
                "id": rel,
                "t": "img",
                "date": shot.strftime("%Y-%m-%d"),
                "ts": int(shot.timestamp()),
                "folder": rel_dir,
                "name": os.path.basename(path),
                "ext": ext,
                "size": m["size"] if m else 0,
                "w": m["w"] if m else 0,
                "h": m["h"] if m else 0,
            }
            if m:
                for k in ("make", "model", "lens", "iso", "fnum", "expo", "focal", "gps"):
                    if m.get(k):
                        rec[k] = m[k]
            media.append(rec)
            by_id[rel] = rec

        for vp in vids:
            base = os.path.splitext(os.path.basename(vp))[0]
            nbase = norm_name(normalize_video_base(base))
            still = None
            for cand in img_by_base.get(nbase, []):
                still = cand
                break
            vinfo = video_probe(vp)
            rel = os.path.relpath(vp, PHOTOS).replace("\\", "/")
            if still:
                # 挂到静态图记录上 → 实况照片
                srel = os.path.relpath(still, PHOTOS).replace("\\", "/")
                target = by_id.get(srel)
                if target is not None and not target.get("live"):
                    target["live"] = {
                        "path": rel,
                        "size": os.path.getsize(vp),
                        "dur": vinfo["dur"],
                        "codec": vinfo["codec"],
                    }
                    live_pairs += 1
                    continue
            orphan_videos += 1
            shot = folder_dt
            rec = {
                "id": rel,
                "t": "vid",
                "date": shot.strftime("%Y-%m-%d"),
                "ts": int(shot.timestamp()),
                "folder": rel_dir,
                "name": os.path.basename(vp),
                "ext": os.path.splitext(vp)[1].lower(),
                "size": os.path.getsize(vp),
                "w": vinfo["vw"],
                "h": vinfo["vh"],
                "dur": vinfo["dur"],
                "codec": vinfo["codec"],
            }
            media.append(rec)

    # 同一天内排序：优先 ts，其次文件名（IMG 序号）
    media.sort(key=lambda r: (r["date"], r["ts"], r["name"]))

    # 补齐相邻 id（用于前后翻页）
    for i, r in enumerate(media):
        r["i"] = i

    os.makedirs(CACHE, exist_ok=True)
    index = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "root": PHOTOS,
        "count": len(media),
        "items": media,
    }
    with open(os.path.join(CACHE, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"), default=str)

    jobs = build_jobs(media)
    with open(os.path.join(CACHE, "jobs.json"), "w", encoding="utf-8") as f:
        json.dump(jobs, f, ensure_ascii=False, separators=(",", ":"), default=str)

    if stats:
        _print_stats(media, live_pairs, orphan_videos, unreadable, jobs)
    print(f"[scan] 完成：{len(media)} 条媒体，{live_pairs} 张实况照片，用时 {time.time() - t0:.1f}s")
    return index


def build_jobs(media):
    """生成派生文件任务：缩略图、HEIC→JPEG、实况 MP4、视频封面。"""
    thumb, view, live, poster, vtrans = [], [], [], [], []
    for r in media:
        ext = r["ext"]
        if r["t"] == "img":
            thumb.append(r["id"])
            if ext in (".heic", ".heif"):
                view.append(r["id"])
            if r.get("live"):
                live.append({"id": r["id"], "src": r["live"]["path"]})
        else:
            poster.append(r["id"])
            if r.get("codec") == "hevc":
                vtrans.append(r["id"])
    return {"thumb": thumb, "view": view, "live": live, "poster": poster, "video_transcode": vtrans}


def _print_stats(media, live_pairs, orphan_videos, unreadable, jobs):
    from collections import Counter

    print("\n=== 统计 ===")
    print(f"媒体总数: {len(media)}")
    print(f"  图片: {sum(1 for r in media if r['t'] == 'img')}")
    print(f"  视频: {sum(1 for r in media if r['t'] == 'vid')}")
    print(f"实况照片: {live_pairs}   独立视频: {orphan_videos}")
    print(f"无 EXIF/无法解码: {len(unreadable)}")
    if unreadable:
        print("  例:", unreadable[:10])
    print("扩展名:", dict(Counter(r["ext"] for r in media).most_common()))
    print("年份:", dict(sorted(Counter(r["date"][:4] for r in media).items())))
    print("派生任务:", {k: len(v) for k, v in jobs.items()})
    print(f"总体积: {sum(r['size'] for r in media) / 1e9:.2f} GB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true")
    a = ap.parse_args()
    scan(stats=a.stats)
