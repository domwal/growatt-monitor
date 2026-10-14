"""Servidor Flask que consulta a nuvem da Growatt para uma ou mais contas.

As credenciais não ficam no servidor: o navegador guarda usuário/senha
criptografados (vault local) e os envia para cá apenas para abrir/renovar
a sessão de cada conta. Cada conta tem sua própria sessão HTTP e thread de
polling, isoladas por um "account_id" gerado pelo frontend.
"""

import logging
import os
import threading
from datetime import datetime, timezone

import growattServer
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("growatt-app")

POLL_INTERVAL = int(os.environ.get("GROWATT_POLL_INTERVAL", "30"))
PORT = int(os.environ.get("PORT", "5000"))
DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
# HTTPS com certificado autoassinado: necessário para o vault (Web Crypto)
# funcionar quando acessado de outro aparelho na rede (não localhost).
SSL_ADHOC = os.environ.get("FLASK_SSL_ADHOC", "false").lower() == "true"

# O servidor da Growatt bloqueia (403) o User-Agent padrão da lib, que imita
# um app Android (Dalvik/...). Um User-Agent de navegador comum passa normalmente.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

app = Flask(__name__, static_folder="static", static_url_path="")

_accounts_lock = threading.Lock()
_accounts = {}  # account_id -> dict com api, credenciais, estado, thread, stop_event


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _new_api():
    api = growattServer.GrowattApi(agent_identifier=BROWSER_USER_AGENT)
    api.server_url = "https://server.growatt.com/"
    return api


def _login(account):
    """Autentica na API da Growatt e descobre a usina, se necessário."""
    login_response = account["api"].login(account["username"], account["password"])
    if not login_response.get("success"):
        msg = login_response.get("error") or login_response.get("msg") or "credenciais inválidas"
        raise RuntimeError(f"Falha no login Growatt: {msg}")

    user_id = login_response["user"]["id"]
    plants = account["api"].plant_list(user_id).get("data", [])
    if not plants:
        raise RuntimeError("Nenhuma usina (plant) encontrada nesta conta Growatt.")

    plant_id = account.get("plant_id")
    if plant_id:
        plant_name = next(
            (p.get("plantName") for p in plants if str(p.get("plantId")) == str(plant_id)),
            None,
        )
    else:
        plant_id = plants[0]["plantId"]
        plant_name = plants[0].get("plantName")

    account["plant_id"] = plant_id
    account["state"]["plant_id"] = plant_id
    account["state"]["plant_name"] = plant_name
    account["logged_in"] = True
    log.info("[%s] Login OK. Usina selecionada: %s (%s)", account["id"], plant_name, plant_id)


def _poll_account(account):
    if not account["logged_in"]:
        _login(account)

    try:
        info = account["api"].plant_info(account["plant_id"])
    except Exception:
        log.warning("[%s] Falha ao consultar plant_info, tentando novo login...", account["id"])
        account["logged_in"] = False
        _login(account)
        info = account["api"].plant_info(account["plant_id"])

    state = account["state"]
    state["connected"] = True
    state["error"] = None
    state["last_update"] = datetime.now(timezone.utc).isoformat()
    state["current_power_w"] = _to_float(info.get("invTodayPpv"))
    state["today_energy_kwh"] = _to_float(info.get("todayEnergy"))
    state["total_energy_kwh"] = _to_float(info.get("totalEnergy"))
    state["nominal_power_w"] = _to_float(info.get("nominalPower"))


def _account_loop(account_id, stop_event):
    # A primeira consulta roda assim que a thread inicia (sem esperar o
    # primeiro intervalo), já que o login na Growatt pode levar alguns
    # segundos e não deve bloquear a resposta HTTP de /api/accounts.
    while True:
        with _accounts_lock:
            account = _accounts.get(account_id)
        if account is None:
            return
        try:
            _poll_account(account)
        except Exception as exc:  # noqa: BLE001 - captura qualquer falha de rede/API
            log.error("[%s] Erro ao atualizar dados da Growatt: %s", account_id, exc)
            account["state"]["connected"] = False
            account["state"]["error"] = str(exc)
        if stop_event.wait(POLL_INTERVAL):
            return


def _make_account(account_id, label, username, password, plant_id):
    return {
        "id": account_id,
        "label": label,
        "username": username,
        "password": password,
        "plant_id": plant_id or None,
        "api": _new_api(),
        "logged_in": False,
        "stop_event": threading.Event(),
        "thread": None,
        "state": {
            "label": label,
            "connected": False,
            "error": None,
            "last_update": None,
            "plant_id": plant_id or None,
            "plant_name": None,
            "current_power_w": None,
            "today_energy_kwh": None,
            "total_energy_kwh": None,
            "nominal_power_w": None,
        },
    }


@app.post("/api/accounts")
def upsert_account():
    body = request.get_json(silent=True) or {}
    account_id = (body.get("id") or "").strip()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    label = (body.get("label") or "").strip() or username
    plant_id = (body.get("plant_id") or "").strip() or None

    if not account_id or not username or not password:
        return jsonify({"error": "id, username e password são obrigatórios"}), 400

    with _accounts_lock:
        existing = _accounts.get(account_id)
        if existing is not None:
            existing["stop_event"].set()

        account = _make_account(account_id, label, username, password, plant_id)
        _accounts[account_id] = account

    # O login/polling roda em background: a Growatt pode levar alguns
    # segundos para responder, e isso não deve travar esta requisição.
    stop_event = account["stop_event"]
    thread = threading.Thread(target=_account_loop, args=(account_id, stop_event), daemon=True)
    account["thread"] = thread
    thread.start()

    return jsonify({"ok": True, "state": account["state"]})


@app.delete("/api/accounts/<account_id>")
def remove_account(account_id):
    with _accounts_lock:
        account = _accounts.pop(account_id, None)
    if account is not None:
        account["stop_event"].set()
    return jsonify({"ok": True})


@app.get("/api/status")
def status():
    with _accounts_lock:
        accounts = {acc_id: dict(acc["state"]) for acc_id, acc in _accounts.items()}
    return jsonify({"accounts": accounts})


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    # use_reloader=False: evita subir um segundo processo (duplicaria as threads de polling).
    app.run(
        host="0.0.0.0",
        port=PORT,
        debug=DEBUG,
        use_reloader=False,
        ssl_context="adhoc" if SSL_ADHOC else None,
    )
