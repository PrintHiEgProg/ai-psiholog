#!/usr/bin/env bash
# Запуск: ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "→ создаю виртуальное окружение"
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ создан .env из .env.example"
fi

echo "→ http://127.0.0.1:8000"
exec ./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
