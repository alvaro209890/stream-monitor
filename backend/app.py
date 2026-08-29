import os
import json
import asyncio
import subprocess
import tempfile
import psutil
from typing import Dict, Any, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

from backend.window_manager import get_active_windows, move_window_to_workspace, is_window_alive
from backend.streamer import X11WindowStreamTrack

app = FastAPI(title="Stream Monitor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware Anti-Cache Global
@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Gerenciamento de Conexões WebRTC e Tracks ativas
pcs: Dict[str, RTCPeerConnection] = {}
tracks: Dict[str, X11WindowStreamTrack] = {}
stream_windows: Dict[str, str] = {} # session_id -> win_id_hex

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

@app.get("/api/system/stats")
def get_system_stats():
    """Retorna métricas em tempo real de hardware do Acer e status das janelas."""
    cpu_percent = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    active_windows = get_active_windows()
    active_hex_set = {w["id_hex"].lower() for w in active_windows}

    return {
        "cpu_usage": cpu_percent,
        "memory_used_mb": round(mem.used / (1024 * 1024), 1),
        "memory_total_mb": round(mem.total / (1024 * 1024), 1),
        "memory_percent": mem.percent,
        "active_streams": len(tracks),
        "active_window_ids": list(active_hex_set)
    }

@app.get("/api/windows")
def list_windows():
    """Retorna lista de janelas ativas no X11."""
    return {"windows": get_active_windows()}

@app.get("/api/windows/{win_id_dec}/snapshot")
def get_window_snapshot(win_id_dec: int):
    """Captura e retorna um frame snapshot JPEG de alta qualidade da janela."""
    cmd = [
        "ffmpeg", "-y",
        "-f", "x11grab",
        "-window_id", str(win_id_dec),
        "-i", ":0.0",
        "-vframes", "1",
        "-q:v", "3",
        "-f", "image2",
        "pipe:1"
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True)
        return Response(content=proc.stdout, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao capturar snapshot: {e}")

@app.get("/api/windows/{win_id_dec}/mjpeg")
async def get_window_mjpeg(win_id_dec: int, fps: int = 15):
    """Stream de vídeo de fallback em MJPEG universal."""
    async def mjpeg_generator():
        cmd = [
            "ffmpeg",
            "-f", "x11grab",
            "-framerate", str(fps),
            "-window_id", str(win_id_dec),
            "-i", ":0.0",
            "-q:v", "5",
            "-f", "mpjpeg",
            "pipe:1"
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        boundary = b"--ffmpeg\r\n"
        buffer = b""
        try:
            while True:
                if proc.stdout is None:
                    break
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                buffer += chunk
                while boundary in buffer:
                    part, buffer = buffer.split(boundary, 1)
                    if part:
                        yield boundary + part
                await asyncio.sleep(0.01)
        finally:
            proc.terminate()
            proc.kill()

    return StreamingResponse(
        mjpeg_generator(), 
        media_type="multipart/x-mixed-replace; boundary=ffmpeg",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )

@app.post("/api/windows/{win_id_hex}/workspace")
def move_workspace(win_id_hex: str, workspace: int = 1):
    """Move janela para outro workspace (ocultar sem pausar render)."""
    ok = move_window_to_workspace(win_id_hex, workspace)
    if not ok:
        raise HTTPException(status_code=500, detail="Falha ao mover janela.")
    return {"status": "ok", "workspace": workspace}

@app.post("/api/offer")
async def rtc_offer(params: OfferPayload):
    """
    Endpoint de sinalização WebRTC (SDP Offer -> Answer).
    Instancia o track de captura X11 para a janela solicitada.
    """
    offer = RTCSessionDescription(sdp=params.sdp, type=params.type)
    pc = RTCPeerConnection()
    pc_id = f"pc_{len(pcs) + 1}_{int(asyncio.get_event_loop().time())}"
    pcs[pc_id] = pc
    if params.window_id_hex:
        stream_windows[pc_id] = params.window_id_hex

    # Cria track de captura X11
    video_track = X11WindowStreamTrack(
        window_id=params.window_id,
        x=params.x,
        y=params.y,
        width=params.width,
        height=params.height,
        fps=params.fps
    )
    tracks[pc_id] = video_track
    pc.addTrack(video_track)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        if pc.connectionState in ["failed", "closed", "disconnected"]:
            await cleanup_pc(pc_id)

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type,
        "session_id": pc_id
    }

@app.post("/api/stop/{session_id}")
async def stop_stream(session_id: str):
    """Encerra um stream e libera recursos de captura."""
    await cleanup_pc(session_id)
    return {"status": "stopped", "session_id": session_id}

async def cleanup_pc(pc_id: str):
    if pc_id in stream_windows:
        stream_windows.pop(pc_id)
    if pc_id in tracks:
        track = tracks.pop(pc_id)
        track.stop()
    if pc_id in pcs:
        pc = pcs.pop(pc_id)
        await pc.close()
    print(f"[Cleanup] Sessão {pc_id} finalizada.")

# Servir Frontend SPA Estático com Headers No-Cache
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

@app.get("/")
def serve_index():
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(
            index_file, 
            headers={"Cache-Control": "no-cache, no-store, must-revalidate, max-age=0"}
        )
    return {"message": "Stream Monitor API Ativa."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app:app", host="127.0.0.1", port=3090, reload=True)
