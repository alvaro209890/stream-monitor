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

### ⚡ 2.2 Eficiência e Baixo Consumo de Recursos
- **Captura Sob Demanda:** Se nenhuma janela estiver sendo visualizada no site, **nenhum encoder FFmpeg roda**.
- **Destruição de Sessões Ociosas:** Quando o usuário fecha um card de vídeo na interface, o processo de captura e encoding correspondente é finalizado imediatamente via `SIGTERM`.
- **Aceleração por Hardware:** Uso prioritário do encoder VAAPI da APU AMD Lucienne (`h264_vaapi`) ou perfil `ultrafast` + `zerolatency` no `libx264` para manter o consumo de CPU abaixo de 5-10% por stream.

### 🌐 2.3 Roteamento e Acesso
- O serviço escutará em porta dedicada do Acer (ex: `127.0.0.1:3090` para API/Web e porta UDP/TCP WebRTC).
- Integrado ao Cloudflare Tunnel configurado para responder no subdomínio `stream.cursar.space`.

---

## 3. Protocolo de Transmissão (Por que WebRTC?)

| Característica | WebRTC | HLS / DASH | WebSocket + MSE | MJPEG |
|---|---|---|---|---|
| **Latência** | **~50–150 ms** | 2–6 segundos | ~200–500 ms | ~100 ms |
| **Consumo de Banda** | **Baixo (H.264 adaptativo)** | Baixo | Médio | Altíssimo |
| **Suporte a Múltiplos Streams** | **Nativo** | Médio | Bom | Médio |
| **Compatibilidade Mobile** | **100% (iOS/Android)** | 100% | Requer MSE | 100% |

**Decisão:** O padrão de transmissão deve ser **WebRTC** para latência em tempo real e suporte perfeito no navegador do celular/desktop.
