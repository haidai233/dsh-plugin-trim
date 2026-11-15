@echo off
rem Fixed entry for the dsh-plugin-trim panel. Logic lives in open-panel.ps1.
rem Usage: open-panel.cmd        (open browser)
rem        open-panel.cmd check  (print url only)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-panel.ps1" %*
exit /b %ERRORLEVEL%