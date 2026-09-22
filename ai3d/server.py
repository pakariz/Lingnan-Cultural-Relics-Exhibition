# -*- coding: utf-8 -*-
"""2D 图片 -> 3D 文物模型 的本地推理 HTTP 服务。

架构：index.html 上传图片 -> Express 后端 /api/generate-3d -> 本服务 (127.0.0.1:8765)
本服务用腾讯 Hunyuan3D-2（Apache 2.0）把单张图片重建为 .glb。

首次运行会自动下载模型权重到 ~/.cache/hy3dgen（请保证网络可访问 HuggingFace，已默认走 hf-mirror.com 镜像）。
受限于本机 8GB 显存，默认只做几何重建（无 PBR 贴图），输出纯白/反照率网格，交给展馆前端补光呈现。
"""

import os

# 权重优先从 HuggingFace 国内镜像下载，避免官方源超时
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")

import io
import base64
import sys
import tempfile
import threading

# hy3dgen 包来自本地克隆的 Hunyuan3D-2 源码（免 pip install -e）
_HY3D_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "Hunyuan3D-2"))
if os.path.isdir(os.path.join(_HY3D_REPO, "hy3dgen")):
    sys.path.insert(0, _HY3D_REPO)

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

app = FastAPI(title="Lingnan-Exhibition 2D->3D")

# 模型默认全部加载到 GPU 显然放不下 8GB，这里用"懒加载 + 单线程队列"串行推理，避免同时占显存
_engine = None
_engine_lock = threading.Lock()

# 展馆模型存档目录（与 backend/server.js 的 modelsDir 一致）
MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))


class GenerateRequest(BaseModel):
    image: str  # base64
    num_inference_steps: int = 30
    octree_resolution: int = 256
    with_texture: bool = False


class GenerateResponse(BaseModel):
    modelFile: str
    bytes: int


def _load_engine():
    """懒加载 Hunyuan3D-2 shape 重建 pipeline。"""
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is None:
            from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

            # fp16 降低显存占用；8GB 卡使用默认版本即可
            _engine = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
                "tencent/Hunyuan3D-2", variant="fp16"
            )
    return _engine


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine_loaded": _engine is not None,
        "models_dir": MODELS_DIR,
    }


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    if not req.image:
        raise HTTPException(status_code=400, detail="缺少 image 图片(base64)")

    try:
        # base64 可能带 data:image/...;base64, 前缀
        b64 = req.image.split(",", 1)[1] if "," in req.image else req.image
        img_bytes = base64.b64decode(b64)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
        if image.size[0] > 1024 or image.size[1] > 1024:
            image.thumbnail((1024, 1024))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"图片解码失败: {exc}") from exc

    try:
        pipeline = _load_engine()
        meshes = pipeline(
            image=image,
            num_inference_steps=req.num_inference_steps,
            octree_resolution=req.octree_resolution,
        )
        if not meshes:
            raise RuntimeError("模型未返回任何网格，请换一张更清晰的文物图重试")
        mesh = meshes[0]
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"形状重建失败: {exc}") from exc

    # 可选：上纹理。受显存限制默认关闭；若开启且显存不足会在这里报错，不影响几何结果
    if req.with_texture:
        try:
            from hy3dgen.texgen import Hunyuan3DPaintPipeline

            paint = Hunyuan3DPaintPipeline.from_pretrained(
                "tencent/Hunyuan3D-2", variant="fp16"
            )
            mesh = paint(mesh, image=image)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=500,
                detail=f"纹理生成失败(8GB 显存通常不足，可关闭 with_texture): {exc}",
            ) from exc

    os.makedirs(MODELS_DIR, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False, dir=MODELS_DIR) as tmp:
        glb_path = tmp.name

    try:
        mesh.export(glb_path)
        size = os.path.getsize(glb_path)
        if size == 0:
            raise RuntimeError("导出为空文件")
        return GenerateResponse(modelFile=os.path.basename(glb_path), bytes=size)
    finally:
        # 空文件时清理
        if os.path.exists(glb_path) and os.path.getsize(glb_path) == 0:
            os.remove(glb_path)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")