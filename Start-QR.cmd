@echo off
setlocal
title DisplayPlus Music QR Launcher
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
    echo Node.js and npm are required but were not found.
    echo Install Node.js, then run this file again.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing project dependencies...
    call npm ci
    if errorlevel 1 goto :dependency_error
)

call :server_is_ready
if errorlevel 1 (
    echo Starting the development server in a separate window...
    start "DisplayPlus Music Dev Server" cmd /k "cd /d ""%~dp0"" && npx vite --host 0.0.0.0 --port 5173 --strictPort"

    echo Waiting for http://localhost:5173/ ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddSeconds(30); do { try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1"
    if errorlevel 1 goto :server_error
) else (
    echo The development server is already running.
)

echo Opening the Even Hub QR code...
call npx evenhub qr -p 5173 --path "/" --http --external
if errorlevel 1 goto :qr_error

echo.
echo Scan the QR code from Developer Center in the Even Realities app.
echo Keep the "DisplayPlus Music Dev Server" window open while testing.
pause
exit /b 0

:server_is_ready
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
exit /b %errorlevel%

:dependency_error
echo.
echo Dependency installation failed.
pause
exit /b 1

:server_error
echo.
echo The development server did not become ready within 30 seconds.
echo Check the server window for details.
pause
exit /b 1

:qr_error
echo.
echo The QR code could not be generated.
pause
exit /b 1
