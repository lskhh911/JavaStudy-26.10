@echo off
chcp 65001 >nul
title 照片库 · iCloud 照片阅读器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 没有找到 Node.js，无法启动。
    echo   请先安装 Node.js（https://nodejs.org）后重试。
    echo.
    pause
    exit /b 1
)

if not exist "cache\index.json" (
    echo.
    echo   [提示] 还没有生成照片索引。
    echo   请先双击运行「重新构建索引.cmd」，完成后再启动本程序。
    echo.
    pause
    exit /b 1
)

echo.
echo   照片库启动中，浏览器会自动打开……
echo   关闭本窗口即停止服务。
echo.
node server.js --open
echo.
echo   服务已停止。
pause