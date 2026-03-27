// Cloudflare Pages Function — /api/community
// Stores community snapshots in COLLECTION KV under a separate key.

const FEED_KEY = 'community_feed';
const MAX_ITEMS = 50;

function sanitizeText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

async function loadFeed(context) {
  try {
    const feed = await context.env.COLLECTION.get(FEED_KEY, { type: 'json' });
    return Array.isArray(feed) ? feed : [];
  } catch {
    return [];
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const limitRaw = Number(url.searchParams.get('limit') || 20);
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 20, 50));
  const feed = await loadFeed(context);
  return Response.json(feed.slice(0, limit));
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const alias = sanitizeText(body.alias, 32);
    const title = sanitizeText(body.title, 60);
    const note = sanitizeText(body.note, 160);
    const snapshot = body.snapshot;
    const summary = body.summary;

    if (!alias) {
      return Response.json({ error: 'Alias is required' }, { status: 400 });
    }
    if (!Array.isArray(snapshot) || !summary || typeof summary !== 'object') {
      return Response.json({ error: 'Snapshot and summary are required' }, { status: 400 });
    }

    const feed = await loadFeed(context);
    const entry = {
      id: crypto.randomUUID().slice(0, 12),
      alias,
      title,
      note,
      summary,
      snapshot,
      createdAt: Math.floor(Date.now() / 1000)
    };

    feed.unshift(entry);
    const trimmed = feed.slice(0, MAX_ITEMS);
    await context.env.COLLECTION.put(FEED_KEY, JSON.stringify(trimmed));
    return Response.json({ status: 'published', entry }, { status: 201 });
  } catch {
    return Response.json({ error: 'Publish failed' }, { status: 500 });
  }
}