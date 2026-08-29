import subprocess
import re
import shutil
import os
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

def activate_window(win_id_hex: str) -> bool:
    """Foca e eleva a janela no X11."""
    try:
        env = dict(os.environ, DISPLAY=":0")
        subprocess.run(["xdotool", "windowactivate", "--sync", win_id_hex], env=env, check=True, timeout=3)
        return True
    except Exception as e:
        print(f"Erro ao ativar janela {win_id_hex}: {e}")
        return False

def send_text_to_window(win_id_hex: str, text: str, press_enter: bool = True) -> bool:
    """
    Digita/cola texto na janela especificada usando xclip + ctrl+shift+v (ou xdotool type).
    Garante suporte perfeito a unicode, caracteres especiais e acentuação.
    """
    try:
        env = dict(os.environ, DISPLAY=":0")
        subprocess.run(["xdotool", "windowactivate", "--sync", win_id_hex], env=env, check=True, timeout=3)
        
        if shutil.which("xclip"):
            p = subprocess.Popen(["xclip", "-selection", "clipboard"], stdin=subprocess.PIPE, env=env)
            p.communicate(input=text.encode("utf-8"), timeout=3)
            subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+shift+v"], env=env, timeout=3)
        else:
            for char in text:
                subprocess.run(["xdotool", "type", "--clearmodifiers", char], env=env, timeout=1)

        if press_enter:
            subprocess.run(["xdotool", "key", "--clearmodifiers", "Return"], env=env, timeout=2)
        return True
    except Exception as e:
        print(f"Erro ao enviar texto para janela {win_id_hex}: {e}")
        return False

def send_key_to_window(win_id_hex: str, key_combo: str) -> bool:
    """
    Envia atalho ou tecla especial (ex: Return, ctrl+c, Escape, Up, Down, ctrl+l, BackSpace).
    """
    try:
        env = dict(os.environ, DISPLAY=":0")
        subprocess.run(["xdotool", "windowactivate", "--sync", win_id_hex], env=env, check=True, timeout=3)
        subprocess.run(["xdotool", "key", "--clearmodifiers", key_combo], env=env, check=True, timeout=3)
        return True
    except Exception as e:
        print(f"Erro ao enviar tecla {key_combo} para janela {win_id_hex}: {e}")
        return False

def send_click_to_window(win_id_hex: str, rel_x_pct: float, rel_y_pct: float, button: int = 1) -> bool:
    """
    Envia clique do mouse em coordenadas relativas percentuais (0.0 a 1.0) dentro da janela.
    """
    try:
        env = dict(os.environ, DISPLAY=":0")
        out = subprocess.check_output(["xwininfo", "-id", win_id_hex], env=env, text=True, stderr=subprocess.DEVNULL)
        w_match = re.search(r"Width:\s+(\d+)", out)
        h_match = re.search(r"Height:\s+(\d+)", out)
        if not w_match or not h_match:
            return False
        
        width = int(w_match.group(1))
        height = int(h_match.group(1))
        
        target_x = max(2, min(int(width * rel_x_pct), width - 2))
        target_y = max(2, min(int(height * rel_y_pct), height - 2))
        
        subprocess.run(["xdotool", "windowactivate", "--sync", win_id_hex], env=env, timeout=3)
        subprocess.run(["xdotool", "mousemove", "--window", win_id_hex, str(target_x), str(target_y), "click", str(button)], env=env, timeout=3)
        return True
    except Exception as e:
        print(f"Erro ao clicar na janela {win_id_hex}: {e}")
        return False
