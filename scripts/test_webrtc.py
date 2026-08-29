import asyncio, json, urllib.request
from aiortc import RTCPeerConnection, RTCSessionDescription

async def main():
    wins = json.load(urllib.request.urlopen("http://127.0.0.1:3090/api/windows"))["windows"]
    w = wins[0]
    print(f"janela: {w['title'][:50]} ({w['width']}x{w['height']})")

    pc = RTCPeerConnection()
    pc.addTransceiver("video", direction="recvonly")
    frames = []
    done = asyncio.Event()

    @pc.on("track")
    def on_track(track):
        async def pump():
            try:
                for _ in range(30):
                    f = await asyncio.wait_for(track.recv(), timeout=10)
                    frames.append((f.width, f.height, f.pts))
                    if len(frames) >= 30: break
            except Exception as e:
                print("pump parou:", type(e).__name__, e)
            done.set()
        asyncio.ensure_future(pump())

    await pc.setLocalDescription(await pc.createOffer())
    body = json.dumps({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type,
                       "window_id": w["id_dec"], "window_id_hex": w["id_hex"],
                       "x": w["x"], "y": w["y"], "width": w["width"], "height": w["height"],
                       "fps": 15, "client_id": "teste_cli", "card_key": "card1"}).encode()
    ans = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://127.0.0.1:3090/api/offer", data=body,
        headers={"Content-Type": "application/json"}), timeout=30))
    await pc.setRemoteDescription(RTCSessionDescription(sdp=ans["sdp"], type=ans["type"]))
    print("session:", ans["session_id"])

    try:
        await asyncio.wait_for(done.wait(), timeout=45)
    except asyncio.TimeoutError:
        print("TIMEOUT esperando frames")

    print(f"RESULTADO: {len(frames)} frames recebidos")
    if frames:
        print("  primeiro:", frames[0], " ultimo:", frames[-1])
        print("  PTS avancou:", frames[-1][2] > frames[0][2])
    print("  connectionState:", pc.connectionState)
    await pc.close()
    urllib.request.urlopen(urllib.request.Request(
        f"http://127.0.0.1:3090/api/stop/{ans['session_id']}", data=b"", method="POST"))

asyncio.run(main())
