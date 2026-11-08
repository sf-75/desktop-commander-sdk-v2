@echo off
setlocal

set "DC_REPO_ROOT=%~dp0.."
if not defined DC_SDK_V2_PLAYGROUND_HOME set "DC_SDK_V2_PLAYGROUND_HOME=%TEMP%\desktop-commander-sdk-v2-playground-home"

if not exist "%DC_SDK_V2_PLAYGROUND_HOME%" mkdir "%DC_SDK_V2_PLAYGROUND_HOME%" >nul 2>nul
set "USERPROFILE=%DC_SDK_V2_PLAYGROUND_HOME%"
set "HOME=%DC_SDK_V2_PLAYGROUND_HOME%"
set "DC_SDK_V2_PLAYGROUND=1"
set "DC_SDK_V2_EXPERIMENTAL_MRTR=1"
set "DC_SDK_V2_FORCE_LEGACY_STDIO=1"

node.exe "%DC_REPO_ROOT%\dist\index.js" --no-onboarding
exit /b %ERRORLEVEL%
