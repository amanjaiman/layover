@echo off
rem Cheap hook entry for events that fire often (after every tool call). If nothing is queued for
rem any agent and no turn is held on the user, exit at once without starting a runtime; otherwise
rem behave exactly like layover.cmd.
if not exist "%LOCALAPPDATA%\Layover\data\outbox.flag" if not exist "%LOCALAPPDATA%\Layover\data\holding.flag" exit /b 0
call "%~dp0layover.cmd" %*
