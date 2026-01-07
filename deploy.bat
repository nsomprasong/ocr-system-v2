@echo off
echo ========================================
echo   Deploy OCR Project to Firebase
echo ========================================
echo.

echo [1/4] Checking Firebase project...
firebase use ocr-system-c3bea
if %errorlevel% neq 0 (
    echo ERROR: Failed to set Firebase project
    pause
    exit /b 1
)

echo.
echo [2/4] Building frontend...
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo.
echo [3/4] Installing Functions dependencies...
cd functions
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install Functions dependencies
    cd ..
    pause
    exit /b 1
)
cd ..

echo.
echo [4/4] Deploying to Firebase...
firebase deploy
if %errorlevel% neq 0 (
    echo ERROR: Deploy failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Deploy Complete!
echo ========================================
echo.
echo Your app is available at:
echo   https://ocr-system-c3bea.web.app
echo   https://ocr-system-c3bea.firebaseapp.com
echo.
pause
