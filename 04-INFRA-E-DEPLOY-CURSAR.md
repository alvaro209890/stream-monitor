# 🌐 Infraestrutura, Rede e Deploy no Domínio `cursar.space`

## 1. Mapeamento de Portas no Acer

Para evitar conflitos com outros serviços do Acer (conforme o mapa canônico de portas do Segundo Cérebro em `01-infra/portas.md`):

| Serviço | Porta Escolhida | Protocolo | Bind |
|---|---|---|---|
| **Stream Monitor Web & API** | **`3090`** | HTTP / WebSocket | `127.0.0.1` |
| **Sinalização WebRTC / Gateway** | **`8554` / `8555`** | TCP / UDP (WebRTC) | `127.0.0.1` (ou `0.0.0.0`) |

*(A faixa `:3090` está livre e dentro do padrão de microsserviços Node/Python do Acer).*

---

## 2. Configuração do Cloudflare Tunnel

O Acer já possui o `cloudflared` configurado com o túnel ID `86e60118-b872-4f40-a121-c56c4955974c`.

### 2.1 Adicionar Hostname no Ingress

Edite o arquivo `/etc/cloudflared/config.yml` (ou o config local correspondente):

```yaml
tunnel: 86e60118-b872-4f40-a121-c56c4955974c
credentials-file: /home/acer/.cloudflared/86e60118-b872-4f40-a121-c56c4955974c.json

ingress:
  - hostname: stream.cursar.space
    service: http://127.0.0.1:3090
    originRequest:
      noTLSVerify: true
      tcpKeepAlive: 60s
  - hostname: limites.cursar.space
    service: http://127.0.0.1:4173
  - hostname: ia.cursar.space
    service: http://localhost:11434
  - service: http_status:404
```

### 2.2 Criar o Registro DNS no Cloudflare

```bash
cloudflared tunnel route dns 86e60118-b872-4f40-a121-c56c4955974c stream.cursar.space
```

---

## 3. Configuração de Serviço Systemd (`systemd --user`)

Para que o servidor rode de forma autônoma e inicie com o boot do sistema:

### Criar `~/.config/systemd/user/stream-monitor.service`:

```ini
[Unit]
Description=Stream Monitor — CFTV de Janelas X11
After=graphical-session.target network.target

[Service]
Type=simple
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/acer/.Xauthority
WorkingDirectory=/home/acer/Documentos/stream-monitor
ExecStart=/home/acer/Documentos/stream-monitor/.venv/bin/python backend/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### Ativação do Serviço no Boot:

```bash
# 1. Garantir que serviços do usuário rodem sem precisar de login interativo
loginctl enable-linger acer

# 2. Recarregar e habilitar para início automático
systemctl --user daemon-reload
systemctl --user enable stream-monitor
systemctl --user start stream-monitor

# 3. Verificar status
systemctl --user status stream-monitor
```

---

## 4. Acesso e Segurança

1. **Acesso Público com Segurança:**
   - URL: `https://stream.cursar.space`
   - Opcionalmente, pode ser protegido via **Cloudflare Access (PIN de e-mail / Google OAuth)** se o Álvaro desejar restringir o acesso apenas a ele.
2. **Acesso Interno / Tailscale:**
   - Pode ser acessado diretamente na rede privada via IP do Acer: `http://100.102.202.63:3090`.
