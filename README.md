# TRAINER VAULT — Pokémon Full Art Trainer Collection Tracker

A visually stunning, fully interactive web application for tracking your complete Full Art / Illustration Rare / Special Illustration Rare English Trainer card collection across all eras (Black & White → Mega Evolution).

## Features

- 400+ Full Art Trainer cards across all eras
- 3D vertex mesh animated background
- Liquid glass morphism UI
- Full search + multi-filter system
- Collection stats dashboard
- Price Oracle chatbot (Claude-powered)
- Export/Import JSON + CSV
- Want list management
- Grading estimator tool
- Mobile responsive (375px+)
- Dark/dim mode toggle

## Local Development

```bash
pip install -r requirements.txt

# Set API key (optional, for Price Oracle)
# Windows PowerShell:
$env:ANTHROPIC_API_KEY="your_key_here"

python app.py
# Open http://localhost:5000
```

## Deploy to Cloudflare Pages

1. Push this repo to GitHub
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Pages → Create a project
3. Connect your GitHub repo
4. Build settings:
   - **Build command:** (leave empty)
   - **Build output directory:** `/`
5. Deploy

### Configure KV (for server-side collection backup)

1. Go to Cloudflare Dashboard → Workers & Pages → KV
2. Create a namespace called `COLLECTION`
3. Go to your Pages project → Settings → Functions → KV namespace bindings
4. Add binding: Variable name = `COLLECTION`, KV namespace = the one you created

### Configure Environment Variables

1. Go to your Pages project → Settings → Environment variables
2. Add `ANTHROPIC_API_KEY` = your Anthropic API key (for Price Oracle chatbot)

### Notes

- Collection data is stored in **localStorage** (primary) + Cloudflare KV (backup)
- The app works fully offline after first load
- Card images are fetched from the Pokémon TCG API on demand

## File Structure

```
trainer-vault/
├── index.html          # Full frontend (HTML + CSS + JS)
├── app.py              # Flask backend
├── requirements.txt    # Python deps
├── collection.json     # Auto-saved collection state (auto-generated)
└── README.md           # This file
```

## Usage

1. **Browse Cards**: Scroll through your collection grid or use search/filters
2. **Track Collection**: Click any card to toggle it as collected (gold glow)
3. **Card Details**: Right-click or long-press a card for the detail modal
4. **Set Condition**: Choose Mint / NM / LP / MP / HP / HP+ per card
5. **Want List**: Star cards you want to acquire
6. **Price Check**: Use the Price Oracle chatbot for pricing guidance
7. **Export**: Download your collection as JSON or CSV backup

## Tech Stack

- **Frontend**: HTML + CSS + JavaScript (single file, no frameworks)
- **Backend**: Python + Flask
- **AI**: Anthropic Claude API (for Price Oracle chatbot)
- **Storage**: localStorage + server-side JSON file
