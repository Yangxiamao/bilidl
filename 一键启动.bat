@echo off
rem Double-click to start the bilidl web UI. All logic lives in launch.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
if errorlevel 1 pause
