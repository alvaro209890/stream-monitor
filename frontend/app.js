// Stream Monitor Frontend Logic — Mobile-First WebRTC Grid & Advanced Controls

let activeSessions = {}; // window_id -> { pc, sessionId, videoEl, cardEl, paused, winData, mode: 'webrtc'|'mjpeg', inGhostWorkspace: false, fps: 30 }
let masterStreaming = true;
let globalFps = 30;

const gridContainer = document.getElementById("gridContainer");
const emptyState = document.getElementById("emptyState");
const modalBackdrop = document.getElementById("modalBackdrop");
const windowListContainer = document.getElementById("windowListContainer");

// Botões Header
const btnAddWindow = document.getElementById("btnAddWindow");
const btnCloseModal = document.getElementById("btnCloseModal");
const btnMasterToggle = document.getElementById("btnMasterToggle");
const btnRefreshWindows = document.getElementById("btnRefreshWindows");
const btnEmptyAdd = document.getElementById("btnEmptyAdd");
const btnFpsToggle = document.getElementById("btnFpsToggle");
const masterIcon = document.getElementById("masterIcon");
const masterText = document.getElementById("masterText");

// Botões Mobile Bottom Bar
const btnBottomRefresh = document.getElementById("btnBottomRefresh");
const btnBottomAdd = document.getElementById("btnBottomAdd");
const btnBottomMaster = document.getElementById("btnBottomMaster");
const bottomMasterIcon = document.getElementById("bottomMasterIcon");
const bottomMasterText = document.getElementById("bottomMasterText");

// Métricas de Hardware
const valCpu = document.getElementById("valCpu");
const valRam = document.getElementById("valRam");
const valStreams = document.getElementById("valStreams");

// Eventos de Abertura do Modal
if (btnAddWindow) btnAddWindow.addEventListener("click", openWindowPicker);
if (btnBottomAdd) btnBottomAdd.addEventListener("click", openWindowPicker);
if (btnEmptyAdd) btnEmptyAdd.addEventListener("click", openWindowPicker);
if (btnRefreshWindows) btnRefreshWindows.addEventListener("click", openWindowPicker);
if (btnBottomRefresh) btnBottomRefresh.addEventListener("click", openWindowPicker);

if (btnCloseModal) btnCloseModal.addEventListener("click", () => modalBackdrop.classList.add("hidden"));
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) modalBackdrop.classList.add("hidden");
});

// Toggle Global de FPS (30 FPS Fluido vs 15 FPS Economia de Dados)
if (btnFpsToggle) {
  btnFpsToggle.addEventListener("click", () => {
    globalFps = globalFps === 30 ? 15 : 30;
    btnFpsToggle.textContent = `${globalFps} FPS`;
    btnFpsToggle.className = `btn btn-sm ${globalFps === 30 ? 'btn-primary' : 'btn-outline-warning'}`;
  });
}

// Master Start/Stop Toggle
function handleMasterToggle() {
  masterStreaming = !masterStreaming;
  if (masterStreaming) {
    if (btnMasterToggle) {
      btnMasterToggle.className = "btn btn-sm btn-outline-danger";
      masterIcon.textContent = "⏹";
      masterText.textContent = "Parar Todos";
    }
    if (bottomMasterIcon) bottomMasterIcon.textContent = "⏹";
    if (bottomMasterText) bottomMasterText.textContent = "Parar Todos";

    Object.keys(activeSessions).forEach(winId => {
      if (activeSessions[winId].paused) toggleStreamCard(winId);
    });
  } else {
    if (btnMasterToggle) {
      btnMasterToggle.className = "btn btn-sm btn-primary";
      masterIcon.textContent = "▶";
      masterText.textContent = "Iniciar Todos";
    }
    if (bottomMasterIcon) bottomMasterIcon.textContent = "▶";
    if (bottomMasterText) bottomMasterText.textContent = "Iniciar Todos";

    Object.keys(activeSessions).forEach(winId => {
      if (!activeSessions[winId].paused) toggleStreamCard(winId);
    });
  }
}

if (btnMasterToggle) btnMasterToggle.addEventListener("click", handleMasterToggle);
if (btnBottomMaster) btnBottomMaster.addEventListener("click", handleMasterToggle);

function updateEmptyState() {
  if (emptyState) {
    emptyState.style.display = Object.keys(activeSessions).length === 0 ? "flex" : "none";
  }
}

// Polling de Métricas do Host e Auto-Cleanup de Janelas Fechadas
async function pollMetrics() {
  try {
    const res = await fetch("/api/system/stats");
    if (res.ok) {
      const data = await res.json();
      if (valCpu) valCpu.textContent = `${data.cpu_usage}%`;
      if (valRam) valRam.textContent = `${data.memory_percent}%`;
      if (valStreams) valStreams.textContent = `${data.active_streams}`;

      // Auto-Cleanup: Fecha cards de janelas que foram fechadas no PC físico
      if (data.active_window_ids && Array.isArray(data.active_window_ids)) {
        const aliveSet = new Set(data.active_window_ids.map(id => id.toLowerCase()));
        Object.keys(activeSessions).forEach(winIdHex => {
          if (!aliveSet.has(winIdHex.toLowerCase())) {
            console.log(`[Auto-Cleanup] Janela ${winIdHex} foi fechada no Acer. Removendo card...`);
            closeStreamCard(winIdHex);
          }
        });
      }
    }
  } catch (e) {}
}
setInterval(pollMetrics, 4000);
pollMetrics();

async function openWindowPicker() {
  modalBackdrop.classList.remove("hidden");
  windowListContainer.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Buscando janelas no X11...</span>
    </div>
  `;

  try {
    const res = await fetch("/api/windows");
    const data = await res.json();
    renderWindowList(data.windows || []);
  } catch (err) {
    windowListContainer.innerHTML = `<div style="color: var(--accent-red); padding: 20px; text-align: center;">Erro ao listar janelas: ${err.message}</div>`;
  }
}

function renderWindowList(windows) {
  if (windows.length === 0) {
    windowListContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 30px 10px;">Nenhuma janela encontrada aberta no Acer.</div>';
    return;
  }

  windowListContainer.innerHTML = "";
  windows.forEach(win => {
    const isAlreadyOpen = !!activeSessions[win.id_hex];
    const item = document.createElement("div");
    item.className = "win-item";
    item.innerHTML = `
      <div class="win-info">
        <span class="win-title">${escapeHtml(win.title)}</span>
        <span class="win-meta"><b style="color: var(--accent-blue);">${escapeHtml(win.app_name)}</b> • PID ${win.pid} • ${win.width}x${win.height}</span>
      </div>
      <button class="btn btn-sm ${isAlreadyOpen ? 'btn-danger' : 'btn-primary'}">
        ${isAlreadyOpen ? 'Já Aberta' : 'Monitorar'}
      </button>
    `;

    item.addEventListener("click", () => {
      if (!isAlreadyOpen) {
        addStreamCard(win);
        modalBackdrop.classList.add("hidden");
      }
    });

    windowListContainer.appendChild(item);
  });
}

async function addStreamCard(win) {
  const cardId = `card_${win.id_hex}`;
  if (document.getElementById(cardId)) return;

  const card = document.createElement("div");
  card.className = "window-card";
  card.id = cardId;

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title-group">
        <span class="card-app-badge">${escapeHtml(win.app_name)}</span>
        <span class="card-title" title="${escapeHtml(win.title)}">${escapeHtml(win.title)}</span>
      </div>
      <div class="card-actions">
        <button class="icon-btn" title="Ocultar/Exibir no monitor do Acer" id="btnGhost_${win.id_hex}">👁️</button>
        <button class="icon-btn" title="Alternar WebRTC / MJPEG" id="btnMode_${win.id_hex}">⚡</button>
        <button class="icon-btn" title="Pausar/Iniciar" id="btnToggle_${win.id_hex}">⏸</button>
        <button class="icon-btn" title="Tela Cheia" id="btnFull_${win.id_hex}">⛶</button>
        <button class="icon-btn" title="Fechar" id="btnClose_${win.id_hex}">✕</button>
      </div>
    </div>
    <div class="video-wrapper">
      <video id="video_${win.id_hex}" autoplay playsinline muted></video>
      <img id="mjpeg_${win.id_hex}" class="hidden" style="width: 100%; height: 100%; object-fit: contain; pointer-events: none;" />
      <div class="paused-overlay hidden" id="overlay_${win.id_hex}">
        <span>⏹ Stream Pausado</span>
        <button class="btn btn-primary btn-sm" id="btnResume_${win.id_hex}">▶ Retomar</button>
      </div>
    </div>
  `;

  gridContainer.appendChild(card);
  updateEmptyState();

  const videoEl = card.querySelector(`#video_${win.id_hex}`);
  const mjpegEl = card.querySelector(`#mjpeg_${win.id_hex}`);
  const btnGhost = card.querySelector(`#btnGhost_${win.id_hex}`);
  const btnMode = card.querySelector(`#btnMode_${win.id_hex}`);
  const btnToggle = card.querySelector(`#btnToggle_${win.id_hex}`);
  const btnFull = card.querySelector(`#btnFull_${win.id_hex}`);
  const btnClose = card.querySelector(`#btnClose_${win.id_hex}`);
  const btnResume = card.querySelector(`#btnResume_${win.id_hex}`);

  btnFull.addEventListener("click", () => {
    if (videoEl.requestFullscreen) {
      videoEl.requestFullscreen();
    } else if (videoEl.webkitRequestFullscreen) {
      videoEl.webkitRequestFullscreen();
    } else if (card.requestFullscreen) {
      card.requestFullscreen();
    }
  });

  btnClose.addEventListener("click", () => closeStreamCard(win.id_hex));
  btnToggle.addEventListener("click", () => toggleStreamCard(win.id_hex));
  btnResume.addEventListener("click", () => toggleStreamCard(win.id_hex));
  btnGhost.addEventListener("click", () => toggleGhostWorkspace(win.id_hex));
  btnMode.addEventListener("click", () => toggleStreamProtocol(win.id_hex));

  activeSessions[win.id_hex] = {
    winData: win,
    cardEl: card,
    videoEl: videoEl,
    mjpegEl: mjpegEl,
    paused: false,
    pc: null,
    sessionId: null,
    mode: "webrtc",
    inGhostWorkspace: false
  };

  await startWebRtcStream(win.id_hex);
}

// Botão Ocultar / Mostrar no monitor físico (Workspace Fantasma)
async function toggleGhostWorkspace(winIdHex) {
  const session = activeSessions[winIdHex];
  if (!session) return;

  const btnGhost = document.getElementById(`btnGhost_${winIdHex}`);
  session.inGhostWorkspace = !session.inGhostWorkspace;

  // Workspace 2 (index 1) = Fantasma | Workspace 1 (index 0) = Principal
  const targetWorkspace = session.inGhostWorkspace ? 1 : 0;

  try {
    const res = await fetch(`/api/windows/${winIdHex}/workspace?workspace=${targetWorkspace}`, { method: "POST" });
    if (res.ok) {
      btnGhost.textContent = session.inGhostWorkspace ? "🕶️" : "👁️";
      btnGhost.title = session.inGhostWorkspace ? "Janela oculta no Acer (Renderizando no Workspace 2)" : "Janela visível no Acer";
    }
  } catch (err) {
    console.error("Erro ao mover janela de workspace:", err);
  }
}

// Botão Alternar Modo WebRTC vs MJPEG Fallback
async function toggleStreamProtocol(winIdHex) {
  const session = activeSessions[winIdHex];
  if (!session) return;

  const btnMode = document.getElementById(`btnMode_${winIdHex}`);
  session.mode = session.mode === "webrtc" ? "mjpeg" : "webrtc";

  if (session.mode === "mjpeg") {
    btnMode.textContent = "🖼️";
    btnMode.title = "Modo MJPEG Ativo (Toque para voltar a WebRTC)";
    if (session.pc) {
      session.pc.close();
      session.pc = null;
    }
    session.videoEl.classList.add("hidden");
    session.mjpegEl.classList.remove("hidden");
    session.mjpegEl.src = `/api/windows/${session.winData.id_dec}/mjpeg?fps=${globalFps}&t=${Date.now()}`;
  } else {
    btnMode.textContent = "⚡";
    btnMode.title = "Modo WebRTC Ativo (Baixa Latência)";
    session.mjpegEl.src = "";
    session.mjpegEl.classList.add("hidden");
    session.videoEl.classList.remove("hidden");
    await startWebRtcStream(winIdHex);
  }
}

async function startWebRtcStream(winIdHex) {
  const session = activeSessions[winIdHex];
  if (!session || session.mode !== "webrtc") return;

  const win = session.winData;
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  });
  session.pc = pc;

  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (event) => {
    if (event.track.kind === "video") {
      session.videoEl.srcObject = event.streams[0];
      session.videoEl.play().catch(e => console.log("Autoplay:", e));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  try {
    const res = await fetch("/api/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type,
        window_id: win.id_dec,
        window_id_hex: win.id_hex,
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
        fps: globalFps
      })
    });

    const answer = await res.json();
    session.sessionId = answer.session_id;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error("Erro ao negociar WebRTC:", err);
  }
}

async function toggleStreamCard(winIdHex) {
  const session = activeSessions[winIdHex];
  if (!session) return;

  const overlay = document.getElementById(`overlay_${winIdHex}`);
  const btnToggle = document.getElementById(`btnToggle_${winIdHex}`);

  session.paused = !session.paused;
  if (session.paused) {
    overlay.classList.remove("hidden");
    btnToggle.textContent = "▶";
    if (session.mode === "mjpeg") {
      session.mjpegEl.src = "";
    } else {
      if (session.sessionId) {
        await fetch(`/api/stop/${session.sessionId}`, { method: "POST" });
      }
      if (session.pc) {
        session.pc.close();
        session.pc = null;
      }
    }
  } else {
    overlay.classList.add("hidden");
    btnToggle.textContent = "⏸";
    if (session.mode === "mjpeg") {
      session.mjpegEl.src = `/api/windows/${session.winData.id_dec}/mjpeg?fps=${globalFps}&t=${Date.now()}`;
    } else {
      await startWebRtcStream(winIdHex);
    }
  }
}

async function closeStreamCard(winIdHex) {
  const session = activeSessions[winIdHex];
  if (!session) return;

  if (session.sessionId) {
    try {
      await fetch(`/api/stop/${session.sessionId}`, { method: "POST" });
    } catch (e) {}
  }

  if (session.pc) {
    session.pc.close();
  }

  if (session.mjpegEl) {
    session.mjpegEl.src = "";
  }

  session.cardEl.remove();
  delete activeSessions[winIdHex];
  updateEmptyState();
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}
