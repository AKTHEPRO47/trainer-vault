import os
import json
import hmac as hmac_mod
import hashlib
import base64
import time as time_mod
import secrets as secrets_mod
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COLLECTION_FILE = os.path.join(BASE_DIR, 'collection.json')
CARDS_FILE = os.path.join(BASE_DIR, 'trainer_vault_cards.json')

# Admin authentication (set via environment variables)
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH', '')
ADMIN_JWT_SECRET = os.environ.get('ADMIN_JWT_SECRET', '') or secrets_mod.token_hex(32)

# Rate limiting for login
_login_attempts = {}  # ip -> (count, last_attempt_time)


def _b64url_encode(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _b64url_decode(s):
    s += '=' * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(s)


def create_admin_jwt():
    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url_encode(json.dumps({
        "role": "admin",
        "exp": int(time_mod.time()) + 86400
    }).encode())
    sig = _b64url_encode(hmac_mod.new(
        ADMIN_JWT_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest())
    return f"{header}.{payload}.{sig}"


def verify_admin_jwt(token):
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return False
        header, payload, sig = parts
        expected = _b64url_encode(hmac_mod.new(
            ADMIN_JWT_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256
        ).digest())
        if not hmac_mod.compare_digest(sig, expected):
            return False
        data = json.loads(_b64url_decode(payload))
        if data.get('exp', 0) < time_mod.time():
            return False
        return data.get('role') == 'admin'
    except Exception:
        return False


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({"error": "Unauthorized"}), 401
        if not verify_admin_jwt(auth[7:]):
            return jsonify({"error": "Invalid or expired token"}), 401
        return f(*args, **kwargs)
    return decorated


PRICE_ORACLE_SYSTEM_PROMPT = """You are Price Oracle, an expert Pokémon TCG pricing assistant specializing in Full Art, Illustration Rare, and Special Illustration Rare Trainer cards in English. You have deep knowledge of:

- TCG card grading scales: Mint (PSA 10 / BGS 10), Near Mint (NM/NM+, PSA 9), Lightly Played (LP, PSA 8), Moderately Played (MP, PSA 7), Heavily Played (HP, PSA 6), Damaged/HP+ (PSA 1-5)
- Price ranges for ungraded raw cards vs PSA/BGS graded cards
- Market trends on TCGPlayer, eBay sold listings, and card market platforms
- Which cards are high-demand collectibles vs common pulls
- Reprint risk assessment for each era
- Investment/collector value perspective

When asked about a specific card, provide:
1. Estimated raw price ranges by condition (Mint, NM, LP, MP, HP, HP+)
2. PSA 9 and PSA 10 graded price estimates
3. Market trend (rising/stable/falling)
4. Notable facts about the card's collectibility
5. Buy recommendation (good deal under what price?)

Always note your prices are estimates based on training data and actual prices vary — direct users to TCGPlayer or eBay sold listings for real-time data.

Be conversational, enthusiastic about Pokémon cards, and concise."""


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/api/cards', methods=['GET'])
def get_cards():
    if os.path.exists(CARDS_FILE):
        with open(CARDS_FILE, 'r', encoding='utf-8') as f:
            cards = json.load(f)
        return jsonify(cards)
    return jsonify([])


@app.route('/api/collection', methods=['GET'])
def get_collection():
    if os.path.exists(COLLECTION_FILE):
        with open(COLLECTION_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    return jsonify({})


@app.route('/api/collection', methods=['POST'])
def save_collection():
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid data format"}), 400
    with open(COLLECTION_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return jsonify({"status": "saved"})


@app.route('/api/price-chat', methods=['POST'])
def price_chat():
    try:
        import anthropic
    except ImportError:
        return jsonify({"reply": "Anthropic library not installed. Run: pip install anthropic"}), 500

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return jsonify({"reply": "ANTHROPIC_API_KEY environment variable not set. Please set it and restart the server."}), 500

    data = request.json
    messages = data.get('messages', [])

    if not messages or not isinstance(messages, list):
        return jsonify({"reply": "No messages provided."}), 400

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            system=PRICE_ORACLE_SYSTEM_PROMPT,
            messages=messages
        )
        return jsonify({"reply": response.content[0].text})
    except Exception as e:
        return jsonify({"reply": f"Error contacting Price Oracle: {str(e)}"}), 500


# ============ ADMIN ENDPOINTS ============

@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    if not ADMIN_PASSWORD_HASH:
        return jsonify({"error": "Admin not configured. Set ADMIN_PASSWORD_HASH env var."}), 503

    ip = request.remote_addr or 'unknown'
    now = time_mod.time()

    # Rate limiting: max 5 attempts per 60 seconds
    if ip in _login_attempts:
        count, last_time = _login_attempts[ip]
        if now - last_time < 60 and count >= 5:
            return jsonify({"error": "Too many attempts. Try again later."}), 429
        if now - last_time >= 60:
            _login_attempts[ip] = (0, now)

    data = request.json
    password = data.get('password', '') if data else ''

    if not password or not check_password_hash(ADMIN_PASSWORD_HASH, password):
        if ip in _login_attempts:
            c, _ = _login_attempts[ip]
            _login_attempts[ip] = (c + 1, now)
        else:
            _login_attempts[ip] = (1, now)
        return jsonify({"error": "Invalid password"}), 401

    _login_attempts.pop(ip, None)
    return jsonify({"token": create_admin_jwt()})


@app.route('/api/admin/verify', methods=['GET'])
@require_admin
def admin_verify():
    return jsonify({"valid": True})


@app.route('/api/admin/cards', methods=['POST'])
@require_admin
def admin_add_card():
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    required = ['name', 'card_number', 'set_name', 'era', 'variant']
    for field in required:
        if not data.get(field, '').strip():
            return jsonify({"error": f"Missing field: {field}"}), 400

    cards = []
    if os.path.exists(CARDS_FILE):
        with open(CARDS_FILE, 'r', encoding='utf-8') as f:
            cards = json.load(f)

    max_id = max((c.get('id', 0) for c in cards), default=0)
    new_card = {
        "id": max_id + 1,
        "name": data['name'].strip(),
        "card_number": data['card_number'].strip(),
        "set_name": data['set_name'].strip(),
        "era": data['era'].strip(),
        "variant": data['variant'].strip(),
    }
    cards.append(new_card)

    with open(CARDS_FILE, 'w', encoding='utf-8') as f:
        json.dump(cards, f, indent=2, ensure_ascii=False)

    return jsonify({"status": "added", "card": new_card}), 201


@app.route('/api/admin/cards/<int:card_id>', methods=['PUT'])
@require_admin
def admin_edit_card(card_id):
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    cards = []
    if os.path.exists(CARDS_FILE):
        with open(CARDS_FILE, 'r', encoding='utf-8') as f:
            cards = json.load(f)

    card = next((c for c in cards if c.get('id') == card_id), None)
    if not card:
        return jsonify({"error": "Card not found"}), 404

    for field in ['name', 'card_number', 'set_name', 'era', 'variant']:
        if field in data and data[field] and data[field].strip():
            card[field] = data[field].strip()

    with open(CARDS_FILE, 'w', encoding='utf-8') as f:
        json.dump(cards, f, indent=2, ensure_ascii=False)

    return jsonify({"status": "updated", "card": card})


@app.route('/api/admin/cards/<int:card_id>', methods=['DELETE'])
@require_admin
def admin_delete_card(card_id):
    cards = []
    if os.path.exists(CARDS_FILE):
        with open(CARDS_FILE, 'r', encoding='utf-8') as f:
            cards = json.load(f)

    original_len = len(cards)
    cards = [c for c in cards if c.get('id') != card_id]
    if len(cards) == original_len:
        return jsonify({"error": "Card not found"}), 404

    with open(CARDS_FILE, 'w', encoding='utf-8') as f:
        json.dump(cards, f, indent=2, ensure_ascii=False)

    return jsonify({"status": "deleted"})


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == '--hash-password':
        import getpass
        pw = getpass.getpass('Enter admin password: ')
        pw2 = getpass.getpass('Confirm password: ')
        if pw != pw2:
            print('Passwords do not match.')
            sys.exit(1)
        print(f'\nSet this environment variable before running the server:')
        print(f'  ADMIN_PASSWORD_HASH={generate_password_hash(pw, method="pbkdf2:sha256")}')
        sys.exit(0)
    app.run(debug=True, port=5000)
