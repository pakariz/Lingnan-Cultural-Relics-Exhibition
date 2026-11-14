# -*- coding: utf-8 -*-
"""2D 图片 -> 3D 文物模型 的本地推理 HTTP 服务。

架构：index.html 上传图片 -> Express 后端 /api/generate-3d -> 本服务 (127.0.0.1:8765)
本服务用腾讯 Hunyuan3D（代码与权重遵循 TENCENT HUNYUAN 社区许可，仅供非商业用途）把单张图片重建为 .glb。

首次运行的模型权重放在项目内 ai3d/weights（已默认走 HuggingFace 国内镜像 hf-mirror.com）。
受限于本机 8GB 显存，默认只做几何重建（无 PBR 贴图），输出纯色网格，交给展馆前端补光呈现。
"""

import os

# 权重优先从 HuggingFace 国内镜像下载，避免官方源超时
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
# 权重目录固定在项目内 ai3d/weights，避免依赖用户级缓存目录（也便于离线搬运）
os.environ.setdefault(
    "HY3DGEN_MODELS",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights"),
)

import io
import base64
import sys
import tempfile
import threading
import time

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
_paint_engine = None
_paint_lock = threading.Lock()

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
    warning: str | None = None


def _load_engine():
    """懒加载 Hunyuan3D shape 重建 pipeline。

    默认使用 Hunyuan3D-2mini（约 0.6B DiT + 0.4B VAE，官方要求 ≥6GB 显存），
    适配本机 8GB 显存的 RTX 4060 Laptop。若要更高精度可改为：
        HY3D_REPO=tencent/Hunyuan3D-2  HY3D_SUBFOLDER=hunyuan3d-dit-v2-0
    （标准版官方要求 ≥12GB 显存，8GB 卡可能 OOM）。
    """
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is None:
            import torch
            from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

            repo = os.environ.get("HY3D_REPO", "tencent/Hunyuan3D-2mini")
            subfolder = os.environ.get("HY3D_SUBFOLDER", "hunyuan3d-dit-v2-mini")
            _engine = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
                repo,
                subfolder=subfolder,
                variant="fp16",
                use_safetensors=True,
                device="cuda",
                dtype=torch.float16,
            )
    return _engine


def _load_paint_engine():
    """懒加载 Hunyuan3D-Paint 纹理管线（turbo 版，LCM 4 步）。

    Paint 由「去光照模型 delight」+「多视角扩散模型 paint-turbo」两部分组成。
    本机 8GB 显存放不下整条管线，因此用 enable_model_cpu_offload() 让各子模型
    在 CPU/GPU 之间按需搬运；贴图分辨率默认 1024（可用 HY3D_TEXTURE_SIZE 调，
    2048 更清晰但更慢也更吃显存）。

    注意：Hunyuan3DPaintPipeline.from_pretrained 只接受 (model_path, subfolder)，
    没有 variant 参数，所以这里直接构造 Hunyuan3DTexGenConfig 来指定分辨率。
    """
    global _paint_engine
    if _paint_engine is not None:
        return _paint_engine
    with _paint_lock:
        if _paint_engine is None:
            # 先 import torch：custom_rasterizer_kernel 依赖 torch 带的 cudart64_12.dll
            import torch
            from hy3dgen.texgen.pipelines import (
                Hunyuan3DPaintPipeline,
                Hunyuan3DTexGenConfig,
            )

            subfolder = os.environ.get("HY3D_PAINT_SUBFOLDER", "hunyuan3d-paint-v2-0-turbo")
            repo_dir = os.path.join(os.environ["HY3DGEN_MODELS"], "tencent", "Hunyuan3D-2")
            size = int(os.environ.get("HY3D_TEXTURE_SIZE", "1024"))

            config = Hunyuan3DTexGenConfig(
                os.path.join(repo_dir, "hunyuan3d-delight-v2-0"),
                os.path.join(repo_dir, subfolder),
                subfolder,
            )
            config.render_size = size
            config.texture_size = size

            pipe = Hunyuan3DPaintPipeline(config)
            pipe.enable_model_cpu_offload()
            _paint_engine = pipe
    return _paint_engine


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
        # 上一条请求做过纹理生成的话，几何管线还在 CPU 上，先搬回显卡
        if getattr(pipeline, "device", None) is not None and str(pipeline.device) != "cuda":
            pipeline.to("cuda")
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

    # 可选：上纹理（Hunyuan3D-Paint）。8GB 显存放不下两条管线，先把几何管线挪到 CPU
    warning = None
    if req.with_texture:
        try:
            import torch

            pipeline.to("cpu")
            torch.cuda.empty_cache()
            mesh = _load_paint_engine()(mesh, image=image)
        except Exception as exc:  # noqa: BLE001
            # 贴图失败不该把整件文物一起丢掉：返回白膜并带上原因
            warning = f"贴图生成失败，已返回白膜：{exc}"

    os.makedirs(MODELS_DIR, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False, dir=MODELS_DIR) as tmp:
        glb_path = tmp.name

    try:
        mesh.export(glb_path)
        size = os.path.getsize(glb_path)
        if size == 0:
            raise RuntimeError("导出为空文件")
        return GenerateResponse(
            modelFile=os.path.basename(glb_path), bytes=size, warning=warning
        )
    finally:
        # 空文件时清理
        if os.path.exists(glb_path) and os.path.getsize(glb_path) == 0:
            os.remove(glb_path)


def _start_parent_watchdog():
    """父进程消失时自行退出，避免关闭应用后推理服务仍驻留后台占显存/端口。

    父进程号由 backend/server.js 通过环境变量 AI3D_PARENT_PID 传入；
    手动运行本脚本时该变量不存在，看门狗不启用。
    """
    raw = os.environ.get("AI3D_PARENT_PID", "")
    if not raw.isdigit():
        return
    ppid = int(raw)

    def parent_alive():
        if os.name == "nt":
            import ctypes

            SYNCHRONIZE = 0x00100000
            WAIT_OBJECT_0 = 0
            handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, ppid)
            if not handle:
                return False
            try:
                # 父进程退出后其句柄会进入已置信号状态
                return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) != WAIT_OBJECT_0
            finally:
                ctypes.windll.kernel32.CloseHandle(handle)
        try:
            os.kill(ppid, 0)
            return True
        except OSError:
            return False

    def loop():
        while True:
            time.sleep(3)
            if not parent_alive():
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":
    _start_parent_watchdog()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")