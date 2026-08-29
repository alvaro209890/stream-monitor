import os
import time
import uuid
import asyncio
import hashlib
import subprocess
import contextlib
from typing import Dict, Any, Optional, List

import psutil
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

from backend.window_manager import (
    get_active_windows,
    move_window_to_workspace,
    activate_window,
    send_text_to_window,
    send_key_to_window,
    send_click_to_window,
)
from backend.streamer import X11WindowStreamTrack

# ---------------------------------------------------------------------------
# Build ID — muda sozinho sempre que qualquer asset do frontend muda.
# É ele que faz o navegador/PWA pegar a versão nova SEM Ctrl+F5.
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
_ASSET_FILES = ("index.html", "app.js", "styles.css", "manifest.json")
_build_cache: Dict[str, Any] = {"id": "", "checked_at": 0.0}


def compute_build_id() -> str:
    """Hash curto de (mtime, tamanho) dos assets. Recalculado no máximo 1x/s."""
    now = time.time()
    if _build_cache["id"] and (now - _build_cache["checked_at"]) < 1.0:
        return _build_cache["id"]

    h = hashlib.sha1()
    for name in _ASSET_FILES:
        path = os.path.join(FRONTEND_DIR, name)
        try:
            st = os.stat(path)
            h.update(f"{name}:{int(st.st_mtime)}:{st.st_size};".encode())
        except OSError:
            h.update(f"{name}:missing;".encode())

    _build_cache["id"] = h.hexdigest()[:12]
    _build_cache["checked_at"] = now
    return _build_cache["id"]


# ---------------------------------------------------------------------------
# Estado das sessões WebRTC
# ---------------------------------------------------------------------------

class Session:
    __slots__ = ("id", "pc", "track", "window_hex", "client_id", "card_key",
                 "created_at", "last_seen")

    def __init__(self, sid: str, pc: RTCPeerConnection, track: X11WindowStreamTrack,
                 window_hex: str, client_id: str, card_key: str):
        self.id = sid
        self.pc = pc
        self.track = track
        self.window_hex = (window_hex or "").lower()
        self.client_id = client_id or ""
        self.card_key = card_key or ""
        self.created_at = time.time()
        self.last_seen = time.time()


sessions: Dict[str, Session] = {}
_sessions_lock = asyncio.Lock()

# Sessão sem keepalive por mais que isso é considerada abandonada (cliente sumiu,
# iOS matou a aba, rede caiu) e o ffmpeg dela é encerrado.
SESSION_TTL_SECONDS = 75
REAPER_INTERVAL_SECONDS = 15


async def close_session(sid: str, reason: str = "manual") -> bool:
    sess = sessions.pop(sid, None)
    if sess is None:
        return False
    with contextlib.suppress(Exception):
        sess.track.stop()
    with contextlib.suppress(Exception):
        await sess.pc.close()
    print(f"[cleanup] sessão {sid} encerrada ({reason})", flush=True)
    return True


async def close_superseded_sessions(client_id: str, card_key: str, window_hex: str) -> int:
    """
    Fecha a sessão ANTERIOR do MESMO card do MESMO cliente.

    Deduplicar por janela seria errado: dois celulares assistindo a mesma janela
    derrubariam um ao outro. A identidade é (cliente, card) — assim a reconexão
    do iPhone substitui a própria sessão e não deixa ffmpeg órfão, enquanto
    outros dispositivos seguem intactos.
    """
    if not client_id or not card_key:
        return 0
    doomed = [s.id for s in sessions.values()
              if s.client_id == client_id and s.card_key == card_key]
    for sid in doomed:
        await close_session(sid, "substituída pela reconexão do mesmo card")
    return len(doomed)


async def _reaper_loop():
    while True:
        try:
            await asyncio.sleep(REAPER_INTERVAL_SECONDS)
            now = time.time()
            for sess in list(sessions.values()):
                state = getattr(sess.pc, "connectionState", "")
                if state in ("failed", "closed"):
                    await close_session(sess.id, f"connectionState={state}")
                elif (now - sess.last_seen) > SESSION_TTL_SECONDS:
                    await close_session(sess.id, "sem keepalive do cliente")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # nunca deixar o reaper morrer
            print(f"[reaper] erro ignorado: {exc}", flush=True)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_reaper_loop())
    compute_build_id()
    print(f"[boot] Stream Monitor build={_build_cache['id']}", flush=True)
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    for sid in list(sessions):
        await close_session(sid, "shutdown")


app = FastAPI(title="Stream Monitor API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def cache_policy(request: Request, call_next):
    """
    index.html e API: nunca cacheados (sempre a verdade do momento).
    Assets com ?v=<build>: cacheáveis para sempre — a URL muda quando o arquivo muda.
    Resultado: nunca é preciso Ctrl+F5, e o app abre rápido no 4G.
    """
    response = await call_next(request)
    path = request.url.path

    if path.startswith("/api/") or path == "/":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    elif path.startswith("/static/"):
        if request.query_params.get("v") == compute_build_id():
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            # manifest, ícones e qualquer asset sem carimbo de versão
            response.headers["Cache-Control"] = "public, max-age=300, must-revalidate"
    return response


class OfferPayload(BaseModel):
    sdp: str
    type: str
    window_id: int
    window_id_hex: Optional[str] = None
    x: int = 0
    y: int = 0
    width: int = 1280
    height: int = 720
    fps: int = 30
    client_id: Optional[str] = None
    card_key: Optional[str] = None


class KeepalivePayload(BaseModel):
    session_ids: List[str] = []


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/version")
def get_version():
    """O frontend compara isso com o build que carregou e se recarrega sozinho."""
    return {"build": compute_build_id(), "server_time": time.time()}


@app.get("/api/system/stats")
def get_system_stats():
    """Métricas de hardware do Acer + janelas vivas (para reatar cards)."""
    mem = psutil.virtual_memory()
    active_windows = get_active_windows()
    return {
        "build": compute_build_id(),
        "cpu_usage": psutil.cpu_percent(interval=None),
        "memory_used_mb": round(mem.used / (1024 * 1024), 1),
        "memory_total_mb": round(mem.total / (1024 * 1024), 1),
        "memory_percent": mem.percent,
        "active_streams": len(sessions),
        "active_window_ids": [w["id_hex"].lower() for w in active_windows],
        "windows": active_windows,
    }


@app.get("/api/windows")
def list_windows():
    return {"windows": get_active_windows(), "build": compute_build_id()}


@app.post("/api/keepalive")
async def keepalive(payload: KeepalivePayload):
    """Cliente avisa que ainda está assistindo. Sem isso, o reaper mata a sessão."""
    now = time.time()
    alive, unknown = [], []
    for sid in payload.session_ids:
        sess = sessions.get(sid)
        if sess:
            sess.last_seen = now
            alive.append(sid)
        else:
            unknown.append(sid)
    return {"alive": alive, "unknown": unknown, "build": compute_build_id()}


@app.get("/api/windows/{win_id_dec}/snapshot")
def get_window_snapshot(win_id_dec: int):
    """Frame JPEG instantâneo — usado como pôster enquanto o WebRTC negocia."""
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab",
        "-window_id", str(win_id_dec), "-i", ":0.0",
        "-vframes", "1", "-q:v", "3", "-f", "image2", "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              check=True, timeout=10)
        return Response(content=proc.stdout, media_type="image/jpeg",
                        headers={"Cache-Control": "no-store"})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Erro ao capturar snapshot: {exc}")


@app.get("/api/windows/{win_id_dec}/mjpeg")
async def get_window_mjpeg(win_id_dec: int, fps: int = 15):
    """Fallback MJPEG universal (funciona onde o WebRTC não vai)."""
    fps = max(1, min(fps, 30))

    async def mjpeg_generator():
        cmd = [
            "ffmpeg", "-f", "x11grab", "-framerate", str(fps),
            "-window_id", str(win_id_dec), "-i", ":0.0",
            "-q:v", "5", "-f", "mpjpeg", "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        loop = asyncio.get_running_loop()
        boundary = b"--ffmpeg\r\n"
        buffer = b""
        try:
            while True:
                if proc.stdout is None:
                    break
                # LEITURA EM THREAD: proc.stdout.read é bloqueante e travaria
                # o event loop inteiro (todos os outros streams e a API).
                chunk = await loop.run_in_executor(None, proc.stdout.read, 32768)
                if not chunk:
                    break
                buffer += chunk
                while boundary in buffer:
                    part, buffer = buffer.split(boundary, 1)
                    if part:
                        yield boundary + part
        finally:
            with contextlib.suppress(Exception):
                proc.terminate()
                proc.wait(timeout=2)
            with contextlib.suppress(Exception):
                proc.kill()

    return StreamingResponse(
        mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=ffmpeg",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


class ControlSendPayload(BaseModel):
    text: str
    enter: bool = True

class ControlKeyPayload(BaseModel):
    key: str

class ControlClickPayload(BaseModel):
    x: float
    y: float
    button: int = 1

@app.post("/api/windows/{win_id_hex}/activate")
def api_activate_window(win_id_hex: str):
    if not activate_window(win_id_hex):
        raise HTTPException(status_code=500, detail="Falha ao focar janela.")
    return {"status": "ok", "action": "activate"}

@app.post("/api/windows/{win_id_hex}/send")
def api_send_text(win_id_hex: str, payload: ControlSendPayload):
    if not send_text_to_window(win_id_hex, payload.text, payload.enter):
        raise HTTPException(status_code=500, detail="Falha ao enviar texto para janela.")
    return {"status": "ok", "action": "send", "text_len": len(payload.text)}

@app.post("/api/windows/{win_id_hex}/key")
def api_send_key(win_id_hex: str, payload: ControlKeyPayload):
    if not send_key_to_window(win_id_hex, payload.key):
        raise HTTPException(status_code=500, detail=f"Falha ao enviar tecla '{payload.key}' para janela.")
    return {"status": "ok", "action": "key", "key": payload.key}

@app.post("/api/windows/{win_id_hex}/click")
def api_send_click(win_id_hex: str, payload: ControlClickPayload):
    if not send_click_to_window(win_id_hex, payload.x, payload.y, payload.button):
        raise HTTPException(status_code=500, detail="Falha ao enviar clique.")
    return {"status": "ok", "action": "click", "x": payload.x, "y": payload.y}

@app.post("/api/windows/{win_id_hex}/workspace")
def move_workspace(win_id_hex: str, workspace: int = 1):
    if not move_window_to_workspace(win_id_hex, workspace):
        raise HTTPException(status_code=500, detail="Falha ao mover janela.")
    return {"status": "ok", "workspace": workspace}


@app.post("/api/offer")
async def rtc_offer(params: OfferPayload):
    """Sinalização WebRTC (offer -> answer) + criação do track de captura X11."""
    async with _sessions_lock:
        # Reconexão do mesmo celular não pode deixar o ffmpeg antigo rodando.
        await close_superseded_sessions(params.client_id or "", params.card_key or "",
                                        params.window_id_hex or "")

        sid = f"pc_{uuid.uuid4().hex[:12]}"
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=[
            RTCIceServer(urls=["stun:stun.l.google.com:19302",
                               "stun:stun1.l.google.com:19302"])
        ]))

        try:
            track = X11WindowStreamTrack(
                window_id=params.window_id,
                x=params.x, y=params.y,
                width=params.width, height=params.height,
                fps=max(1, min(params.fps, 60)),
            )
        except Exception as exc:
            await pc.close()
            raise HTTPException(status_code=503, detail=f"Não foi possível capturar a janela: {exc}")

        sessions[sid] = Session(sid, pc, track, params.window_id_hex or "",
                                params.client_id or "", params.card_key or "")
        pc.addTrack(track)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in ("failed", "closed"):
                await close_session(sid, f"connectionState={pc.connectionState}")

        await pc.setRemoteDescription(RTCSessionDescription(sdp=params.sdp, type=params.type))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        for _ in range(20):
            if pc.iceGatheringState == "complete":
                break
            await asyncio.sleep(0.05)

        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
            "session_id": sid,
            "build": compute_build_id(),
        }


@app.post("/api/stop/{session_id}")
async def stop_stream(session_id: str):
    await close_session(session_id, "pedido do cliente")
    return {"status": "stopped", "session_id": session_id}


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
@app.head("/")
def serve_index():
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.exists(index_file):
        return HTMLResponse("<h1>Stream Monitor API ativa (frontend ausente).</h1>")

    build = compute_build_id()
    with open(index_file, "r", encoding="utf-8") as fh:
        html = fh.read().replace("__BUILD__", build)

    return HTMLResponse(html, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Build-Id": build,
    })


@app.get("/healthz")
def healthz():
    return {"ok": True, "build": compute_build_id(), "sessions": len(sessions)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app:app", host="127.0.0.1", port=3090, reload=True)
