# 📋 Roadmap e Instruções para o Agente de Desenvolvimento

Este documento serve como **plano de execução passo a passo** para o agente de IA que for implementar o projeto.

---

## 🎯 Fases de Implementação

### 🔹 Fase 1: Mapeamento de Janelas e Backend Base
- [x] Criar ambiente virtual Python (`uv venv` em `/home/acer/Documentos/stream-monitor/.venv`).
- [x] Instalar dependências base (`fastapi`, `uvicorn`, `websockets`, `aiortc`, `av`, `psutil`).
- [x] Criar módulo `window_manager.py`:
  - [x] Função para listar janelas (`wmctrl -l -G -p -x`).
  - [x] Filtrar janelas especiais irrelevantes (desktop nemo, docks, barras de painel).
  - [x] Retornar JSON estruturado: `[{ id_hex, id_dec, title, app_class, pid, x, y, width, height, desktop }]`.
  - [x] Função para gerenciar envio de janelas para workspaces secundários.

### 🔹 Fase 2: Pipeline de Captura de Vídeo e Streaming
- [x] Implementar captura via X11 `x11grab` PyAV por `window_id` e offset.
- [x] Criar mecanismo de sinalização WebRTC para entregar o stream de vídeo ao navegador.
- [x] Garantir que o processo de captura finalize automaticamente ao pausar ou fechar.

### 🔹 Fase 3: Interface Web (Frontend Grid CFTV)
- [x] Criar SPA responsiva (`index.html`, `styles.css`, `app.js`).
- [x] Header com indicador de status, botão Master Start/Stop e botão de adicionar janela.
- [x] Grid CFTV com cards individuais de vídeo, botão individual de Start/Stop, fullscreen e fechar.
- [x] Zero listeners de entrada (`pointer-events: none` no vídeo).

### 🔹 Fase 4: Deploy e Integração Cloudflare
- [x] Configurar porta `:3090` e criar túnel Cloudflare dedicado `stream.cursar.space`.
- [x] Criar e habilitar serviços do systemd (`stream-monitor.service` + `cloudflared-stream-monitor.service`).
- [x] Habilitar autostart no boot via `loginctl enable-linger acer` + systemd user.
- [x] Validado acesso online em `https://stream.cursar.space`.

---

## 🧪 Comandos de Validação e Teste Rápido

### Testar listagem de janelas no terminal:
```bash
python3 -c "
import subprocess, re
out = subprocess.check_output(['wmctrl', '-l', '-G', '-p', '-x'], text=True)
for line in out.strip().split('\n'):
    parts = re.split(r'\s+', line, maxsplit=8)
    if len(parts) >= 9 and 'nemo-desktop' not in parts[7]:
        print(f'ID: {parts[0]} | PID: {parts[2]} | App: {parts[7]} | Titulo: {parts[8]}')
"
```

### Testar captura FFmpeg de uma janela para arquivo de teste:
```bash
# Pega o ID decimal da primeira janela Chrome aberta:
WIN_ID_HEX=$(wmctrl -l | grep -i "chrome" | head -n 1 | awk '{print $1}')
WIN_ID_DEC=$((16#${WIN_ID_HEX#0x}))
echo "Gravando 5 segundos da janela ID: $WIN_ID_HEX ($WIN_ID_DEC)..."

ffmpeg -y -f x11grab -framerate 30 -window_id $WIN_ID_DEC -i :0.0 -t 5 -c:v libx264 -preset ultrafast /tmp/test-stream.mp4
```
