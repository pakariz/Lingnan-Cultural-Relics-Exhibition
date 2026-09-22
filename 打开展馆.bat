@echo off
rem 数字文物展馆 - 桌面应用入口
rem 双击本文件即可在独立应用窗口中打开展馆
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."