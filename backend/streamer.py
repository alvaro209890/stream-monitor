import asyncio
import fractions
import time
import av
from aiortc import VideoStreamTrack
from aiortc.mediastreams import MediaStreamError

class X11WindowStreamTrack(VideoStreamTrack):
    """
    Faixa de vídeo WebRTC que captura uma janela ou região X11 via PyAV / FFmpeg x11grab.
    Herda de VideoStreamTrack para gerenciar timestamps/PTS e clock rate perfeitamente.
    Re-formata os frames nativos (bgr0) para yuv420p com dimensões pares para decodificação perfeita no browser/iOS.
    """
    kind = "video"

    def __init__(self, window_id: int = 0, x: int = 0, y: int = 0, width: int = 1280, height: int = 720, fps: int = 30):
        super().__init__()
        self.window_id = window_id
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.fps = fps
        self._container = None
        self._stream = None
        self._generator = None
        self._stopped = False
        self._init_capture()

    def _init_capture(self):
        options = {
            "framerate": str(self.fps),
            "draw_mouse": "0"
        }

        # Ajuste de dimensões pares iniciais
        w = self.width if self.width % 2 == 0 else self.width - 1
        h = self.height if self.height % 2 == 0 else self.height - 1
        if w < 100: w = 1280
        if h < 100: h = 720

        # Se tiver window_id tenta captura direta
        if self.window_id > 0:
            options["window_id"] = str(self.window_id)
            input_target = ":0.0"
        else:
            options["video_size"] = f"{w}x{h}"
            input_target = f":0.0+{self.x},{self.y}"

        try:
            self._container = av.open(
                input_target,
                format="x11grab",
                options=options,
                mode="r"
            )
            self._stream = self._container.streams.video[0]
            self._generator = self._container.decode(self._stream)
        except Exception as e:
            print(f"[StreamTrack] Erro abrindo x11grab com window_id {self.window_id}: {e}. Fallback por offset...")
            options.pop("window_id", None)
            options["video_size"] = f"{w}x{h}"
            input_target = f":0.0+{self.x},{self.y}"
            self._container = av.open(
                input_target,
                format="x11grab",
                options=options,
                mode="r"
            )
            self._stream = self._container.streams.video[0]
            self._generator = self._container.decode(self._stream)

    async def recv(self):
        if self._stopped or self._generator is None:
            raise MediaStreamError

        pts, time_base = await self.next_timestamp()

        loop = asyncio.get_event_loop()
        try:
            frame = await loop.run_in_executor(None, self._get_next_frame)
            if frame is None:
                raise MediaStreamError

            # Converte BGR0 do X11 para YUV420P com dimensões pares
            target_w = frame.width if frame.width % 2 == 0 else frame.width - 1
            target_h = frame.height if frame.height % 2 == 0 else frame.height - 1

            new_frame = frame.reformat(width=target_w, height=target_h, format="yuv420p")
            new_frame.pts = pts
            new_frame.time_base = time_base
            return new_frame
        except Exception as e:
            self.stop()
            raise MediaStreamError from e

    def _get_next_frame(self):
        if self._stopped or not self._generator:
            return None
        try:
            return next(self._generator)
        except Exception:
            return None

    def stop(self):
        if not self._stopped:
            self._stopped = True
            super().stop()
            if self._container:
                try:
                    self._container.close()
                except Exception:
                    pass
                self._container = None
            self._generator = None
