@echo off
rem Host loop: runs the agent, restarts it 5 minutes after a crash.
rem Window title "AgentHost" is the single-instance lock (see start-agent.cmd).
title AgentHost
chcp 65001 >nul
set "PATH=C:\agent\tools\node;C:\agent\tools\git\cmd;%PATH%"
cd /d C:\agent\dashboard\agent-host
:loop
call npm start
echo [host] process exited, restart in 5 minutes...
timeout /t 300 /nobreak >nul
goto loop
