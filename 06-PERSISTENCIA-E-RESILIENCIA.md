# 06 — Persistência, Resiliência e Auto-Update

> Rodada de 2026-08-29. Resolve os três problemas relatados no uso real pelo
> iPhone (Web App do Safari adicionado à Tela de Início).

## O problema que existia

| Sintoma relatado | Causa raiz |
|---|---|
| "Se eu saio e volto no site, as janelas que eu tinha aberto sumiram" | O estado (`activeSessions`) vivia **só na memória do JS**. Qualquer recarga — inclusive o iOS matando o Web App em segundo plano — zerava tudo. |
| "Ele trava num momento específico da janela" | O iOS suspende a página em segundo plano. O `RTCPeerConnection` morre, mas o `<video>` **mantém o último quadro decodificado** na tela. Nada detectava nem reconectava: a imagem congelada parecia ao vivo. |
| "Preciso de Ctrl+F5 para atualizar" | O cache-busting era manual (`?v=20260828_v5`). Esquecer de incrementar = Safari servindo JS/CSS velhos do cache do app. |
| *(não relatado, encontrado na análise)* | Cliente sumindo sem chamar `/api/stop` deixava **ffmpeg órfão** consumindo CPU para sempre. |
| *(não relatado, encontrado na análise)* | `proc.stdout.read()` bloqueante dentro de um gerador `async` **travava o event loop inteiro** — um MJPEG lento derrubava todos os outros streams e a API junto. |

---

## 1. Persistência do layout (`localStorage`)

Chave `streammonitor.layout.v2`, gravada a cada mutação (adicionar, fechar,
pausar, trocar modo, ocultar, mudar FPS) e também em `pagehide` /
`visibilitychange`.

```jsonc
{
  "fps": 30, "master": true, "savedAt": 1787976000000,
  "cards": [{ "key": "kab12cd34",           // id estável do CARD, não da janela
              "id_hex": "0x04000006", "id_dec": 67108870,
              "title": "…", "app_class": "…", "pid": 3527446,
              "mode": "webrtc", "paused": false, "ghost": false }]
}
```

### Por que a chave é do card, e não da janela

O id do X11 **muda** quando a janela é fechada e reaberta. Se o card fosse
identificado pelo id da janela, reabrir o app perderia o card. Então cada card
tem um `key` próprio e a janela é **reencontrada** por uma cascata de critérios
(`resolveWindow`):

1. `id_hex` idêntico — o caso comum;
2. `app_class` + `title` idênticos — sobrevive ao reinício do app;
3. `pid` + `app_class` — sobrevive à mudança de título;
4. única janela livre daquela `app_class`.

Se nada casar, **o card não é apagado**: entra em estado `waiting`
("Janela não está aberta no Acer — aguardando…") e `retryWaitingCards` reata
sozinho a cada 5 s quando a janela voltar. Era esse o pedido de
*"não deve fechar as janelas abertas quando eu sair e entrar"*.

---

## 2. Nunca congelar — watchdog + resync

### Watchdog (a cada 2,5 s)

Distingue três situações que antes eram confundidas:

| Situação | Como é detectada | Prazo |
|---|---|---|
| Congelou (já entregou imagem e parou) | `lastFrameAt` parado | `STALL_TIMEOUT_MS` = 6 s |
| Nunca entregou imagem | `lastFrameAt == 0` | `CONNECT_TIMEOUT_MS` = 20 s |
| Queda transitória de rede | `connectionState === "disconnected"` | `DISCONNECT_GRACE_MS` = 5 s |

> **Bug corrigido nesta rodada:** o `lastFrameAt` era carimbado quando o WebRTC
> chegava a `connected`. Mas `connected` é só o transporte de pé — não garante
> imagem. Isso fazia o watchdog aplicar o prazo de "congelou" (6 s) a uma conexão
> que ainda estava nascendo, virando **loop infinito de reconexão**, e ainda
> desarmava o fallback para MJPEG. Hoje `lastFrameAt` significa
> **estritamente "chegou quadro de verdade"**.

### Volta do segundo plano

`visibilitychange`, `pageshow` (bfcache do Safari) e `online` disparam
`resyncAll()`: relista as janelas do X11, reata os cards e **reinicia todo
stream ativo**. É o que garante *"se travar deve carregar como está o momento
atual"* — nunca o quadro de quando o app foi minimizado. Ausências abaixo de
2,5 s não disparam resync (evita thrash ao alternar de aba).

### MJPEG lido por stream, não por `<img src>`

O `<img src="…/mjpeg">` nativo **não avisa a cada quadro** (o Chrome dispara
`load` uma única vez), então era impossível saber se tinha congelado. Agora o
multipart é lido no próprio JS (`fetch` + `ReadableStream`), parseando
`Content-Length` e pintando cada JPEG via `blob:` URL. Cada quadro carimba
`lastFrameAt` — o watchdog passa a enxergar congelamento real. De bônus, o
`AbortController` encerra o ffmpeg do servidor no instante em que o card fecha.

### Fallback automático WebRTC → MJPEG

O WebRTC precisa furar o NAT direto até o Acer; em algumas redes móveis isso
simplesmente não acontece (verificado: o navegador envia os *binding requests* e
recebe **zero** respostas). Após 2 tentativas sem **um** quadro sequer, o card
cai sozinho para MJPEG, que viaja pelo túnel HTTP e sempre passa. Melhor imagem
com meio segundo de atraso do que um card preto. O botão `⚡`/`🖼️` continua
permitindo a escolha manual.

---

## 3. Sem Ctrl+F5 — build id automático

O servidor calcula um `build id` = hash de (mtime, tamanho) de
`index.html`, `app.js`, `styles.css` e `manifest.json`. Ele é:

- injetado no HTML (`window.STREAM_MONITOR_BUILD` e `?v=<build>` nos assets);
- exposto em `GET /api/version`.

O frontend compara o build que carregou com o do servidor a cada 30 s **e ao
voltar do segundo plano**; se mudou, salva o layout e chama `location.reload()`.

Política de cache resultante:

| Recurso | `Cache-Control` |
|---|---|
| `/` e `/api/*` | `no-store, no-cache, must-revalidate, max-age=0` |
| `/static/*?v=<build atual>` | `public, max-age=31536000, immutable` |
| `/static/*` sem versão (ícones, manifest) | `public, max-age=300, must-revalidate` |

Ou seja: **o index nunca vem de cache** (é ele que carrega o build novo), e os
assets versionados são cacheados agressivamente — o app abre rápido no 4G sem
nunca servir código velho. Editar qualquer arquivo do frontend muda o build
sozinho; **não existe mais número de versão para lembrar de incrementar**.

---

## 4. Higiene de sessões no servidor

- **Keepalive:** o cliente faz `POST /api/keepalive` a cada 20 s com os ids de
  sessão vivos. Um *reaper* roda a cada 15 s e encerra sessões sem keepalive há
  mais de 75 s, ou com `connectionState` em `failed`/`closed`. Sem isso, um
  iPhone que perde a rede deixava ffmpeg rodando para sempre.
  Se o servidor responder que a sessão é `unknown` (backend reiniciou), o
  cliente renegocia na hora.
- **Substituição por (cliente, card):** uma nova oferta encerra a sessão
  anterior **do mesmo card do mesmo dispositivo**.
  ⚠️ Deduplicar por *janela* seria errado — dois celulares vendo a mesma janela
  derrubariam um ao outro. Daí o `client_id` (persistido no `localStorage`) e o
  `card_key` irem no payload da oferta.
- **MJPEG não bloqueia mais o event loop:** a leitura do `stdout` do ffmpeg
  passou para `run_in_executor`.
- **Um card por janela:** o frontend recusa abrir dois cards na mesma janela
  (brigariam pela mesma sessão), inclusive na restauração do layout.

---

## Como validar

```bash
# build muda sozinho ao editar o frontend
curl -s localhost:3090/api/version

# política de cache
B=$(curl -s localhost:3090/api/version | jq -r .build)
curl -sI "localhost:3090/static/app.js?v=$B" | grep -i cache-control   # immutable
curl -sI "localhost:3090/"                   | grep -i cache-control   # no-store

# pipeline WebRTC ponta a ponta (deve receber 30 frames com PTS avançando)
.venv/bin/python scripts/test_webrtc.py

# reaper: criar sessão e não mandar keepalive → sessions volta a 0 em ~75 s
watch -n5 'curl -s localhost:3090/healthz'
```

## Resultados medidos em 2026-08-29

- WebRTC ponta a ponta: **30 quadros**, 654x410, PTS avançando, `connected`.
- MJPEG: parser extraiu **13 JPEGs íntegros** (SOI/EOI válidos) de uma amostra
  de 4 s; no navegador, idade do último quadro **24–30 ms**.
- Persistência: layout sobreviveu a recarga, com stream voltando ao vivo.
- Auto-update: aba aberta se recarregou sozinha ao mudar o build.
- Reaper: sessão abandonada encerrada aos **75 s**; zero ffmpeg órfão.
