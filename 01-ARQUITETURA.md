# 🏗️ Arquitetura do Sistema — Stream Monitor

## 1. Visão Geral

O **Stream Monitor** é composto por duas camadas principais rodando localmente no Acer e acessadas remotamente via túnel seguro da Cloudflare:

```
┌─────────────────────────────────────────────────────────────┐
│                    NAVEGADOR REMOTO / CLIENTE               │
│  - Grid de Vídeos HTML5 (<video autoplay playsinline>)      │
│  - Seletor de Janelas X11 ativas                            │
│  - Zero listeners de mouse / teclado (Estritamente View)    │
└──────────────────────────────▲──────────────────────────────┘
                               │ WebRTC (WSS / DataChannel / MediaStream)
                               │ HTTPS (REST API / WebSocket)
┌──────────────────────────────▼──────────────────────────────┐
│             CLOUDFLARE TUNNEL (stream.cursar.space)         │
└──────────────────────────────▲──────────────────────────────┘
                               │ Loopback Local (:3090)
┌──────────────────────────────▼──────────────────────────────┐
│                    BACKEND STREAM MONITOR                   │
│                                                             │
│ 1. API de Janelas (FastAPI / Express):                      │
│    - Lista janelas X11 via `wmctrl` / `xwininfo`            │
│    - Fornece IDs (hex/dec), títulos, dimensões e ícones     │
│    - Monitora foco e ciclo de vida das janelas              │
│                                                             │
│ 2. Motor de Captura e Encoding:                             │
│    - Captura X11 por Window ID via `x11grab` / GStreamer    │
│    - Encoder H.264 ultra-fast (VAAPI AMD ou libx264 ultrafast)│
│    - Transcodificação sob demanda (só processa se aberto)   │
│                                                             │
│ 3. Servidor de Sinalização WebRTC:                          │
│    - Negociação SDP Offer/Answer                            │
│    - Envio do stream de vídeo direto peer-to-peer/SFU       │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Princípios de Design

### 🔒 2.1 Estritamente View-Only (Sem Controle)
- O frontend não envia posições de ponteiro, cliques, scroll ou eventos de tecla.
- O backend **não possui** endpoints ou comandos para injetar eventos de entrada (sem `xdotool click`, `uinput` ou similar).
- Não há risco de ações acidentais ou comandos indesejados disparados pelo navegador.

### ⚡ 2.2 Eficiência, Baixo Consumo e Ciclo Start / Stop
- **Botões de Iniciar / Parar (Start / Stop):**
  - **Individual:** Cada card de janela possui um botão para pausar/desligar o stream daquela janela individualmente.
  - **Master / Global:** No topo da página existe um botão de *Ligar/Desligar Monitoramento* que inicia ou derruba todas as transmissões de uma vez.
- **Captura Estritamente Sob Demanda:** Se o stream estiver parado ou nenhuma janela estiver sendo visualizada, **nenhum processo FFmpeg roda**.
- **Destruição Imediata:** Ao clicar em Parar ou fechar o card, o processo de encoding associado recebe `SIGTERM` e libera 100% de CPU/GPU.
- **Aceleração por Hardware:** Uso prioritário do encoder VAAPI da APU AMD Lucienne (`h264_vaapi`) ou perfil `ultrafast` + `zerolatency` no `libx264`.

### 🌐 2.3 Roteamento e Acesso
- O serviço escutará em porta dedicada do Acer (ex: `127.0.0.1:3090` para API/Web e porta UDP/TCP WebRTC).
- Integrado ao Cloudflare Tunnel configurado para responder no subdomínio `stream.cursar.space`.

### 🚀 2.4 Inicialização Automática com o Boot (Autostart)
- **Serviço Systemd User:** O backend do Stream Monitor é gerenciado pelo systemd do usuário (`~/.config/systemd/user/stream-monitor.service`).
- **Persistência Sem Login (Linger):** Com `loginctl enable-linger acer`, o serviço e a API WebRTC sobem no boot do sistema operacional sem exigir que a tela física seja desbloqueada ou que uma sessão manual seja aberta.
- **Ambiente Gráfico Conectado:** O serviço é configurado com `DISPLAY=:0` e `XAUTHORITY=/home/acer/.Xauthority` para ter acesso imediato ao servidor X11 assim que a sessão gráfica estiver disponível.

---

## 3. Protocolo de Transmissão (Por que WebRTC?)

| Característica | WebRTC | HLS / DASH | WebSocket + MSE | MJPEG |
|---|---|---|---|---|
| **Latência** | **~50–150 ms** | 2–6 segundos | ~200–500 ms | ~100 ms |
| **Consumo de Banda** | **Baixo (H.264 adaptativo)** | Baixo | Médio | Altíssimo |
| **Suporte a Múltiplos Streams** | **Nativo** | Médio | Bom | Médio |
| **Compatibilidade Mobile** | **100% (iOS/Android)** | 100% | Requer MSE | 100% |

**Decisão:** O padrão de transmissão deve ser **WebRTC** para latência em tempo real e suporte perfeito no navegador do celular/desktop.
