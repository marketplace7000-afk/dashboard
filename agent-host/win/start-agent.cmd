@echo off
rem === Принудительный запуск агента: окно Chrome агента + консоль хоста ===
rem Живёт в репозитории (agent-host\win) и обновляется вместе с кодом.
chcp 65001 >nul
set "AGENT_ROOT=C:\agent"
set "HOST_DIR=%AGENT_ROOT%\dashboard\agent-host"

rem 1. Chrome агента (отдельный профиль). Если он уже работает, просто
rem откроется его окно — второй экземпляр Chrome не создаётся.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=%AGENT_ROOT%\chrome-profile --remote-debugging-port=9222 --no-first-run --no-default-browser-check

rem 2. Консоль хоста — не больше одной. Проверка по живому процессу node,
rem запущенному из agent-host (заголовки окон npm перезаписывает, а
rem файловому замку мешал антивирус).
powershell -NoProfile -Command "exit @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'agent-host' }).Count"
if not %errorlevel%==0 (
  echo Агент уже запущен — открыл только Chrome. Это окно закроется само.
  timeout /t 4 /nobreak >nul
  exit /b 0
)

rem Автозапуск при входе в Windows — на этот же скрипт.
schtasks /Create /F /TN AgentHost /SC ONLOGON /TR "\"%HOST_DIR%\win\start-agent.cmd\"" >nul 2>&1

start "AgentHost" cmd /c "%HOST_DIR%\win\host-loop.cmd"
exit /b 0
