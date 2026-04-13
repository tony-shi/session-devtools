"""Entry point for `uv run main.py`."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from session_dashboard.app import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5051"))
    app.run(debug=False, port=port)
