@echo off
REM G-TECH COMPANY - Deploy to GitHub Script
REM This script will push your code to GitHub

echo.
echo ======================================
echo G-TECH COMPANY - GitHub Deployment
echo ======================================
echo.

REM Check if GitHub CLI is installed
gh --version >nul 2>&1
if errorlevel 1 (
    echo GitHub CLI not found. Installing...
    echo Please visit: https://cli.github.com/
    echo Or use: choco install gh
    pause
    exit /b 1
)

REM Authenticate with GitHub
echo Authenticating with GitHub...
gh auth login

REM Push to repository
echo.
echo Pushing code to GitHub...
git push -u origin main

if errorlevel 0 (
    echo.
    echo ======================================
    echo SUCCESS! Code deployed to GitHub
    echo Repository: https://github.com/Gabriel-1234/G-tech
    echo ======================================
) else (
    echo.
    echo ERROR: Failed to push to GitHub
    echo Please check your credentials and try again
)

pause
