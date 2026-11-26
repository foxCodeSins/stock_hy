@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot change directory to %~dp0
  pause
  exit /b 1
)
echo Starting A-share live review system ...
echo Default port 8899. If occupied, the next free port is used; see console output.
set "NODE_EXE="
set "VERS_DIR=%USERPROFILE%\.workbuddy\binaries\node\versions"
rem Prefer the bundled Node.js recorded in the "current" file.
if exist "%VERS_DIR%\current" (
  for /f "usebackq delims=" %%V in ("%VERS_DIR%\current") do (
    if exist "%VERS_DIR%\%%V\node.exe" set "NODE_EXE=%VERS_DIR%\%%V\node.exe"
  )
)
rem Otherwise pick any bundled version directory that contains node.exe.
if not defined NODE_EXE (
  for /d %%D in ("%VERS_DIR%\*") do (
    if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
  )
)
rem Last resort: Node.js on PATH.
if not defined NODE_EXE (
  for /f "delims=" %%P in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%P"
  )
)
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Please install Node.js 18 or newer.
  pause
  exit /b 1
)
echo Using Node: !NODE_EXE!
"!NODE_EXE!" -v
"!NODE_EXE!" server.js
echo.
echo Server stopped.
pause
