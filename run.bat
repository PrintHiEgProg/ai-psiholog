@echo off
REM Запуск в Windows: run.bat
cd /d "%~dp0"
if not exist .venv (
  echo Creating venv...
  python -m venv .venv
  .venv\Scripts\pip install --upgrade pip
  .venv\Scripts\pip install -r requirements.txt
)
if not exist .env copy .env.example .env
echo http://127.0.0.1:8000
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
