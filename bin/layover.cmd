@echo off
setlocal
rem Layover CLI shim. In a packaged install this runs the app's own Node runtime; in a checkout it uses node.
if exist "%~dp0..\Layover.exe" (
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0..\Layover.exe" "%~dp0..\resources\src\cli\layover.js" %*
) else (
  node "%~dp0..\src\cli\layover.js" %*
)
