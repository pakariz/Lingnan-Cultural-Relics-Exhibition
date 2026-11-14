# -*- coding: utf-8 -*-
"""Hunyuan3D 权重下载器（支持断点续传）。

用途：把推理所需权重拉到 server.py 期望的目录
    ai3d/weights/<repo>/<subfolder>/
下载源：HuggingFace 国内镜像 hf-mirror.com（可用 env HF_ENDPOINT 覆盖）。

包含两组：
- shape（几何重建）：tencent/Hunyuan3D-2mini 的 dit + vae，约 4GB
- paint（纹理上色）：tencent/Hunyuan3D-2 的 delight + paint-turbo，约 10.3GB

特点：
- HTTP Range 断点续传：中断后重跑即可从已下载字节继续，不会重头来
- 单个文件内自动重试（默认 200 次，间隔 3 秒），可长时间无人值守
- 跳过与 .safetensors 重复的 .bin（省约 3.9GB）

用法：
    ai3d\\venv\\Scripts\\python.exe ai3d\\fetch_weights.py           # 全部
    ai3d\\venv\\Scripts\\python.exe ai3d\\fetch_weights.py shape     # 只下几何
    ai3d\\venv\\Scripts\\python.exe ai3d\\fetch_weights.py paint     # 只下纹理
"""

import os
import sys
import time

import requests

ENDPOINT = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
WEIGHTS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights")
MAX_RETRY = int(os.environ.get("HY3D_DL_RETRY", "200"))
RETRY_DELAY = int(os.environ.get("HY3D_DL_RETRY_DELAY", "3"))

SHAPE_REPO = "tencent/Hunyuan3D-2mini"
PAINT_REPO = "tencent/Hunyuan3D-2"

_TOKENIZER = [
    "tokenizer/merges.txt",
    "tokenizer/vocab.json",
    "tokenizer/special_tokens_map.json",
    "tokenizer/tokenizer_config.json",
]

# (仓库, 相对路径, 分组标签)
FILES = [
    # ---- 几何重建（Hunyuan3D-2mini）----
    (SHAPE_REPO, "hunyuan3d-dit-v2-mini/config.yaml", "shape"),
    (SHAPE_REPO, "hunyuan3d-vae-v2-mini/config.yaml", "shape"),
    (SHAPE_REPO, "hunyuan3d-dit-v2-mini/model.fp16.safetensors", "shape"),
    (SHAPE_REPO, "hunyuan3d-vae-v2-mini/model.fp16.safetensors", "shape"),
    # ---- 纹理上色：去光照模型 delight（InstructPix2Pix）----
    (PAINT_REPO, "hunyuan3d-delight-v2-0/model_index.json", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/scheduler/scheduler_config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/feature_extractor/preprocessor_config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/text_encoder/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/text_encoder/model.safetensors", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/unet/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/unet/diffusion_pytorch_model.safetensors", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/vae/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-delight-v2-0/vae/diffusion_pytorch_model.safetensors", "paint"),
    # ---- 纹理上色：多视角扩散模型 paint-turbo（LCM 4 步）----
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/model_index.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/scheduler/scheduler_config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/feature_extractor/preprocessor_config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/image_encoder/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/image_encoder/preprocessor_config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/image_encoder/model.safetensors", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/text_encoder/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/text_encoder/pytorch_model.bin", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/unet/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/unet/modules.py", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.safetensors", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/vae/config.json", "paint"),
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/vae/diffusion_pytorch_model.bin", "paint"),
] + [
    (PAINT_REPO, f"hunyuan3d-delight-v2-0/{f}", "paint") for f in _TOKENIZER
] + [
    (PAINT_REPO, f"hunyuan3d-paint-v2-0-turbo/{f}", "paint") for f in _TOKENIZER
]

# 体积大且与 safetensors 内容重复的 .bin，不下（diffusers 会优先用 safetensors）
SKIP = {
    (PAINT_REPO, "hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.bin"),
}


def _url(repo, rel):
    return f"{ENDPOINT}/{repo}/resolve/main/{rel}"


def _dst(repo, rel):
    return os.path.join(WEIGHTS_ROOT, *repo.split("/"), *rel.split("/"))


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


def download_one(session, repo, rel, group):
    dst = _dst(repo, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    url = _url(repo, rel)
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
    targets = [(repo, rel, g) for repo, rel, g in FILES if not only or g == only]
    targets = [(repo, rel, g) for repo, rel, g in targets if (repo, rel) not in SKIP]
    print(f"下载源: {ENDPOINT}\n目标目录: {WEIGHTS_ROOT}\n共 {len(targets)} 个文件\n", flush=True)
    session = requests.Session()
    session.headers.update({"User-Agent": "lingnan-exhibition-ai3d/1.0"})
    ok = True
    for repo, rel, group in targets:
        ok = download_one(session, repo, rel, group) and ok
    print("\n全部结束" + ("" if ok else "（存在失败项，可重跑本脚本续传）"), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
