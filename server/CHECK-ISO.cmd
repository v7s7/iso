@echo off
cd /d "%~dp0"
call npm run check-env || exit /b 1
call npm run data-check || exit /b 1
echo.
echo Deployment checks passed.
pause
