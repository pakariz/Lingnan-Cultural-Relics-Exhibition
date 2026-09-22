@echo off
chcp 65001 >nul
title 文物展馆 2D->3D 推理服务
cd /d "%~dp0"

echo 正在检查 python 虚拟环境...
if not exist "venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境，请先运行: python -m venv venv
    echo 然后安装依赖: venv\Scripts\python -m pip install -r requirements_a3d.txt
    pause
    exit /b 1
)

echo 正在启动 2D->3D 推理服务 (127.0.0.1:8765)...
echo 首次运行会自动下载 Hunyuan3D-2 模型权重，请耐心等待。
"venv\Scripts\python.exe" server.py
pause