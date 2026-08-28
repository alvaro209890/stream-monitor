// Stream Monitor Frontend Logic — Mobile-First WebRTC Grid

let activeSessions = {}; // window_id -> { pc, sessionId, videoEl, cardEl, paused, winData }
let masterStreaming = true;

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

    // Retoma todos os pausados
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

    // Pausa todos os ativos
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

// Polling de Métricas do Host a cada 5 segundos
async function pollMetrics() {
  try {
    const res = await fetch("/api/system/stats");
    if (res.ok) {
      const data = await res.json();
      if (valCpu) valCpu.textContent = `${data.cpu_usage}%`;
      if (valRam) valRam.textContent = `${data.memory_percent}%`;
      if (valStreams) valStreams.textContent = `${data.active_streams}`;
    }
  } catch (e) {}
}
setInterval(pollMetrics, 5000);
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
        <button class="icon-btn" title="Pausar/Iniciar" id="btnToggle_${win.id_hex}">⏸</button>
        <button class="icon-btn" title="Tela Cheia" id="btnFull_${win.id_hex}">⛶</button>
        <button class="icon-btn" title="Fechar" id="btnClose_${win.id_hex}">✕</button>
      </div>
    </div>
    <div class="video-wrapper">
      <video id="video_${win.id_hex}" autoplay playsinline muted></video>
      <div class="paused-overlay hidden" id="overlay_${win.id_hex}">
        <span>⏹ Stream Pausado</span>
        <button class="btn btn-primary btn-sm" id="btnResume_${win.id_hex}">▶ Retomar</button>
      </div>
    </div>
  `;

  gridContainer.appendChild(card);
  updateEmptyState();

  const videoEl = card.querySelector(`#video_${win.id_hex}`);
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

  activeSessions[win.id_hex] = {
    winData: win,
    cardEl: card,
    videoEl: videoEl,
    paused: false,
    pc: null,
    sessionId: null
  };

  await startWebRtcStream(win.id_hex);
}

async function startWebRtcStream(winIdHex) {
  const session = activeSessions[winIdHex];
  if (!session) return;

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
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
        fps: 30
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
    if (session.sessionId) {
      await fetch(`/api/stop/${session.sessionId}`, { method: "POST" });
    }
    if (session.pc) {
      session.pc.close();
      session.pc = null;
    }
  } else {
    overlay.classList.add("hidden");
    btnToggle.textContent = "⏸";
    await startWebRtcStream(winIdHex);
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
