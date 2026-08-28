# 🪟 Captura X11 e Gerenciamento de Janelas

## 1. Mapeamento de Janelas no Host (Acer)

O ambiente gráfico do Acer roda **X11** (`DISPLAY=:0`) sob o desktop manager **Cinnamon**.

### 1.1 Listagem de Janelas via CLI

Para descobrir todas as janelas abertas, classes e títulos:

```bash
# Formato: ID_HEX DESKTOP PID X Y W H CLASSE_WINDOW CLIENTE_HOST TITULO
wmctrl -l -G -p -x
```

Exemplo de saída:
```text
0x05e00019  0 1210825 0    0    1920 1040 google-chrome.Google-chrome  acer-Aspire-A515-45 Nova guia - Google Chrome
0x05200006  0 1311158 110  172  974  597  gnome-terminal-server.Gnome-terminal  acer-Aspire-A515-45 ✳ Segundo cérebro
0x04e00004  0 2810769 0    0    1920 1040 cursor.Cursor         acer-Aspire-A515-45 Cursor Agents
```

### 1.2 Obtenção de Propriedades Geométricas e Estado

```bash
# Obter detalhes precisos da janela a partir do ID decimal ou hexadecimal:
xwininfo -id 0x05e00019
```

Campos essenciais para a captura:
- `Absolute upper-left X` e `Y`
- `Width` e `Height`
- `Map State`: `IsViewable` (renderizando) vs `IsUnmapped` / `IsUnviewable` (oculta/minimizada).

---

## 2. O Desafio das Janelas Minimizadas e a Solução Técnica

### ⚠️ O Problema no X11
No servidor X11 clássico, quando uma janela é **minimizada** (`iconified`), o compositing manager suspende a renderização do seu buffer de pixels para economizar VRAM/CPU. Se o FFmpeg tentar capturar uma janela minimizada diretamente pelo seu window ID, o frame fica estático, preto ou em loop.

### ✅ A Solução: Workspaces Virtuais Fantasmas (Virtual Desktops)

O Cinnamon no Acer possui suporte a múltiplos desktops virtuais (atualmente configurados 4 espaços: `0`, `1`, `2`, `3`):

1. **Janela em Workspace Secundário:**
   - Em vez de clicar em "minimizar", uma janela pode ser enviada para o **Workspace 2, 3 ou 4** (`wmctrl -r "<janela>" -t 1`).
   - No X11 com compositing ativo, janelas em outros workspaces continuam com seus buffers de desenho atualizados pelo X Server.
   - **Resultado:** A janela fica 100% invisível na tela física do monitor do Acer, mas o FFmpeg consegue capturar normalmente a 30/60 FPS.

2. **Detecção Automática no Backend:**
   - O backend pode oferecer uma flag/opção `Ocultar no Acer`: ao marcar, o backend move a janela para o Workspace fantasma (`wmctrl -i -r <WINDOW_ID> -t 3`).
   - Ao desmarcar, devolve para o Workspace ativo (`-t 0`).

---

## 3. Pipelines de Captura com FFmpeg

### 3.1 Captura por Window ID (Direto)

O FFmpeg permite capturar a área exata de uma janela X11 passando o ID em decimal:

```bash
# Converter ID hexadecimal (ex: 0x05e00019) para decimal:
# 0x05e00019 = 98566169

ffmpeg -f x11grab \
  -framerate 30 \
  -window_id 98566169 \
  -i :0.0 \
  -c:v libx264 \
  -preset ultrafast \
  -tune zerolatency \
  -pix_fmt yuv420p \
  -f flv rtmp://127.0.0.1/live/stream1
```

### 3.2 Captura por Coordenadas / Região (Offset)

Se uma janela não suportar captura direta por `-window_id` devido a decorações de borda do window manager:

```bash
# Captura uma região baseada nas coordenadas obtidas via `xwininfo`:
# -video_size WxH -i :0.0+X,Y

ffmpeg -f x11grab \
  -framerate 30 \
  -video_size 1280x720 \
  -i :0.0+100,150 \
  -c:v libx264 \
  -preset ultrafast \
  -tune zerolatency \
  -pix_fmt yuv420p \
  -an \
  ...
```

### 3.3 Aceleração por Hardware (VAAPI AMD Lucienne)

O Acer conta com APU AMD Radeon com suporte VAAPI (`/dev/dri/renderD128`):

```bash
ffmpeg -vaapi_device /dev/dri/renderD128 \
  -f x11grab -framerate 30 -window_id 98566169 -i :0.0 \
  -vf 'format=nv12,hwupload' \
  -c:v h264_vaapi -b:v 2M -maxrate 3M -bufsize 6M \
  -f ...
```
*(Se VAAPI apresentar instabilidade em sub-regiões, o fallback `libx264 -preset ultrafast -crf 23` consome menos de 4% de CPU neste processador 6-core/12-thread AMD).*
