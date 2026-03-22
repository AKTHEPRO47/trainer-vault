// Cloudflare Pages Function — /api/price-chat
// Uses environment variable ANTHROPIC_API_KEY (set in Cloudflare Dashboard > Settings > Environment variables)

const PRICE_ORACLE_SYSTEM_PROMPT = `You are Price Oracle, an expert Pokémon TCG pricing assistant specializing in Full Art, Illustration Rare, and Special Illustration Rare Trainer cards in English. You have deep knowledge of:

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

Be conversational, enthusiastic about Pokémon cards, and concise.`;

export async function onRequestPost(context) {
  const apiKey = context.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { reply: 'ANTHROPIC_API_KEY not configured. Set it in Cloudflare Dashboard > Settings > Environment variables.' },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ reply: 'Invalid request.' }, { status: 400 });
  }

  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || !messages.length) {
    return Response.json({ reply: 'No messages provided.' }, { status: 400 });
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: PRICE_ORACLE_SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return Response.json({ reply: `API error: ${resp.status}` }, { status: 502 });
    }

    const data = await resp.json();
    return Response.json({ reply: data.content[0].text });
  } catch (e) {
    return Response.json({ reply: `Error contacting Price Oracle: ${e.message}` }, { status: 500 });
  }
}
