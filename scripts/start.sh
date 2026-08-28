#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

if [ ! -d ".venv" ]; then
    echo "Criando virtualenv..."
    uv venv .venv
    source .venv/bin/activate
    uv pip install -r backend/requirements.txt
else
    source .venv/bin/activate
fi

export DISPLAY=:0
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}

echo "Iniciando Stream Monitor em http://127.0.0.1:3090..."
python -m uvicorn backend.app:app --host 127.0.0.1 --port 3090
