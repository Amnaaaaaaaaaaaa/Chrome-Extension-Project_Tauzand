"""
Plays an audible bell whenever the automation hits a point that needs a human
(CAPTCHA, login wall, unmapped field, etc). Kept in its own module so the alert
mechanism (currently a system beep) can be swapped later — e.g. for a desktop
notification or a WebSocket push to the frontend — without touching the
detection logic that calls it.
"""
import sys
import time
from config import Config


def _beep_once():
    """Best-effort terminal bell. Works cross-platform without extra native deps."""
    try:
        sys.stdout.write("\a")
        sys.stdout.flush()
    except Exception:
        pass

    # Fall back to a louder OS-level beep where available; failures are non-fatal
    # since the bell character above already covers most terminals.
    try:
        if sys.platform == "darwin":
            import os
            os.system("afplay /System/Library/Sounds/Ping.aiff > /dev/null 2>&1 &")
        elif sys.platform.startswith("linux"):
            import os
            os.system("paplay /usr/share/sounds/freedesktop/stereo/bell.oga > /dev/null 2>&1 &")
        elif sys.platform == "win32":
            import winsound
            winsound.Beep(880, 300)
    except Exception:
        pass


def alert_human_intervention_needed(reason: str) -> dict:
    """
    Fires the audio alert and returns a structured event describing why, so the
    caller can also surface it in the API response / video narration overlay.
    """
    event = {"type": "HUMAN_INTERVENTION_REQUIRED", "reason": reason, "timestamp": time.time()}

    if Config.AUDIO_ALERT_ENABLED:
        for _ in range(Config.AUDIO_ALERT_REPEAT_COUNT):
            _beep_once()
            time.sleep(0.3)

    return event
