# 🛠️ Stack Tecnológica e Arquitetura de Implementação

Para garantir rapidez no desenvolvimento, estabilidade e baixíssimo uso de recursos, temos duas abordagens viáveis recomendadas:

---

## 🥇 Opção 1 (Recomendada): Node.js / Python + go2rtc / MediaMTX

Essa é a abordagem mais robusta e profissional para WebRTC com FFmpeg no Linux:

```
[ Frontend SPA (Vanilla / React / Vue) ]
                  ▲ (WebRTC / WSS)
                  │
[ MediaMTX ou go2rtc (Binário Leve WebRTC Gateway) ]
                  ▲ (RTSP / RTMP / Raw pipe)
                  │
[ Backend Stream-Monitor (Python FastAPI / Node.js) ] ──> Gera streams FFmpeg sob demanda
```

### Vantagens:
- `go2rtc` ou `MediaMTX` gerenciam todo o handshake WebRTC (STUN, ICE, SDP, DTLS, SRTP) com perfeição nativa.
- Suporta transmissão para múltiplos clientes simultâneos sem re-encodar o vídeo.
- O Backend só precisa orquestrar os processos FFmpeg via CLI quando uma janela for solicitada.

---

## 🥈 Opção 2: Python Puro com `aiortc` + `FastAPI`

Uma solução 100% Python em um único serviço self-contained:

### Componentes:
- **FastAPI / Uvicorn:** Servidor HTTP da API REST e WebSockets para listagem de janelas e sinalização WebRTC.
- **`aiortc` + `av`:** Biblioteca Python para WebRTC e manipulação de vídeo.
- **`python-xlib` ou subprocessos (`wmctrl` / `xwininfo`):** Mapeamento e monitoramento de janelas.

### Vantagens:
- Código unificado em um único repositório e processo.
- Zero dependência de binários externos além do Python e FFmpeg.

---

## 🎨 Especificação do Frontend

### Diretrizes de UI/UX:
- **Tema:** Dark mode elegante (paleta estilo GitHub Dark / Monospace).
- **Layout:**
  - **Header:** Status de conexão, FPS geral, botão `+ Adicionar Janela` e contador de janelas ativas.
  - **Sidebar / Modal de Seleção:** Lista de janelas ativas com ícones de app (Chrome, VS Code, Terminal, etc.), PID e resolução.
  - **Área de Grid (CFTV):**
    - Layout configurável (1x1, 1x2, 2x2, 3x3 ou auto-ajustável estilo Zoom/Meet).
    - Cada card de janela possui:
      - Tag `<video>` em tempo real (sem controles de mouse/teclado).
      - Header do card com o título da janela.
      - Botão de fechar (encerra o stream).
      - Botão de tela cheia (*Fullscreen* daquele vídeo específico).
      - Indicador de latência e resolução.

---

## 📦 Estrutura de Diretórios Recomendada

```tree
stream-monitor/
├── backend/
│   ├── app.py                # Servidor FastAPI / Express
│   ├── window_manager.py     # Lógica X11 (wmctrl, xwininfo, workspaces)
│   ├── streamer.py           # Gestão de processos FFmpeg e sessões WebRTC
│   ├── requirements.txt      # Dependências Python (ou package.json)
│   └── config.py             # Portas, host e configurações de codec
├── frontend/
│   ├── index.html            # Interface SPA principal
│   ├── app.js                # Lógica de conexão WebRTC e gerência da Grid
│   ├── styles.css            # Estilização Dark Theme
│   └── assets/               # Ícones e imagens
├── scripts/
│   ├── start.sh              # Script de inicialização rápida
│   └── test-stream.sh        # Teste unitário de captura X11
├── README.md
├── 01-ARQUITETURA.md
├── 02-CAPTURA-X11-E-JANELAS.md
├── 03-STACK-E-TECNOLOGIAS.md
├── 04-INFRA-E-DEPLOY-CURSAR.md
└── 05-ROADMAP-E-TASKS.md
```
