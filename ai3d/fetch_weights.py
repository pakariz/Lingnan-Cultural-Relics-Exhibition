# -*- coding: utf-8 -*-
"""Hunyuan3D-2mini 权重下载器（支持断点续传）。

用途：把推理所需权重拉到 server.py 期望的目录
    ai3d/weights/tencent/Hunyuan3D-2mini/<subfolder>/
下载源：HuggingFace 国内镜像 hf-mirror.com（可用 env HF_ENDPOINT 覆盖）。

特点：
- HTTP Range 断点续传：中断后重跑即可从已下载字节继续，不会重头来
- 单个文件内自动重试（默认 200 次，间隔 3 秒），可长时间无人值守
- 先下必需的小文件 config.yaml，再下 3.6GB 的 DiT 权重，最后下可选 VAE

用法：
    ai3d\\venv\\Scripts\\python.exe ai3d\\fetch_weights.py            # 全部
    ai3d\\venv\\Scripts\\python.exe ai3d\\fetch_weights.py dit        # 只下 DiT
"""

import os
import sys
import time

import requests

ENDPOINT = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
REPO = os.environ.get("HY3D_REPO_ID", "tencent/Hunyuan3D-2mini")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights", *REPO.split("/"))
MAX_RETRY = int(os.environ.get("HY3D_DL_RETRY", "200"))
RETRY_DELAY = int(os.environ.get("HY3D_DL_RETRY_DELAY", "3"))

# (相对路径, 分组标签)
FILES = [
    ("hunyuan3d-dit-v2-mini/config.yaml", "cfg"),
    ("hunyuan3d-vae-v2-mini/config.yaml", "cfg"),
    ("hunyuan3d-dit-v2-mini/model.fp16.safetensors", "dit"),
    ("hunyuan3d-vae-v2-mini/model.fp16.safetensors", "vae"),
]


def _url(rel):
    return f"{ENDPOINT}/{REPO}/resolve/main/{rel}"


def _total_size(session, url):
    """跟随重定向取远端总字节数；取不到返回 None。"""
    try:
        r = session.get(url, stream=True, allow_redirects=True, timeout=(15, 60))
        try:
            r.raw.decode_content = False
            return int(r.headers.get("Content-Length", 0)) or None
        finally:
            r.close()
    except Exception:
        return None


def download_one(session, rel, group):
    dst = os.path.join(ROOT, *rel.split("/"))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    url = _url(rel)
    total = _total_size(session, url)

    for attempt in range(1, MAX_RETRY + 1):
        pos = os.path.getsize(dst) if os.path.exists(dst) else 0
        if total and pos == total:
            print(f"[OK ] {rel} ({pos} bytes, 已完成)", flush=True)
            return True
        headers = {"Range": f"bytes={pos}-"} if pos else {}
        try:
            with session.get(url, headers=headers, stream=True, timeout=(15, 60)) as r:
                if r.status_code == 416:  # 已下完
                    print(f"[OK ] {rel} ({pos} bytes, 已完成)", flush=True)
                    return True
                if pos and r.status_code == 200:
                    # 服务端不支持 Range，只能重头下
                    pos = 0
                elif r.status_code not in (200, 206):
                    raise RuntimeError(f"HTTP {r.status_code}")
                mode = "ab" if pos else "wb"
                with open(dst, mode) as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        if chunk:
                            f.write(chunk)
                        # 每落一块就打印进度，便于长时间观察
                        cur = os.path.getsize(dst)
                        if total:
                            pct = cur * 100.0 / total
                            print(
                                f"\r[{group}] {rel} {cur/1048576:.1f}/{total/1048576:.1f} MB "
                                f"({pct:.1f}%)",
                                end="",
                                flush=True,
                            )
            cur = os.path.getsize(dst)
            if total is None or cur == total:
                print(f"\n[OK ] {rel} ({cur} bytes)", flush=True)
                return True
            print(f"\n[..] {rel} 断在 {cur} bytes，{RETRY_DELAY}s 后续传 (第 {attempt} 次)", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(
                f"\n[!!] {rel} 出错: {type(exc).__name__}: {exc}；"
                f"{RETRY_DELAY}s 后续传 (第 {attempt} 次)",
                flush=True,
            )
        time.sleep(RETRY_DELAY)

    print(f"[XX] {rel} 重试 {MAX_RETRY} 次仍失败", flush=True)
    return False


def main():
    only = sys.argv[1].lower() if len(sys.argv) > 1 else None
    targets = [(rel, g) for rel, g in FILES if not only or g == only or (only == "cfg" and g == "cfg")]
    print(f"下载源: {ENDPOINT}  仓库: {REPO}\n目标目录: {ROOT}\n", flush=True)
    session = requests.Session()
    session.headers.update({"User-Agent": "lingnan-exhibition-ai3d/1.0"})
    ok = True
    for rel, group in targets:
        ok = download_one(session, rel, group) and ok
    print("\n全部结束" + ("" if ok else "（存在失败项，可重跑本脚本续传）"), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
