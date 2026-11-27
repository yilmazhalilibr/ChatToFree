@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul && goto haveNode
echo Node.js kurulu degil; ChatToFree icin gerekli.
where winget >nul 2>nul || goto manualNode
choice /c EH /m "Simdi winget ile kurayim mi"
if errorlevel 2 goto manualNode
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
echo.
echo Node.js kuruldu. Bu pencereyi kapatip Kur.bat'i bir kez daha calistir.
pause
exit /b 0
:manualNode
echo Once Node.js kurman gerekiyor: https://nodejs.org
pause
exit /b 1
:haveNode
if not exist node_modules (
  echo Hazirlaniyor, bir dakika surebilir...
  call npm install --silent
)
node src\cli.js kur
echo.
pause
