import os
import json
import asyncio
from typing import Dict, Any, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

from backend.window_manager import get_active_windows, move_window_to_workspace
from backend.streamer import X11WindowStreamTrack

app = FastAPI(title="Stream Monitor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Gerenciamento de Conexões WebRTC e Tracks ativas
pcs: Dict[str, RTCPeerConnection] = {}
tracks: Dict[str, X11WindowStreamTrack] = {}

class OfferPayload(BaseModel):
    sdp: str
    type: str
    window_id: int
    x: int = 0
    y: int = 0
    width: int = 1280
    height: int = 720
    fps: int = 30

@app.get("/api/windows")
def list_windows():
    """Retorna lista de janelas ativas no X11."""
    return {"windows": get_active_windows()}

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
        print(f"[WebRTC] {pc_id} state changed: {pc.connectionState}")
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
    if pc_id in tracks:
        track = tracks.pop(pc_id)
        track.stop()
    if pc_id in pcs:
        pc = pcs.pop(pc_id)
        await pc.close()
    print(f"[Cleanup] Sessão {pc_id} finalizada.")

# Servir Frontend SPA Estático
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

@app.get("/")
def serve_index():
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "Stream Monitor API Ativa. Frontend em construção."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app:app", host="127.0.0.1", port=3090, reload=True)
