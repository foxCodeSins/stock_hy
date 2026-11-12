@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 A股实时复盘与短线机会系统 ...
echo 默认端口 8899，若被占用会自动顺延；请以控制台输出的 "本机访问" 地址为准。
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" (
    "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" server.js
  ) else (
    echo 未检测到 Node.js，请先安装 Node.js 18 或更高版本。
  )
)
pause
