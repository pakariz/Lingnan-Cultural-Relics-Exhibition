# -*- coding: utf-8 -*-
"""ai3d 推理服务冒烟测试：把一张文物图片 POST 到 /generate，验证能产出 .glb。

用法：
    ai3d\\venv\\Scripts\\python.exe ai3d\\test_generate.py [图片路径] [接口地址]
默认图片：models\\青铜鼎\\ding.jpg     默认接口：http://127.0.0.1:8765
"""

import base64
import io
import json
import os
import sys
import time

import requests
from PIL import Image

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
img_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PROJ, "models", "青铜鼎", "ding.jpg")
api = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8765"

with Image.open(img_path) as im:
    im = im.convert("RGB")
    if max(im.size) > 1024:
        im.thumbnail((1024, 1024))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
print(f"输入图片: {img_path}  {im.size}  -> {len(buf.getvalue())/1024:.0f} KB", flush=True)

payload = {
    "image": base64.b64encode(buf.getvalue()).decode("ascii"),
    "num_inference_steps": 30,
    "octree_resolution": 256,
    "with_texture": False,
}

print("首次请求会加载约 3.6GB 权重到显存，请耐心等待...", flush=True)
t0 = time.time()
r = requests.post(f"{api}/generate", json=payload, timeout=1800)
dt = time.time() - t0
print(f"HTTP {r.status_code}  用时 {dt:.1f}s", flush=True)

try:
    body = r.json()
except Exception:
    print("非 JSON 响应:", r.text[:800], flush=True)
    sys.exit(1)

if r.status_code != 200:
    print("失败:", json.dumps(body, ensure_ascii=False)[:800], flush=True)
    sys.exit(1)

glb = os.path.join(PROJ, "models", body["modelFile"])
print(
    f"成功: {body['modelFile']}  {body['bytes']/1048576:.2f} MB  "
    f"落盘存在={os.path.exists(glb)}",
    flush=True,
)
