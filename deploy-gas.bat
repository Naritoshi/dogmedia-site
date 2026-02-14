@echo off
setlocal

REM バッチファイルのあるディレクトリに移動（パスずれ防止）
cd /d "%~dp0"

REM GASスクリプトをGitにコミットし、claspでデプロイするバッチファイル

echo.
echo ==================================================
echo  GAS Script Deploy Tool
echo ==================================================
echo.

REM 1. コミットメッセージの取得（引数があれば使用、なければ入力）
set msg=%~1
if "%msg%"=="" (
    set /p msg="Enter commit message for GAS script: "
)
if "%msg%"=="" (
    echo.
    echo Error: Commit message cannot be empty. Aborting.
    pause
    exit /b
)

REM 2. Gitにコミット & プッシュ
echo.
echo [1/2] Committing and pushing to GitHub...
git add gas-script/
git commit -m "%msg%"
git push origin main

REM 3. claspでプッシュ
echo.
echo [2/2] Pushing to Google Apps Script server...

REM gas-scriptフォルダに移動 (pushdを使用)
pushd gas-script

REM Windowsで外部コマンドを呼ぶときは call が必須
call clasp push

REM 元の場所に戻る
popd

echo.
echo ========== All tasks completed! ==========
pause