// Stream Monitor Frontend Logic — View-Only WebRTC Grid

let activeSessions = {}; // window_id -> { pc, sessionId, videoEl, cardEl, paused, winData }
let masterStreaming = true;

const gridContainer = document.getElementById("gridContainer");
const modalBackdrop = document.getElementById("modalBackdrop");
const windowListContainer = document.getElementById("windowListContainer");
const btnAddWindow = document.getElementById("btnAddWindow");
const btnCloseModal = document.getElementById("btnCloseModal");
const btnMasterToggle = document.getElementById("btnMasterToggle");
const masterIcon = document.getElementById("masterIcon");
const masterText = document.getElementById("masterText");

// Eventos do Modal
btnAddWindow.addEventListener("click", openWindowPicker);
btnCloseModal.addEventListener("click", () => modalBackdrop.classList.add("hidden"));
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) modalBackdrop.classList.add("hidden");
});

// Master Start/Stop Toggle
btnMasterToggle.addEventListener("click", () => {
  masterStreaming = !masterStreaming;
  if (masterStreaming) {
    btnMasterToggle.className = "btn btn-primary";
    masterIcon.textContent = "⏹";
    masterText.textContent = "Parar Todos";
    // Retoma todos os pausados
    Object.keys(activeSessions).forEach(winId => {
      if (activeSessions[winId].paused) toggleStreamCard(winId);
    });
  } else {
    btnMasterToggle.className = "btn btn-danger";
    masterIcon.textContent = "▶";
    masterText.textContent = "Iniciar Todos";
    // Pausa todos os ativos
    Object.keys(activeSessions).forEach(winId => {
      if (!activeSessions[winId].paused) toggleStreamCard(winId);
    });
  }
});

async function openWindowPicker() {
  modalBackdrop.classList.remove("hidden");
  windowListContainer.innerHTML = '<div style="text-align: center; color: #8b949e; padding: 20px;">Buscando janelas ativas...</div>';

  try {
    const res = await fetch("/api/windows");
    const data = await res.json();
    renderWindowList(data.windows || []);
  } catch (err) {
    windowListContainer.innerHTML = `<div style="color: #f85149; padding: 20px;">Erro ao listar janelas: ${err.message}</div>`;
  }
}

function renderWindowList(windows) {
  if (windows.length === 0) {
    windowListContainer.innerHTML = '<div style="text-align: center; color: #8b949e; padding: 20px;">Nenhuma janela encontrada.</div>';
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
        <span class="win-meta">${escapeHtml(win.app_name)} • PID: ${win.pid} • ${win.width}x${win.height}</span>
      </div>
      <button class="btn ${isAlreadyOpen ? 'btn-danger' : 'btn-primary'}" style="padding: 4px 10px; font-size: 0.75rem;">
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
      <span class="card-title" title="${escapeHtml(win.title)}">${escapeHtml(win.app_name)}: ${escapeHtml(win.title)}</span>
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
        <button class="btn btn-primary" style="font-size: 0.75rem; padding: 4px 8px;" id="btnResume_${win.id_hex}">▶ Retomar</button>
      </div>
    </div>
  `;

  gridContainer.appendChild(card);

  const videoEl = card.querySelector(`#video_${win.id_hex}`);
  const btnToggle = card.querySelector(`#btnToggle_${win.id_hex}`);
  const btnFull = card.querySelector(`#btnFull_${win.id_hex}`);
  const btnClose = card.querySelector(`#btnClose_${win.id_hex}`);
  const btnResume = card.querySelector(`#btnResume_${win.id_hex}`);

  btnFull.addEventListener("click", () => {
    if (videoEl.requestFullscreen) videoEl.requestFullscreen();
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
  const pc = new RTCPeerConnection();
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
    console.error("Erro ao iniciar WebRTC:", err);
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
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}
