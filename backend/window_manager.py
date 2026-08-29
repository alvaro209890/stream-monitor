import subprocess
import re
import shutil
from typing import List, Dict, Any, Optional

def get_active_windows() -> List[Dict[str, Any]]:
    """
    Lista todas as janelas gerenciadas pelo X11 no Cinnamon/Mint.
    Filtra janelas de sistema irrelevantes (desktop, docks, painéis).
    """
    if not shutil.which("wmctrl"):
        return []
        
    try:
        # wmctrl -l -G -p -x retorna:
        # ID_HEX DESKTOP PID X Y W H CLASSE_WINDOW CLIENTE_HOST TITULO
        output = subprocess.check_output(
            ["wmctrl", "-l", "-G", "-p", "-x"], 
            text=True, 
            stderr=subprocess.DEVNULL
        )
    except Exception as e:
        print(f"Erro ao rodar wmctrl: {e}")
        return []

    windows = []
    ignored_classes = [
        "nemo-desktop.Nemo-desktop",
        "cinnamon.Cinnamon",
        "cinnamon-launcher.Cinnamon-launcher",
        "cinnamon-screensaver.Cinnamon-screensaver"
    ]

    for line in output.strip().split("\n"):
        if not line:
            continue
        parts = re.split(r'\s+', line, maxsplit=8)
        if len(parts) < 9:
            continue

        win_id_hex = parts[0]
        desktop_id = int(parts[1]) if parts[1].isdigit() or parts[1] == '-1' else 0
        pid = int(parts[2]) if parts[2].isdigit() else 0
        x = int(parts[3])
        y = int(parts[4])
        w = int(parts[5])
        h = int(parts[6])
        app_class = parts[7]
        title = parts[8].strip()

        # Filtra classes ignoradas ou janelas vazias / de sistema
        if any(ign.lower() in app_class.lower() for ign in ignored_classes):
            continue
        if w <= 1 or h <= 1:
            continue
        if not title:
            continue

        try:
            win_id_dec = int(win_id_hex, 16)
        except ValueError:
            win_id_dec = 0

        # Amigabilizar nome do app
        app_name = app_class.split('.')[-1] if '.' in app_class else app_class

        windows.append({
            "id_hex": win_id_hex,
            "id_dec": win_id_dec,
            "desktop": desktop_id,
            "pid": pid,
            "x": x,
            "y": y,
            "width": w,
            "height": h,
            "app_class": app_class,
            "app_name": app_name,
            "title": title
        })

    return windows

def is_window_alive(win_id_hex: str) -> bool:
    """Verifica se a janela ainda existe no X11."""
    wins = get_active_windows()
    return any(w["id_hex"].lower() == win_id_hex.lower() for w in wins)

def move_window_to_workspace(win_id_hex: str, workspace_index: int = 1) -> bool:
    """
    Move uma janela para um workspace secundário (para manter renderização sem ocupar o monitor físico).
    """
    try:
        subprocess.run(["wmctrl", "-i", "-r", win_id_hex, "-t", str(workspace_index)], check=True)
        return True
    except Exception as e:
        print(f"Erro ao mover janela {win_id_hex} para workspace {workspace_index}: {e}")
        return False
