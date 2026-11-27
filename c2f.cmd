@echo off
rem ChatToFree launcher that works from any directory, with no PATH setup.
rem Usage:  c2f build "bir snake oyunu yaz"      |  c2f chat  |  c2f doctor
setlocal
set "C2F_HOME=%~dp0"
where node >nul 2>nul || (
  echo Node.js 20+ is required: https://nodejs.org
  exit /b 1
)
node "%C2F_HOME%src\cli.js" %*
