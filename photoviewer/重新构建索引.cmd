@echo off
chcp 65001 >nul
title 重建照片索引
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY if exist "C:\Users\liusunkai\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=C:\Users\liusunkai\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

if not defined PY (
    echo.
    echo   [错误] 没有找到 Python 3。
    echo   请安装 Python 3.9 以上版本，或修改本脚本里的 PY 路径。
    echo.
    pause
    exit /b 1
)

echo.
echo   使用 Python: %PY%
echo.

"%PY%" -c "import PIL, pillow_heif" >nul 2>nul
if errorlevel 1 (
    echo   正在安装图片解码依赖 Pillow 与 pillow-heif ...
    "%PY%" -m pip install --quiet --upgrade pillow pillow-heif
)

echo   [1/3] 扫描照片库、读取 EXIF、配对实况照片……
"%PY%" build\scan.py --stats
if errorlevel 1 goto fail

echo.
echo   [2/3] 生成缩略图与 HEIC 预览图……
"%PY%" build\derive.py
if errorlevel 1 goto fail

echo.
echo   [3/3] 转码实况视频……
"%PY%" build\transcode.py
if errorlevel 1 goto fail

echo.
echo   全部完成！现在可以双击「启动照片库.cmd」浏览照片了。
echo.
pause
exit /b 0

:fail
echo.
echo   [出错] 上一步没有成功，请查看上面的错误信息。
echo.
pause
exit /b 1