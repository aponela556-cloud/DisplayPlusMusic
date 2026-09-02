@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-qr.ps1" -SyncDemo
if errorlevel 1 (
  echo.
  echo DisplayLyric Music Sync Demo QR setup failed. Review the message above.
  pause
)
