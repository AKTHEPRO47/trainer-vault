import os
import json
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COLLECTION_FILE = os.path.join(BASE_DIR, 'collection.json')
CARDS_FILE = os.path.join(BASE_DIR, 'trainer_vault_cards.json')

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


if __name__ == '__main__':
    app.run(debug=True, port=5000)
