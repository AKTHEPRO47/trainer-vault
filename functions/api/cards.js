// Cloudflare Pages Function — /api/cards
// Returns cards from KV (CARDS namespace), falls back to seeding from static JSON

export async function onRequestGet(context) {
  try {
    let cards = await context.env.CARDS.get('all', { type: 'json' });
    if (cards && Array.isArray(cards) && cards.length > 0) {
      return Response.json(cards);
    }
    // KV empty — seed from static JSON file
    const staticResp = await context.env.ASSETS.fetch(
      new URL('/trainer_vault_cards.json', context.request.url)
    );
    if (staticResp.ok) {
      cards = await staticResp.json();
      await context.env.CARDS.put('all', JSON.stringify(cards));
      return Response.json(cards);
    }
    return Response.json([]);
  } catch {
    return Response.json([], { status: 500 });
  }
}
