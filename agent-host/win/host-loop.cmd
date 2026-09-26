@echo off
rem Host loop: runs the agent, restarts it 5 minutes after a crash.
rem Single-instance check lives in start-agent.cmd (by node process).
title AgentHost
chcp 65001 >nul
set "PATH=C:\agent\tools\node;C:\agent\tools\git\cmd;%PATH%"
cd /d C:\agent\dashboard\agent-host
:loop
call npm start
echo [host] process exited, restart in 5 minutes...
timeout /t 300 /nobreak >nul
goto loop
