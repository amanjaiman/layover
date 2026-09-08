@echo off
rem Cheap hook entry for events that fire often (after every tool call). If nothing is queued for
rem any agent, exit at once without starting a runtime; otherwise behave exactly like layover.cmd.
if not exist "%LOCALAPPDATA%\Layover\data\outbox.flag" exit /b 0
call "%~dp0layover.cmd" %*
