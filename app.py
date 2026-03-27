import os
import json
import re
import hmac as hmac_mod
import hashlib
import base64
import time as time_mod
import secrets as secrets_mod
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash
import requests as http_requests

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


# Price chat is now fully client-side — no backend API needed

# ============ PRICE CHECK (scrape PriceCharting & TCGPlayer) ============

_price_cache = {}  # key -> { data, timestamp }
PRICE_CACHE_TTL = 600  # 10 minutes


def _normalize_token(text):
    return re.sub(r'[^a-z0-9]', '', (text or '').lower())


def _score_line(line, card_name, card_number):
    score = 0
    line_low = line.lower()
    number_norm = _normalize_token(card_number)
    if number_norm and number_norm in _normalize_token(line):
        score += 6
    for token in re.findall(r'[a-z0-9]+', (card_name or '').lower()):
        if len(token) >= 3 and token in line_low:
            score += 1
    return score


def _fetch_mirror_markdown(url, timeout=20):
    mirror_url = f"https://r.jina.ai/http://{url.replace('https://', '').replace('http://', '')}"
    headers = {'User-Agent': 'TrainerVaultPriceBot/1.0'}
    resp = http_requests.get(mirror_url, headers=headers, timeout=timeout)
    if not resp.ok:
        raise RuntimeError(f"Mirror fetch failed with status {resp.status_code}")
    return resp.text


def _parse_pricecharting(markdown, card_name, card_number):
    table_lines = [ln.strip() for ln in markdown.splitlines() if 'pricecharting.com/game/' in ln and '$' in ln and '|' in ln]
    if not table_lines:
        return {"title": card_name, "prices": {}, "url": "", "status": "no-data"}

    best_line = max(table_lines, key=lambda ln: _score_line(ln, card_name, card_number))

    links = re.findall(r'\[([^\]]+)\]\((https?://www\.pricecharting\.com/game/[^)\s]+)', best_line)
    title = card_name
    product_url = ''
    for text, url in links:
        if not text.lower().startswith('image'):
            title = text.strip()
            product_url = url
            break

    prices_found = re.findall(r'\$\d[\d,]*(?:\.\d{2})?', best_line)
    prices = {}
    if len(prices_found) >= 1:
        prices['ungraded'] = prices_found[0]
    if len(prices_found) >= 2:
        prices['psa9'] = prices_found[1]
    if len(prices_found) >= 3:
        prices['psa10'] = prices_found[2]

    return {
        "title": title,
        "prices": prices,
        "url": product_url,
        "status": "ok" if prices else "partial",
        "matched_line": best_line[:500]
    }


def _parse_tcgplayer(markdown, card_name, card_number):
    lines = [ln.strip() for ln in markdown.splitlines() if 'Market Price:$' in ln and 'listings from $' in ln and '####' in ln]
    if not lines:
        return {"title": card_name, "market_price": None, "low_price": None, "url": "", "status": "no-data"}

    best_line = max(lines, key=lambda ln: _score_line(ln, card_name, card_number))

    title_match = re.search(r'####\s*(.*?)\s+\d+\s+listings\s+from\s+\$', best_line)
    low_match = re.search(r'listings\s+from\s+(\$\d[\d,]*(?:\.\d{2})?)', best_line)
    market_match = re.search(r'Market\s+Price:\s*(\$\d[\d,]*(?:\.\d{2})?)', best_line)
    url_match = re.search(r'\]\((https?://www\.tcgplayer\.com/[^)\s]+)\)\s*$', best_line)

    return {
        "title": title_match.group(1).strip() if title_match else card_name,
        "market_price": market_match.group(1) if market_match else None,
        "low_price": low_match.group(1) if low_match else None,
        "url": url_match.group(1) if url_match else '',
        "status": "ok" if (market_match or low_match) else "partial",
        "matched_line": best_line[:500]
    }


@app.route('/api/price-check', methods=['GET'])
def price_check():
    card_name = request.args.get('name', '').strip()
    set_name = request.args.get('set', '').strip()
    card_number = request.args.get('number', '').strip()

    if not card_name:
        return jsonify({"error": "Card name required"}), 400

    cache_key = f"{card_name}|{set_name}|{card_number}"
    now = time_mod.time()
    if cache_key in _price_cache and now - _price_cache[cache_key]['timestamp'] < PRICE_CACHE_TTL:
        cached_data = dict(_price_cache[cache_key]['data'])
        cached_meta = dict(cached_data.get('meta', {}))
        cached_meta['cached'] = True
        cached_data['meta'] = cached_meta
        return jsonify(cached_data)

    results = {
        "pricecharting": {"title": card_name, "prices": {}, "url": "", "status": "error"},
        "tcgplayer": {"title": card_name, "market_price": None, "low_price": None, "url": "", "status": "error"},
        "meta": {"source": "mirror", "cached": False, "fetched_at": int(now)}
    }

    pc_query = f"pokemon {card_name} {set_name}".strip()
    pc_url = f"https://www.pricecharting.com/search-products?q={http_requests.utils.quote(pc_query)}&type=prices"
    tcg_query = f"{card_name} {set_name} {card_number}".strip()
    tcg_url = f"https://www.tcgplayer.com/search/pokemon/product?q={http_requests.utils.quote(tcg_query)}"

    try:
        pc_md = _fetch_mirror_markdown(pc_url)
        results["pricecharting"] = _parse_pricecharting(pc_md, card_name, card_number)
        if not results["pricecharting"].get("url"):
            results["pricecharting"]["url"] = pc_url
    except Exception as e:
        results["pricecharting"] = {
            "title": card_name,
            "prices": {},
            "url": pc_url,
            "status": "error",
            "error": str(e)
        }

    try:
        tcg_md = _fetch_mirror_markdown(tcg_url)
        results["tcgplayer"] = _parse_tcgplayer(tcg_md, card_name, card_number)
        if not results["tcgplayer"].get("url"):
            results["tcgplayer"]["url"] = tcg_url
    except Exception as e:
        results["tcgplayer"] = {
            "title": card_name,
            "market_price": None,
            "low_price": None,
            "url": tcg_url,
            "status": "error",
            "error": str(e)
        }

    _price_cache[cache_key] = {'data': results, 'timestamp': now}
    return jsonify(results)


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
