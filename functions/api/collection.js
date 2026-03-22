// Cloudflare Pages Function — /api/collection
// Uses KV namespace "COLLECTION" for persistence
// Bind KV namespace in Cloudflare Dashboard: Settings > Functions > KV namespace bindings > COLLECTION

export async function onRequestGet(context) {
  try {
    const data = await context.env.COLLECTION.get('state', { type: 'json' });
    return Response.json(data || {});
  } catch {
    return Response.json({});
  }
}

export async function onRequestPost(context) {
  try {
    const data = await context.request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return Response.json({ error: 'Invalid data format' }, { status: 400 });
    }
    await context.env.COLLECTION.put('state', JSON.stringify(data));
    return Response.json({ status: 'saved' });
  } catch (e) {
    return Response.json({ error: 'Save failed' }, { status: 500 });
  }
}
