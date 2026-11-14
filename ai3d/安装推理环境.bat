@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 数字文物展馆 - 安装 AI 推理环境
cd /d "%~dp0"

echo ==========================================================
echo   数字文物展馆 · AI 推理环境安装（接收方运行一次即可）
echo   需要：Windows x64 + Python 3.13 + NVIDIA 显卡
echo ==========================================================
echo.

rem ---------- 1. 检查 Python 3.13 ----------
set "PY_CMD="
py -3.13 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY_CMD=py -3.13"
if not defined PY_CMD (
    python -c "import sys; sys.exit(0 if sys.version_info[:2]==(3,13) and sys.maxsize>2**32 else 1)" >nul 2>&1
    if not errorlevel 1 set "PY_CMD=python"
)
if not defined PY_CMD (
    echo [错误] 未检测到 Python 3.13 x64。
    echo 请先安装 Python 3.13：https://www.python.org/downloads/release/python-3130/
    echo 安装时勾选 "Add python.exe to PATH"，然后重新运行本脚本。
    echo.
    pause
    exit /b 1
)
echo [1/7] Python 检查通过：%PY_CMD%

rem ---------- 2. 检查 Hunyuan3D-2 源码 ----------
if not exist "Hunyuan3D-2\hy3dgen" (
    echo [错误] 缺少 Hunyuan3D-2 源码目录。
    echo 请确认项目完整克隆，或把 Hunyuan3D-2 放到 ai3d\Hunyuan3D-2。
    pause
    exit /b 1
)
echo [2/7] 源码检查通过

rem ---------- 3. 创建虚拟环境 ----------
if exist "venv\Scripts\python.exe" (
    echo [3/7] 已存在虚拟环境 venv，跳过创建
) else (
    echo [3/7] 创建虚拟环境 ai3d\venv ...
    %PY_CMD% -m venv venv
    if errorlevel 1 (
        echo [错误] 创建虚拟环境失败。
        pause
        exit /b 1
    )
)
set "VPY=%~dp0venv\Scripts\python.exe"

"%VPY%" -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check

rem ---------- 4. 安装 CUDA 版 PyTorch ----------
if exist "torch-local\torch-2.7.1+cu128-cp313-cp313-win_amd64.whl" (
    echo [4/7] 安装 CUDA 版 PyTorch（本地轮子）...
    "%VPY%" -m pip install "torch-local\torch-2.7.1+cu128-cp313-cp313-win_amd64.whl" --disable-pip-version-check
    if errorlevel 1 (
        echo [错误] torch 安装失败。
        pause
        exit /b 1
    )
    "%VPY%" -m pip install --no-deps "torch-local\torchvision-0.22.1+cu128-cp313-cp313-win_amd64.whl" --disable-pip-version-check
    if errorlevel 1 (
        echo [错误] torchvision 安装失败。
        pause
        exit /b 1
    )
) else (
    echo [4/7] 未找到本地 torch 轮子，改为从 PyTorch 官方源安装 cu128 版本
    echo       下载量约 3.1GB，网络慢可先让交付方单独提供 torch-local 目录
    "%VPY%" -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128 --disable-pip-version-check
    if errorlevel 1 (
        echo [错误] torch 安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

rem ---------- 5. 安装其余依赖 ----------
if exist "requirements_lock.txt" (
    set "REQ=requirements_lock.txt"
) else (
    set "REQ=requirements_a3d.txt"
)
echo [5/7] 安装推理依赖（%REQ%）...
"%VPY%" -m pip install -r "%REQ%" -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
)

rem ---------- 6. 安装本地预编译的 CUDA 扩展 ----------
echo [6/7] 安装预编译扩展 custom_rasterizer ...
set "SP=%~dp0venv\Lib\site-packages"
if exist "Hunyuan3D-2\hy3dgen\texgen\custom_rasterizer\custom_rasterizer" (
    xcopy "Hunyuan3D-2\hy3dgen\texgen\custom_rasterizer\custom_rasterizer" "%SP%\custom_rasterizer\" /E /I /Y >nul
    copy /Y "Hunyuan3D-2\hy3dgen\texgen\custom_rasterizer\custom_rasterizer_kernel.cp313-win_amd64.pyd" "%SP%\" >nul
    echo       custom_rasterizer 已复制到 site-packages
) else (
    echo [警告] 未找到预编译的 custom_rasterizer，贴图功能可能不可用。
)

rem ---------- 7. 准备权重 ----------
echo [7/7] 检查模型权重 ...
if exist "weights\tencent\Hunyuan3D-2mini\hunyuan3d-dit-v2-mini\model.fp16.safetensors" goto weights_exist
echo [提示] 未检测到模型权重，总体积约 14.5GB，来自 hf-mirror，可断点续传。
choice /c YN /n /m "是否现在下载权重？(Y=下载 / N=跳过，稍后手动下载) "
if errorlevel 2 goto weights_exist
"%VPY%" fetch_weights.py
if errorlevel 1 echo [警告] 权重下载未完成，可稍后重跑本脚本或执行：venv\Scripts\python.exe fetch_weights.py
:weights_exist

rem paint unet 只认 .bin，如果只有 safetensors 就本地转换一份
if exist "weights\tencent\Hunyuan3D-2\hunyuan3d-paint-v2-0-turbo\unet\diffusion_pytorch_model.bin" goto unet_ready
if not exist "weights\tencent\Hunyuan3D-2\hunyuan3d-paint-v2-0-turbo\unet\diffusion_pytorch_model.safetensors" goto unet_ready
echo [提示] 正在把 paint unet 权重转换为 .bin（约 3.5GB，仅本地转换，无需下载）
"%VPY%" convert_unet_bin.py
:unet_ready

rem ---------- 自检 ----------
echo.
echo ---------- 自检 ----------
"%VPY%" -c "import torch; print('torch:', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
"%VPY%" -c "import torch, custom_rasterizer; print('custom_rasterizer: OK')"
pushd "Hunyuan3D-2"
"%VPY%" -c "import torch; from hy3dgen.texgen.differentiable_renderer import mesh_processor; print('mesh_processor: OK')"
popd
if exist "weights\tencent\Hunyuan3D-2mini\hunyuan3d-dit-v2-mini\model.fp16.safetensors" (
    echo 权重: OK
) else (
    echo [警告] 权重尚未就绪，图片生成 3D 会失败。稍后执行：
    echo        venv\Scripts\python.exe fetch_weights.py
)

echo.
echo ==========================================================
echo  安装完成。双击项目根目录的「打开展馆.bat」即可启动。
echo  若 CUDA available 为 False，请更新 NVIDIA 驱动后重试。
echo ==========================================================
pause
