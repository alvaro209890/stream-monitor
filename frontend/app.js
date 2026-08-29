/*
 * Stream Monitor — frontend
 *
 * Três garantias que este arquivo implementa:
 *  1. PERSISTÊNCIA  — o layout de janelas vive no localStorage. Fechar o site
 *     (ou o iOS matar o Web App) não perde nada; ao voltar, os cards voltam.
 *  2. NUNCA CONGELA — watchdog por sessão detecta vídeo parado e renegocia
 *     sozinho. Voltar de segundo plano força resync: sempre o AGORA, nunca o
 *     frame velho de quando você saiu.
 *  3. SEM CTRL+F5   — o servidor carimba um build id; o app compara e recarrega
 *     sozinho quando há versão nova.
 */

const STORAGE_KEY = "streammonitor.layout.v2";
const CLIENT_ID_KEY = "streammonitor.client_id";
const BUILD = window.STREAM_MONITOR_BUILD || "dev";

/**
 * Identidade estável deste dispositivo. O servidor usa (cliente, card) para
 * saber que uma nova oferta SUBSTITUI a sessão anterior deste mesmo card —
 * sem derrubar a de outro celular que esteja vendo a mesma janela.
 */
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch (e) {
    return "c" + Math.random().toString(36).slice(2, 10);
  }
})();

// Stream que JÁ estava rodando e parou de avançar por mais que isso é reiniciado.
const STALL_TIMEOUT_MS = 6000;
// Negociação (ICE + DTLS + 1º frame) tem uma folga maior antes de desistir.
// Sem isso o watchdog mata a conexão antes dela nascer e vira loop de reconexão.
const CONNECT_TIMEOUT_MS = 20000;
// "disconnected" no WebRTC costuma se recuperar sozinho; só reinicia se persistir.
const DISCONNECT_GRACE_MS = 5000;
const WATCHDOG_INTERVAL_MS = 2500;
const METRICS_INTERVAL_MS = 4000;
const KEEPALIVE_INTERVAL_MS = 20000;
const VERSION_CHECK_INTERVAL_MS = 30000;
// Só faz resync pesado se ficou escondido mais que isso (evita thrash ao alternar aba).
const BACKGROUND_RESYNC_THRESHOLD_MS = 2500;
const REATTACH_RETRY_MS = 5000;
// Tentativas de WebRTC sem nenhum frame antes de cair para MJPEG.
const WEBRTC_FAIL_LIMIT = 2;

/** @type {Object<string, any>} sessions[key] = estado completo de um card */
let sessions = {};
let knownWindows = [];
let globalFps = 30;
let masterStreaming = true;
let hiddenSince = 0;
let restoring = false;

const $ = (id) => document.getElementById(id);

const gridContainer = $("gridContainer");
const emptyState = $("emptyState");
const modalBackdrop = $("modalBackdrop");
const windowListContainer = $("windowListContainer");
const statusDot = $("statusDot");
const statusText = $("statusText");
const valCpu = $("valCpu");
const valRam = $("valRam");
const valStreams = $("valStreams");
const btnFpsToggle = $("btnFpsToggle");
const btnMasterToggle = $("btnMasterToggle");
const masterIcon = $("masterIcon");
const masterText = $("masterText");
const bottomMasterIcon = $("bottomMasterIcon");
const bottomMasterText = $("bottomMasterText");

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { fps: 30, master: true, cards: [] };
    const data = JSON.parse(raw);
    return {
      fps: data.fps === 15 ? 15 : 30,
      master: data.master !== false,
      cards: Array.isArray(data.cards) ? data.cards : [],
    };
  } catch (e) {
    return { fps: 30, master: true, cards: [] };
  }
}

function saveLayout() {
  if (restoring) return;
  try {
    const cards = Object.values(sessions).map((s) => ({
      key: s.key,
      id_hex: s.winData.id_hex,
      id_dec: s.winData.id_dec,
      title: s.winData.title,
      app_class: s.winData.app_class,
      app_name: s.winData.app_name,
      pid: s.winData.pid,
      x: s.winData.x,
      y: s.winData.y,
      width: s.winData.width,
      height: s.winData.height,
      mode: s.mode,
      paused: s.paused,
      ghost: s.inGhostWorkspace,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fps: globalFps, master: masterStreaming, cards, savedAt: Date.now(),
    }));
  } catch (e) {
    console.warn("Não foi possível salvar o layout:", e);
  }
}

// ---------------------------------------------------------------------------
// Reconciliação de janelas
// ---------------------------------------------------------------------------

/**
 * Reencontra a janela salva na lista atual do X11. O id do X11 muda quando a
 * janela é fechada e reaberta, então caímos para título+classe, depois pid, e
 * por último classe única. É isso que faz o card sobreviver a um reinício do app.
 */
function resolveWindow(saved, windows) {
  const lower = (v) => (v || "").toLowerCase();

  let hit = windows.find((w) => lower(w.id_hex) === lower(saved.id_hex));
  if (hit) return hit;

  hit = windows.find((w) => lower(w.app_class) === lower(saved.app_class) &&
                            lower(w.title) === lower(saved.title));
  if (hit) return hit;

  hit = windows.find((w) => w.pid === saved.pid &&
                            lower(w.app_class) === lower(saved.app_class));
  if (hit) return hit;

  const sameClass = windows.filter((w) => lower(w.app_class) === lower(saved.app_class));
  const taken = new Set(Object.values(sessions).map((s) => lower(s.winData.id_hex)));
  const free = sameClass.filter((w) => !taken.has(lower(w.id_hex)) || lower(w.id_hex) === lower(saved.id_hex));
  if (free.length === 1) return free[0];

  return null;
}

async function fetchWindows() {
  try {
    const res = await fetch("/api/windows", { cache: "no-store" });
    if (!res.ok) return knownWindows;
    const data = await res.json();
    knownWindows = data.windows || [];
    setOnline(true);
  } catch (e) {
    setOnline(false);
  }
  return knownWindows;
}

function setOnline(ok) {
  if (!statusDot) return;
  statusDot.classList.toggle("online", ok);
  if (statusText) statusText.textContent = ok ? "Host Acer Online" : "Reconectando ao Acer…";
}

// ---------------------------------------------------------------------------
// Ciclo de vida de um card
// ---------------------------------------------------------------------------

function newKey() {
  return "k" + Math.random().toString(36).slice(2, 10);
}

function buildCard(key, win) {
  const card = document.createElement("div");
  card.className = "window-card";
  card.id = `card_${key}`;
  card.innerHTML = `
    <div class="card-header">
      <div class="card-title-group">
        <span class="card-app-badge" data-role="app">${escapeHtml(win.app_name)}</span>
        <span class="card-title" data-role="title" title="${escapeHtml(win.title)}">${escapeHtml(win.title)}</span>
      </div>
      <div class="card-actions">
        <button class="icon-btn" title="Ocultar/Exibir no monitor do Acer" data-role="ghost">👁️</button>
        <button class="icon-btn" title="Alternar WebRTC / MJPEG" data-role="mode">⚡</button>
        <button class="icon-btn" title="Pausar/Iniciar" data-role="toggle">⏸</button>
        <button class="icon-btn" title="Tela Cheia" data-role="full">⛶</button>
        <button class="icon-btn" title="Fechar" data-role="close">✕</button>
      </div>
    </div>
    <div class="video-wrapper">
      <video data-role="video" autoplay playsinline muted webkit-playsinline></video>
      <img data-role="mjpeg" class="hidden" style="width:100%;height:100%;object-fit:contain;pointer-events:none;" />
      <div class="card-overlay hidden" data-role="overlay">
        <div class="overlay-spinner" data-role="spinner"></div>
        <span data-role="overlay-text">Conectando…</span>
        <button class="btn btn-primary btn-sm hidden" data-role="overlay-action">▶ Retomar</button>
      </div>
    </div>
  `;
  gridContainer.appendChild(card);
  return card;
}

function setCardState(key, state, message, actionLabel) {
  const s = sessions[key];
  if (!s) return;
  s.state = state;
  const overlay = s.cardEl.querySelector('[data-role="overlay"]');
  const text = s.cardEl.querySelector('[data-role="overlay-text"]');
  const spinner = s.cardEl.querySelector('[data-role="spinner"]');
  const action = s.cardEl.querySelector('[data-role="overlay-action"]');

  s.cardEl.classList.toggle("is-waiting", state === "waiting");
  s.cardEl.classList.toggle("is-live", state === "live");

  if (state === "live") {
    overlay.classList.add("hidden");
    return;
  }
  overlay.classList.remove("hidden");
  text.textContent = message || "";
  spinner.classList.toggle("hidden", state === "paused" || state === "waiting");
  action.classList.toggle("hidden", !actionLabel);
  if (actionLabel) action.textContent = actionLabel;
}

/** Já existe um card apontando para esta janela? */
function cardForWindow(idHex, exceptKey) {
  const target = (idHex || "").toLowerCase();
  return Object.values(sessions).find(
    (s) => s.key !== exceptKey && (s.winData.id_hex || "").toLowerCase() === target);
}

async function addStreamCard(win, savedKey, saved, allowDuplicate) {
  const key = savedKey || newKey();
  if (sessions[key]) return;
  // Dois cards na mesma janela brigariam pela mesma sessão no servidor.
  // (allowDuplicate = card restaurado em espera, que não abre stream nenhum.)
  if (!allowDuplicate && cardForWindow(win.id_hex)) return;

  const card = buildCard(key, win);
  const s = {
    key,
    winData: { ...win },
    savedMeta: saved || null,
    cardEl: card,
    videoEl: card.querySelector('[data-role="video"]'),
    mjpegEl: card.querySelector('[data-role="mjpeg"]'),
    mode: (saved && saved.mode === "mjpeg") ? "mjpeg" : "webrtc",
    paused: !!(saved && saved.paused),
    inGhostWorkspace: !!(saved && saved.ghost),
    pc: null,
    sessionId: null,
    state: "connecting",
    lastFrameAt: 0,
    lastVideoTime: -1,
    startingAt: 0,
    disconnectedAt: 0,
    restarting: false,
    restarts: 0,
    webrtcFails: 0,
    mjpegAbort: null,
    mjpegObjectUrl: null,
  };
  sessions[key] = s;

  card.querySelector('[data-role="close"]').addEventListener("click", () => closeStreamCard(key));
  card.querySelector('[data-role="toggle"]').addEventListener("click", () => toggleStreamCard(key));
  card.querySelector('[data-role="full"]').addEventListener("click", () => toggleFullscreen(key));
  card.querySelector('[data-role="ghost"]').addEventListener("click", () => toggleGhostWorkspace(key));
  card.querySelector('[data-role="mode"]').addEventListener("click", () => toggleStreamProtocol(key));
  // Um único handler para o botão do overlay: o rótulo muda com o estado.
  card.querySelector('[data-role="overlay-action"]').addEventListener("click", () => {
    if (s.state === "paused") toggleStreamCard(key);
    else if (s.state === "waiting") closeStreamCard(key);
    else restartStream(key, "pedido do usuário");
  });

  if (s.inGhostWorkspace) card.querySelector('[data-role="ghost"]').textContent = "🕶️";
  if (s.mode === "mjpeg") card.querySelector('[data-role="mode"]').textContent = "🖼️";

  updateEmptyState();
  saveLayout();

  if (s.paused) {
    setCardState(key, "paused", "⏹ Stream pausado", "▶ Retomar");
    card.querySelector('[data-role="toggle"]').textContent = "▶";
  } else {
    await startStream(key);
  }
}

/** Atualiza um card para apontar para a janela (re)encontrada no X11. */
function rebindWindow(key, win) {
  const s = sessions[key];
  if (!s) return;
  s.winData = { ...win };
  s.cardEl.querySelector('[data-role="app"]').textContent = win.app_name;
  const t = s.cardEl.querySelector('[data-role="title"]');
  t.textContent = win.title;
  t.title = win.title;
  saveLayout();
}

async function startStream(key) {
  const s = sessions[key];
  if (!s || s.paused) return;
  s.startingAt = Date.now();
  s.lastFrameAt = 0;
  s.lastVideoTime = -1;
  s.disconnectedAt = 0;

  if (s.mode === "mjpeg") {
    setCardState(key, "connecting", "Abrindo MJPEG…");
    s.videoEl.classList.add("hidden");
    s.mjpegEl.classList.remove("hidden");
    startMjpegStream(key);
    return;
  }

  await startWebRtcStream(key);
}

// --- MJPEG -----------------------------------------------------------------
// O <img src="…mjpeg"> nativo não avisa a cada quadro (o Chrome dispara `load`
// uma única vez), então não dá para saber se congelou. Lemos o multipart nós
// mesmos: cada quadro extraído carimba lastFrameAt, e o watchdog passa a
// enxergar um congelamento de verdade. Bônus: o AbortController encerra o
// ffmpeg do servidor na hora em que fechamos o card.

function indexOfSeq(buf, seq, from) {
  outer:
  for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

function stopMjpegStream(s) {
  if (s.mjpegAbort) {
    try { s.mjpegAbort.abort(); } catch (e) {}
    s.mjpegAbort = null;
  }
  if (s.mjpegObjectUrl) {
    URL.revokeObjectURL(s.mjpegObjectUrl);
    s.mjpegObjectUrl = null;
  }
  if (s.mjpegEl) s.mjpegEl.removeAttribute("src");
}

async function startMjpegStream(key) {
  const s = sessions[key];
  if (!s) return;
  stopMjpegStream(s);

  const ctrl = new AbortController();
  s.mjpegAbort = ctrl;
  const url = `/api/windows/${s.winData.id_dec}/mjpeg?fps=${globalFps}&t=${Date.now()}`;

  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Navegador antigo sem ReadableStream: cai para o <img> puro.
    if (!res.body || !res.body.getReader) {
      ctrl.abort();
      s.mjpegAbort = null;
      s.mjpegEl.onload = () => { s.lastFrameAt = Date.now(); setCardState(key, "live"); };
      s.mjpegEl.src = url;
      return;
    }

    const reader = res.body.getReader();
    const CRLF2 = [13, 10, 13, 10];
    let buf = new Uint8Array(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (sessions[key] !== s || s.mjpegAbort !== ctrl) { try { reader.cancel(); } catch (e) {} return; }

      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf); merged.set(value, buf.length);
      buf = merged;

      // Extrai todos os quadros completos que já chegaram.
      while (true) {
        const headEnd = indexOfSeq(buf, CRLF2, 0);
        if (headEnd < 0) break;
        const header = new TextDecoder().decode(buf.subarray(0, headEnd));
        const m = /content-length:\s*(\d+)/i.exec(header);
        if (!m) { buf = buf.subarray(headEnd + 4); continue; }

        const len = parseInt(m[1], 10);
        const start = headEnd + 4;
        if (buf.length < start + len) break; // quadro ainda incompleto

        const jpeg = buf.slice(start, start + len);
        buf = buf.subarray(start + len);

        const objUrl = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
        const prev = s.mjpegObjectUrl;
        s.mjpegObjectUrl = objUrl;
        s.mjpegEl.src = objUrl;
        if (prev) URL.revokeObjectURL(prev);

        s.lastFrameAt = Date.now();
        if (s.state !== "live") setCardState(key, "live");
      }

      // Trava de segurança contra lixo acumulado sem cabeçalho válido.
      if (buf.length > 8 * 1024 * 1024) buf = new Uint8Array(0);
    }

    if (sessions[key] === s && s.mjpegAbort === ctrl && !s.paused) {
      restartStream(key, "stream mjpeg terminou");
    }
  } catch (err) {
    if (ctrl.signal.aborted) return; // fechamos de propósito
    console.error("Erro no MJPEG:", err);
    if (sessions[key] === s && !s.paused) {
      setCardState(key, "error", "Falha no MJPEG", "↻ Tentar de novo");
    }
  }
}

async function startWebRtcStream(key) {
  const s = sessions[key];
  if (!s || s.mode !== "webrtc" || s.paused) return;

  await teardownPeer(s);
  // Zera os relógios do watchdog: cada tentativa ganha a folga completa.
  s.startingAt = Date.now();
  s.lastFrameAt = 0;
  s.lastVideoTime = -1;
  s.disconnectedAt = 0;
  setCardState(key, "connecting", "Conectando ao Acer…");
  s.mjpegEl.classList.add("hidden");
  stopMjpegStream(s);
  s.videoEl.classList.remove("hidden");

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  s.pc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (event) => {
    if (event.track.kind !== "video") return;
    s.videoEl.srcObject = event.streams[0];
    s.lastFrameAt = Date.now();
    playVideo(s);
  };

  pc.onconnectionstatechange = () => {
    if (!sessions[key] || s.pc !== pc) return;
    const state = pc.connectionState;
    if (state === "connected") {
      s.restarts = 0;
      s.disconnectedAt = 0;
      // NÃO marcar lastFrameAt aqui: "connected" é só o transporte de pé.
      // lastFrameAt significa "chegou imagem de verdade" — é o que distingue
      // um congelamento de uma conexão que nunca entregou vídeo, e é o que
      // arma o fallback para MJPEG. O watchdog promove para "live" quando o
      // currentTime do vídeo começar a andar.
      setCardState(key, "connecting", "Conectado, aguardando imagem…");
    } else if (state === "failed" || state === "closed") {
      if (!s.paused) restartStream(key, `webrtc ${state}`);
    } else if (state === "disconnected") {
      // Transitório na maioria das vezes (troca de Wi-Fi para 4G, por exemplo).
      // Marca a hora e deixa o watchdog decidir se virou queda de verdade.
      s.disconnectedAt = Date.now();
      setCardState(key, "connecting", "Reconectando…");
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch("/api/offer", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type,
        window_id: s.winData.id_dec,
        window_id_hex: s.winData.id_hex,
        x: s.winData.x, y: s.winData.y,
        width: s.winData.width, height: s.winData.height,
        fps: globalFps,
        client_id: CLIENT_ID,
        card_key: key,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const answer = await res.json();
    if (s.pc !== pc) return; // outra negociação começou no meio do caminho
    s.sessionId = answer.session_id;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    playVideo(s);
  } catch (err) {
    console.error("Erro ao negociar WebRTC:", err);
    if (sessions[key] && s.pc === pc) {
      setCardState(key, "error", "Falha ao conectar", "↻ Tentar de novo");
    }
  }
}

function playVideo(s) {
  const p = s.videoEl.play();
  if (p && p.catch) p.catch(() => {});
}

async function teardownPeer(s) {
  if (s.sessionId) {
    const sid = s.sessionId;
    s.sessionId = null;
    try {
      await fetch(`/api/stop/${sid}`, { method: "POST", cache: "no-store", keepalive: true });
    } catch (e) {}
  }
  if (s.pc) {
    const pc = s.pc;
    s.pc = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    try { pc.close(); } catch (e) {}
  }
  if (s.videoEl) s.videoEl.srcObject = null;
}

/** Reinício completo — é o que garante "carrega como está o momento atual". */
async function restartStream(key, reason) {
  const s = sessions[key];
  if (!s || s.paused || s.restarting) return;
  s.restarting = true;
  console.log(`[restart] ${key}: ${reason}`);
  try {
    if (s.mode === "mjpeg") {
      stopMjpegStream(s);
      await startStream(key);
      return;
    }

    // O WebRTC precisa furar o NAT direto até o Acer; em algumas redes móveis
    // isso simplesmente não acontece. Depois de 2 tentativas sem UM frame
    // sequer, caímos para o MJPEG, que viaja pelo túnel HTTP e sempre passa.
    // Melhor imagem com meio segundo de atraso do que um card preto.
    if (!s.lastFrameAt) {
      s.webrtcFails += 1;
      if (s.webrtcFails >= WEBRTC_FAIL_LIMIT) {
        console.log(`[fallback] ${key}: WebRTC não conecta, mudando para MJPEG`);
        s.mode = "mjpeg";
        s.autoFellBack = true;
        const btnMode = s.cardEl.querySelector('[data-role="mode"]');
        btnMode.textContent = "🖼️";
        btnMode.title = "MJPEG automático (o WebRTC não conectou nesta rede). Toque para tentar WebRTC.";
        await teardownPeer(s);
        await startStream(key);
        saveLayout();
        return;
      }
    } else {
      s.webrtcFails = 0;
    }
    await startWebRtcStream(key);
  } finally {
    s.restarting = false;
  }
}

async function closeStreamCard(key) {
  const s = sessions[key];
  if (!s) return;
  await teardownPeer(s);
  stopMjpegStream(s);
  s.cardEl.remove();
  delete sessions[key];
  updateEmptyState();
  saveLayout();
}

async function toggleStreamCard(key) {
  const s = sessions[key];
  if (!s) return;
  const btnToggle = s.cardEl.querySelector('[data-role="toggle"]');
  s.paused = !s.paused;

  if (s.paused) {
    btnToggle.textContent = "▶";
    await teardownPeer(s);
    stopMjpegStream(s);
    setCardState(key, "paused", "⏹ Stream pausado", "▶ Retomar");
  } else {
    btnToggle.textContent = "⏸";
    await startStream(key);
  }
  saveLayout();
}

async function toggleStreamProtocol(key) {
  const s = sessions[key];
  if (!s) return;
  const btnMode = s.cardEl.querySelector('[data-role="mode"]');
  s.mode = s.mode === "webrtc" ? "mjpeg" : "webrtc";
  // Escolha manual zera o contador do fallback automático.
  s.webrtcFails = 0;
  s.autoFellBack = false;
  btnMode.textContent = s.mode === "mjpeg" ? "🖼️" : "⚡";
  btnMode.title = s.mode === "mjpeg"
    ? "Modo MJPEG ativo (toque para voltar ao WebRTC)"
    : "Modo WebRTC ativo (baixa latência)";

  await teardownPeer(s);
  stopMjpegStream(s);
  if (!s.paused) await startStream(key);
  saveLayout();
}

async function toggleGhostWorkspace(key) {
  const s = sessions[key];
  if (!s) return;
  const btnGhost = s.cardEl.querySelector('[data-role="ghost"]');
  s.inGhostWorkspace = !s.inGhostWorkspace;
  const targetWorkspace = s.inGhostWorkspace ? 1 : 0;
  try {
    const res = await fetch(`/api/windows/${s.winData.id_hex}/workspace?workspace=${targetWorkspace}`,
                            { method: "POST", cache: "no-store" });
    if (res.ok) {
      btnGhost.textContent = s.inGhostWorkspace ? "🕶️" : "👁️";
      btnGhost.title = s.inGhostWorkspace
        ? "Janela oculta no Acer (renderizando no workspace 2)"
        : "Janela visível no Acer";
      saveLayout();
    } else {
      s.inGhostWorkspace = !s.inGhostWorkspace;
    }
  } catch (err) {
    s.inGhostWorkspace = !s.inGhostWorkspace;
    console.error("Erro ao mover janela de workspace:", err);
  }
}

// ---------------------------------------------------------------------------
// Tela cheia
// ---------------------------------------------------------------------------

function toggleFullscreen(key) {
  const s = sessions[key];
  if (!s) return;
  const card = s.cardEl;
  const btnFull = card.querySelector('[data-role="full"]');

  if (card.classList.contains("fullscreen-mode")) {
    card.classList.remove("fullscreen-mode");
    btnFull.textContent = "⛶";
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      try { document.webkitExitFullscreen(); } catch (e) {}
    }
    return;
  }

  try {
    if (card.requestFullscreen) card.requestFullscreen().catch(() => {});
    else if (card.webkitRequestFullscreen) card.webkitRequestFullscreen();
  } catch (e) {}

  // Fallback CSS imersivo — é o que funciona no Web App do iOS.
  card.classList.add("fullscreen-mode");
  btnFull.textContent = "🗗";
}

function exitAllCssFullscreen() {
  document.querySelectorAll(".window-card.fullscreen-mode").forEach((card) => {
    card.classList.remove("fullscreen-mode");
    const btn = card.querySelector('[data-role="full"]');
    if (btn) btn.textContent = "⛶";
  });
}
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) exitAllCssFullscreen();
});
document.addEventListener("webkitfullscreenchange", () => {
  if (!document.webkitFullscreenElement) exitAllCssFullscreen();
});

// ---------------------------------------------------------------------------
// Watchdog anti-congelamento
// ---------------------------------------------------------------------------

function watchdogTick() {
  const now = Date.now();
  Object.keys(sessions).forEach((key) => {
    const s = sessions[key];
    if (s.paused || s.state === "waiting" || s.restarting) return;

    if (s.mode === "webrtc") {
      const t = s.videoEl.currentTime;
      if (t > 0 && t !== s.lastVideoTime) {
        // Frames avançando: está genuinamente ao vivo.
        s.lastVideoTime = t;
        s.lastFrameAt = now;
        s.disconnectedAt = 0;
        if (s.state !== "live") setCardState(key, "live");
        return;
      }

      // "disconnected" que não se recuperou dentro da carência.
      if (s.disconnectedAt && now - s.disconnectedAt > DISCONNECT_GRACE_MS) {
        s.restarts += 1;
        restartStream(key, "webrtc disconnected persistente");
        return;
      }

      if (s.lastFrameAt) {
        // Já entregou vídeo antes e travou: este é o congelamento clássico.
        if (now - s.lastFrameAt > STALL_TIMEOUT_MS) {
          s.restarts += 1;
          restartStream(key, `vídeo congelado há ${Math.round((now - s.lastFrameAt) / 1000)}s`);
        }
      } else if (now - s.startingAt > CONNECT_TIMEOUT_MS) {
        // Nunca chegou a entregar frame nenhum.
        s.restarts += 1;
        restartStream(key, "sem vídeo após a negociação");
      }
    } else {
      if (s.lastFrameAt) {
        if (now - s.lastFrameAt > STALL_TIMEOUT_MS) {
          s.restarts += 1;
          restartStream(key, "mjpeg congelado");
        }
      } else if (now - s.startingAt > CONNECT_TIMEOUT_MS) {
        s.restarts += 1;
        restartStream(key, "mjpeg sem frames");
      }
    }
  });
}

/**
 * Chamado ao voltar do segundo plano. Reconcilia janelas, reata cards órfãos e
 * reinicia todo stream ativo — assim o que aparece é o instante atual, não o
 * frame de quando o app foi minimizado.
 */
async function resyncAll(reason) {
  console.log(`[resync] ${reason}`);
  const windows = await fetchWindows();

  for (const key of Object.keys(sessions)) {
    const s = sessions[key];
    let hit = resolveWindow(s.savedMeta || s.winData, windows) ||
              resolveWindow(s.winData, windows);
    // Não roubar a janela de outro card que já está transmitindo nela.
    if (hit && cardForWindow(hit.id_hex, key)) hit = null;

    if (!hit) {
      // A janela sumiu do Acer: o card NÃO é apagado, fica aguardando ela voltar.
      await teardownPeer(s);
      stopMjpegStream(s);
      setCardState(key, "waiting", "Janela não está aberta no Acer — aguardando…", "✕ Remover card");
      continue;
    }

    rebindWindow(key, hit);
    s.savedMeta = null;
    if (!s.paused) await restartStream(key, reason);
    else setCardState(key, "paused", "⏹ Stream pausado", "▶ Retomar");
  }
  saveLayout();
}

/** Cards em "waiting" tentam reatar sozinhos quando a janela reaparece. */
async function retryWaitingCards() {
  const waiting = Object.values(sessions).filter((s) => s.state === "waiting");
  if (waiting.length === 0) return;
  const windows = await fetchWindows();
  for (const s of waiting) {
    const hit = resolveWindow(s.savedMeta || s.winData, windows);
    if (!hit || cardForWindow(hit.id_hex, s.key)) continue;
    rebindWindow(s.key, hit);
    s.savedMeta = null;
    if (!s.paused) await restartStream(s.key, "janela reapareceu no Acer");
    // Card pausado sai de "waiting" — senão ficaria preso nesse estado.
    else setCardState(s.key, "paused", "⏹ Stream pausado", "▶ Retomar");
  }
}

// ---------------------------------------------------------------------------
// Segundo plano / volta ao app (iOS Safari, PWA, troca de aba)
// ---------------------------------------------------------------------------

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenSince = Date.now();
    saveLayout();
    return;
  }
  const away = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = 0;
  checkForNewBuild();
  if (away > BACKGROUND_RESYNC_THRESHOLD_MS) {
    resyncAll(`voltou do segundo plano após ${Math.round(away / 1000)}s`);
  } else {
    Object.values(sessions).forEach((s) => { if (!s.paused) playVideo(s); });
  }
});

// bfcache do Safari: a página volta "congelada no tempo" — força resync.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) resyncAll("restaurado do bfcache do Safari");
});
window.addEventListener("pagehide", () => saveLayout());
window.addEventListener("online", () => resyncAll("rede voltou"));
window.addEventListener("focus", () => {
  Object.values(sessions).forEach((s) => { if (!s.paused) playVideo(s); });
});

// ---------------------------------------------------------------------------
// Auto-update sem Ctrl+F5
// ---------------------------------------------------------------------------

async function checkForNewBuild() {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (data.build && BUILD !== "dev" && data.build !== BUILD) {
      console.log(`[update] build ${BUILD} -> ${data.build}, recarregando…`);
      saveLayout();
      location.reload();
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Métricas, keepalive e seletor de janelas
// ---------------------------------------------------------------------------

async function pollMetrics() {
  try {
    const res = await fetch("/api/system/stats", { cache: "no-store" });
    if (!res.ok) { setOnline(false); return; }
    const data = await res.json();
    setOnline(true);
    if (valCpu) valCpu.textContent = `${data.cpu_usage}%`;
    if (valRam) valRam.textContent = `${data.memory_percent}%`;
    if (valStreams) valStreams.textContent = `${data.active_streams}`;
    if (Array.isArray(data.windows)) knownWindows = data.windows;

    // Janela fechada no Acer não apaga o card: ele passa a aguardar o retorno.
    const alive = new Set((data.active_window_ids || []).map((id) => id.toLowerCase()));
    for (const key of Object.keys(sessions)) {
      const s = sessions[key];
      if (s.state === "waiting") continue;
      if (!alive.has((s.winData.id_hex || "").toLowerCase())) {
        const hit = resolveWindow(s.winData, knownWindows);
        if (hit) { rebindWindow(key, hit); await restartStream(key, "id da janela mudou"); }
        else {
          await teardownPeer(s);
          stopMjpegStream(s);
          setCardState(key, "waiting", "Janela não está aberta no Acer — aguardando…", "✕ Remover card");
        }
      }
    }
  } catch (e) {
    setOnline(false);
  }
}

async function sendKeepalive() {
  const ids = Object.values(sessions).map((s) => s.sessionId).filter(Boolean);
  if (ids.length === 0) return;
  try {
    const res = await fetch("/api/keepalive", {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: ids }),
    });
    if (!res.ok) return;
    const data = await res.json();
    // Sessão que o servidor não conhece mais (reinício do backend) volta na hora.
    const unknown = new Set(data.unknown || []);
    for (const s of Object.values(sessions)) {
      if (s.sessionId && unknown.has(s.sessionId) && !s.paused) {
        restartStream(s.key, "sessão perdida no servidor");
      }
    }
  } catch (e) {}
}

async function openWindowPicker() {
  modalBackdrop.classList.remove("hidden");
  windowListContainer.innerHTML = `
    <div class="loading-state"><div class="spinner"></div><span>Buscando janelas no X11…</span></div>`;
  const windows = await fetchWindows();
  renderWindowList(windows);
}

function renderWindowList(windows) {
  if (!windows.length) {
    windowListContainer.innerHTML =
      '<div style="text-align:center;color:var(--text-secondary);padding:30px 10px;">Nenhuma janela aberta no Acer.</div>';
    return;
  }
  const openHex = new Set(Object.values(sessions).map((s) => (s.winData.id_hex || "").toLowerCase()));
  windowListContainer.innerHTML = "";
  windows.forEach((win) => {
    const isOpen = openHex.has(win.id_hex.toLowerCase());
    const item = document.createElement("div");
    item.className = "win-item";
    item.innerHTML = `
      <div class="win-info">
        <span class="win-title">${escapeHtml(win.title)}</span>
        <span class="win-meta"><b style="color:var(--accent-blue);">${escapeHtml(win.app_name)}</b> • PID ${win.pid} • ${win.width}x${win.height}</span>
      </div>
      <button class="btn btn-sm ${isOpen ? "btn-danger" : "btn-primary"}">${isOpen ? "Já Aberta" : "Monitorar"}</button>`;
    item.addEventListener("click", () => {
      if (isOpen) return;
      addStreamCard(win);
      modalBackdrop.classList.add("hidden");
    });
    windowListContainer.appendChild(item);
  });
}

function updateEmptyState() {
  if (emptyState) {
    emptyState.style.display = Object.keys(sessions).length === 0 ? "flex" : "none";
  }
}

function applyMasterUi() {
  const icon = masterStreaming ? "⏹" : "▶";
  const label = masterStreaming ? "Parar Todos" : "Iniciar Todos";
  if (btnMasterToggle) btnMasterToggle.className = `btn btn-sm ${masterStreaming ? "btn-outline-danger" : "btn-primary"}`;
  if (masterIcon) masterIcon.textContent = icon;
  if (masterText) masterText.textContent = label;
  if (bottomMasterIcon) bottomMasterIcon.textContent = icon;
  if (bottomMasterText) bottomMasterText.textContent = label;
}

async function handleMasterToggle() {
  masterStreaming = !masterStreaming;
  applyMasterUi();
  for (const key of Object.keys(sessions)) {
    if (sessions[key].paused === masterStreaming) await toggleStreamCard(key);
  }
  saveLayout();
}

function applyFpsUi() {
  if (!btnFpsToggle) return;
  btnFpsToggle.textContent = `${globalFps} FPS`;
  btnFpsToggle.className = `btn btn-sm ${globalFps === 30 ? "btn-primary" : "btn-outline-warning"}`;
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

["btnAddWindow", "btnBottomAdd", "btnEmptyAdd", "btnRefreshWindows", "btnBottomRefresh"]
  .forEach((id) => { const el = $(id); if (el) el.addEventListener("click", openWindowPicker); });

if ($("btnCloseModal")) $("btnCloseModal").addEventListener("click", () => modalBackdrop.classList.add("hidden"));
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) modalBackdrop.classList.add("hidden"); });

if (btnFpsToggle) {
  btnFpsToggle.addEventListener("click", async () => {
    globalFps = globalFps === 30 ? 15 : 30;
    applyFpsUi();
    saveLayout();
    for (const key of Object.keys(sessions)) {
      if (!sessions[key].paused) await restartStream(key, "mudança de FPS");
    }
  });
}
if (btnMasterToggle) btnMasterToggle.addEventListener("click", handleMasterToggle);
if ($("btnBottomMaster")) $("btnBottomMaster").addEventListener("click", handleMasterToggle);

async function boot() {
  const layout = loadLayout();
  globalFps = layout.fps;
  masterStreaming = layout.master;
  applyFpsUi();
  applyMasterUi();

  const windows = await fetchWindows();

  restoring = true;
  const seenKeys = new Set();
  const claimed = new Set(); // janelas já tomadas por um card restaurado

  for (const saved of layout.cards) {
    if (!saved || !saved.key || seenKeys.has(saved.key)) continue;
    seenKeys.add(saved.key);

    const hit = resolveWindow(saved, windows);
    const hitHex = hit ? hit.id_hex.toLowerCase() : null;

    if (hit && !claimed.has(hitHex)) {
      claimed.add(hitHex);
      await addStreamCard(hit, saved.key, saved);
      continue;
    }

    // Ou a janela sumiu do Acer, ou outro card já a reivindicou.
    // De qualquer forma o card NÃO é descartado: fica guardando o lugar dele.
    await addStreamCard({
      id_hex: saved.id_hex, id_dec: saved.id_dec, title: saved.title,
      app_class: saved.app_class, app_name: saved.app_name, pid: saved.pid,
      x: saved.x, y: saved.y, width: saved.width, height: saved.height,
    }, saved.key, { ...saved, paused: true }, true);

    const s = sessions[saved.key];
    if (s) {
      s.paused = !!saved.paused;
      s.savedMeta = saved;
      setCardState(saved.key, "waiting", "Janela não está aberta no Acer — aguardando…", "✕ Remover card");
    }
  }
  restoring = false;
  saveLayout();
  updateEmptyState();

  pollMetrics();
  setInterval(pollMetrics, METRICS_INTERVAL_MS);
  setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  setInterval(sendKeepalive, KEEPALIVE_INTERVAL_MS);
  setInterval(checkForNewBuild, VERSION_CHECK_INTERVAL_MS);
  setInterval(retryWaitingCards, REATTACH_RETRY_MS);
}

boot();
