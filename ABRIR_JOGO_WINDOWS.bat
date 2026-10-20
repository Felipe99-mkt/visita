@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Apartamento SF 3D - servidor local
echo  ------------------------------
echo  O jogo vai abrir no navegador em alguns segundos.
echo  NAO feche esta janela enquanto estiver jogando.
echo  Para encerrar, feche esta janela.
echo.
where py >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 2 >nul & start http://localhost:8000"
  py -m http.server 8000
  goto fim
)
python --version >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 2 >nul & start http://localhost:8000"
  python -m http.server 8000
  goto fim
)
echo  O Python nao esta instalado neste computador.
echo  Abra a Microsoft Store, procure por "Python 3.12", clique em Obter
echo  e depois de instalar de dois cliques neste arquivo de novo.
:fim
pause
