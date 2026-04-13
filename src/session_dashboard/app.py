"""
Session Dashboard
Flask application entry point.
"""
import logging
from flask import Flask

from session_dashboard.extractor import (
    init_sessions_db,
    register_session_routes,
    start_auto_sync,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)

app = Flask(__name__)
init_sessions_db()
register_session_routes(app)
start_auto_sync()


if __name__ == "__main__":
    app.run(debug=True, port=5051)
