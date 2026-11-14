# -*- coding: utf-8 -*-
"""把 paint unet 的 safetensors 转成 diffusers 期望的 .bin。

背景：Hunyuan3D-Paint 的 unet 加载代码写死了 `diffusion_pytorch_model.bin`
（见 hy3dgen/texgen/hunyuanpaint/unet/modules.py），而 HF 仓库只提供
`.safetensors`。官方权重里这两个文件内容一致，本地转换即可，无需额外下载。

用法：
    venv\\Scripts\\python.exe convert_unet_bin.py          # 已存在 .bin 则跳过
    venv\\Scripts\\python.exe convert_unet_bin.py --force  # 强制重新生成
"""

import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UNET_DIR = os.path.join(
    BASE_DIR, "weights", "tencent", "Hunyuan3D-2", "hunyuan3d-paint-v2-0-turbo", "unet"
)
SAFE_PATH = os.path.join(UNET_DIR, "diffusion_pytorch_model.safetensors")
BIN_PATH = os.path.join(UNET_DIR, "diffusion_pytorch_model.bin")


def main():
    force = "--force" in sys.argv[1:]

    if not os.path.exists(SAFE_PATH):
        if os.path.exists(BIN_PATH):
            print("[跳过] 已存在 .bin，缺少 safetensors 也不影响使用")
            return 0
        print(f"[错误] 未找到 {SAFE_PATH}")
        print("        请先运行：venv\\Scripts\\python.exe fetch_weights.py paint")
        return 1

    if os.path.exists(BIN_PATH) and not force:
        print("[跳过] diffusion_pytorch_model.bin 已存在")
        return 0

    import torch
    from safetensors.torch import load_file

    print("正在读取 safetensors（约 3.5GB，请稍候）...")
    state_dict = load_file(SAFE_PATH)
    print(f"正在写入 {BIN_PATH} ...")
    torch.save(state_dict, BIN_PATH)
    size_gb = os.path.getsize(BIN_PATH) / (1024 ** 3)
    print(f"完成：{BIN_PATH}（{size_gb:.2f} GB，{len(state_dict)} 个张量）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
