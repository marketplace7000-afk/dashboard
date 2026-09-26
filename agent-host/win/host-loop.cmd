@echo off
rem Host loop: runs the agent, restarts it 5 minutes after a crash.
rem Single instance: file lock C:\agent\host.lock held on descriptor 9
rem while this window lives; a second copy fails to open it and exits.
chcp 65001 >nul
2>nul ( 9>"C:\agent\host.lock" call :main ) || (
  echo Агент уже запущен в другом окне — это закроется само.
  timeout /t 4 /nobreak >nul
)
exit /b 0

:main
title AgentHost
set "PATH=C:\agent\tools\node;C:\agent\tools\git\cmd;%PATH%"
cd /d C:\agent\dashboard\agent-host
:loop
call npm start
echo [host] process exited, restart in 5 minutes...
timeout /t 300 /nobreak >nul
goto loop
