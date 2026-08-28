# 🖥️ Stream Monitor — CFTV de Janelas do Acer

Sistema de transmissão de vídeo em tempo real (*view-only*, sem controles de mouse/teclado) para visualização e monitoramento de janelas específicas do PC Acer através do navegador web, acessível pelo domínio `*.cursar.space`.

---

## 🎯 Objetivo

Permitir que o usuário abra um painel web em qualquer dispositivo (celular, tablet, outro PC) e:
1. Veja uma lista em tempo real de todas as janelas abertas no Acer.
2. Abra múltiplas janelas simultaneamente em uma grade (estilo CFTV / central de monitoramento).
3. Transmita o conteúdo de cada janela de forma individual e com latência ultra-baixa (< 200ms).
4. Visualize janelas mesmo que estejam ocultas/minimizadas para o usuário físico no monitor do Acer (usando a técnica de workspaces fantasmas no X11).
5. **Controle de Início / Parada:** Controle global e individual por botão (*Start/Stop Stream*), economizando 100% de CPU/GPU quando inativo.
6. **Autostart no Boot:** O backend e o túnel iniciam automaticamente junto com a inicialização do PC (via `systemd --user` + linger ativo), ficando 100% disponível 24/7 sem necessidade de inicialização manual.
7. **Garantia de segurança view-only:** O frontend não possui código para capturar ou transmitir cliques, movimentos de mouse ou teclas.

---

## 📂 Documentação para Desenvolvimento por IA / Dev

Esta pasta contém toda a especificação técnica detalhada, mapeamento do hardware deste PC e guias passo a passo:

| Arquivo | Descrição |
|---|---|
| [**`01-ARQUITETURA.md`**](./01-ARQUITETURA.md) | Visão geral da arquitetura, fluxo de dados, WebRTC, API, ciclo de Start/Stop e isolamento view-only. |
| [**`02-CAPTURA-X11-E-JANELAS.md`**](./02-CAPTURA-X11-E-JANELAS.md) | Comandos X11, manipulação de janelas, resolução do problema de janelas minimizadas e pipelines de encoder (FFmpeg / VAAPI). |
| [**`03-STACK-E-TECNOLOGIAS.md`**](./03-STACK-E-TECNOLOGIAS.md) | Opções de stack recomendadas (Python `aiortc` vs Node.js + `go2rtc` / MediaMTX), frontend SPA, botões de ação e players. |
| [**`04-INFRA-E-DEPLOY-CURSAR.md`**](./04-INFRA-E-DEPLOY-CURSAR.md) | Portas no Acer, configuração de Cloudflare Tunnel para `stream.cursar.space`, systemd units. |
| [**`05-ROADMAP-E-TASKS.md`**](./05-ROADMAP-E-TASKS.md) | Checklist e fases de implementação prontas para um agente de IA executar. |

---

## 💻 Ambiente do Host (Acer)

- **SO:** Linux Mint / Ubuntu (Kernel 7.0.0-30-generic x86_64)
- **Desktop:** Cinnamon sobre **X11** (`DISPLAY=:0`)
- **GPU:** AMD Radeon Graphics (Renoir/Lucienne) com suporte a VAAPI (`h264_vaapi`) e encoder CPU `libx264`
- **Ferramentas pré-instaladas:** `wmctrl`, `xdotool`, `xwininfo`, `xprop`, `xrandr`, `ffmpeg`, `node` v22, `python3` (3.11/3.12 + `uv`), `cloudflared`
- **Domínio base:** `cursar.space` (Cloudflare Tunnel)

---

## 🚀 Status do Projeto

- [x] Repositório inicializado e público (`alvaro209890/stream-monitor`)
- [x] Especificação e arquitetura documentadas (incluindo controles de Start/Stop)
- [ ] Fase 1: Backend de escaneamento X11 e teste de pipeline de vídeo
- [ ] Fase 2: Servidor WebRTC / Streamer multi-janela com ciclo Start/Stop
- [ ] Fase 3: Frontend Grid com seletor de janelas e botões de Start/Stop
- [ ] Fase 4: Integração com Cloudflare Tunnel (`stream.cursar.space`)
- [ ] Fase 5: Configuração e validação de Autostart no boot do sistema (`systemd --user`)
