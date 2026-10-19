@echo off
chcp 65001 >nul
title 同步到 Linux 服务器
cd /d "%~dp0"

where ssh >nul 2>nul
if errorlevel 1 (
    echo   [错误] 找不到 ssh 命令（需要 Windows 自带的 OpenSSH 客户端）。
    pause
    exit /b 1
)

echo.
echo   将把 photos/ 与 cache/ 同步到 Tailscale 里的 minecraft-server，
echo   只重传有变化的年/月，然后自动重启远端服务。
echo.
echo   按任意键开始……
pause >nul

echo.
echo   [1/3] 同步原图……
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\transfer-photos.ps1"
if errorlevel 1 goto fail

echo.
echo   [2/3] 同步缓存与索引……
tar -cf - -C cache thumbs view live poster index.json jobs.json | ssh -o BatchMode=yes mc "tar -xf - -C /home/mc/photoviewer/cache"
if errorlevel 1 goto fail

echo.
echo   [3/3] 重启远端服务……
ssh -o BatchMode=yes mc "systemctl --user restart photoviewer && sleep 2 && systemctl --user is-active photoviewer"
if errorlevel 1 goto fail

echo.
echo   完成！打开 http://100.114.239.18:7788
echo.
pause
exit /b 0

:fail
echo.
echo   [出错] 同步没有完成，请查看上面的信息。
echo.
pause
exit /b 1