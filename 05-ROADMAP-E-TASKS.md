# 📋 Roadmap e Instruções para o Agente de Desenvolvimento

Este documento serve como **plano de execução passo a passo** para o agente de IA que for implementar o projeto.

---

## 🎯 Fases de Implementação

### 🔹 Fase 1: Mapeamento de Janelas e Backend Base
- [ ] Criar ambiente virtual Python (`uv venv` em `/home/acer/Documentos/stream-monitor/.venv`).
- [ ] Instalar dependências base (`fastapi`, `uvicorn`, `websockets`, `aiortc` ou integrador `MediaMTX/go2rtc`).
- [ ] Criar módulo `window_manager.py`:
  - Função para listar janelas (`wmctrl -l -G -p -x`).
  - Filtrar janelas especiais irrelevantes (desktop nemo, docks, barras de painel).
  - Retornar JSON estruturado: `[{ id_hex, id_dec, title, app_class, pid, x, y, width, height, desktop }]`.
  - Função para gerenciar envio de janelas para workspaces secundários (para manter renderização sem ocupar tela física).

### 🔹 Fase 2: Pipeline de Captura de Vídeo e Streaming
- [ ] Implementar captura via FFmpeg `x11grab` por `window_id` ou coordenadas.
- [ ] Testar encoding ultra-rápido (`libx264 -preset ultrafast -tune zerolatency`).
- [ ] Criar mecanismo de sinalização WebRTC para entregar o stream de vídeo ao navegador.
- [ ] Garantir que o processo FFmpeg finalize automaticamente quando o cliente desconectar do stream.

### 🔹 Fase 3: Interface Web (Frontend Grid CFTV)
- [ ] Criar SPA simples e responsiva (`index.html`, `styles.css`, `app.js`).
- [ ] Header com:
  - Indicador de status (Conectado / Desconectado / Stream Ativo).
  - **Botão Master `[ ▶ Iniciar Stream ]` / `[ ⏹ Parar Stream ]`**.
  - Botão `[ + Adicionar Janela ]` que abre modal com a lista de janelas ativas.
  - Seletor de layout (Grade 1x1, 2x2, 3x3, etc.).
- [ ] Cada card de janela na grade:
  - Título da janela e ícone da aplicação.
  - Tag `<video>` exibindo o stream em tempo real.
  - **Botão individual `[ ▶ / ⏸ ]` de Start/Stop daquela janela.**
  - Botão de fechar `[ ✕ ]` (remove o card e finaliza o processo FFmpeg).
  - Botão de Fullscreen individual `[ ⛶ ]`.
  - **Zero listeners de entrada:** O elemento `<video>` não repassa nenhum clique ou tecla para o backend.

### 🔹 Fase 4: Deploy e Integração Cloudflare
- [ ] Configurar porta `:3090` no Cloudflare Tunnel para `stream.cursar.space`.
- [ ] Criar serviço do systemd (`~/.config/systemd/user/stream-monitor.service`).
- [ ] Testar acesso via navegador móvel e desktop em `https://stream.cursar.space`.

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
