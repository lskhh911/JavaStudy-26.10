@echo off
chcp 65001 >nul
title 安静重建（低功耗）
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY if exist "C:\Users\liusunkai\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=C:\Users\liusunkai\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

if not defined PY (
    echo.
    echo   [错误] 没有找到 Python 3。
    echo.
    pause
    exit /b 1
)

echo.
echo   安静模式：全程只占约 3 个线程，风扇基本不会起飞。
echo   代价是慢很多（可能要 2-4 小时），适合插着电放着不管。
echo.
echo   按任意键开始……
pause >nul

chcp 65001 >nul
echo.
echo   [1/3] 扫描照片库……
start /LOW /wait /b "" "%PY%" build\scan.py --stats
if errorlevel 1 goto fail

echo.
echo   [2/3] 生成缩略图……
start /LOW /wait /b "" "%PY%" build\derive.py --workers 3
if errorlevel 1 goto fail

echo.
echo   [3/3] 转码视频……
start /LOW /wait /b "" "%PY%" build\transcode.py --workers 3 --threads 1
if errorlevel 1 goto fail

echo.
echo   全部完成！
echo.
pause
exit /b 0

:fail
echo.
echo   [出错] 上一步没有成功。
echo.
pause
exit /b 1