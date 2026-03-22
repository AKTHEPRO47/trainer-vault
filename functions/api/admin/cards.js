// Cloudflare Pages Function — /api/admin/cards
// Admin CRUD for cards (KV-backed)
// Requires: ADMIN_JWT_SECRET env var, CARDS KV namespace

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

function b64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, sig] = parts;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );

    // Decode signature
    const sigStr = b64urlDecode(sig);
    const sigBytes = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) sigBytes[i] = sigStr.charCodeAt(i);

    const valid = await crypto.subtle.verify(
      'HMAC', key, sigBytes, encoder.encode(`${header}.${payload}`)
    );
    if (!valid) return false;

    const data = JSON.parse(b64urlDecode(payload));
    if (data.exp < Math.floor(Date.now() / 1000)) return false;
    return data.role === 'admin';
  } catch {
    return false;
  }
}

async function authorize(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  return verifyJWT(auth.slice(7), env.ADMIN_JWT_SECRET);
}

async function getCards(env) {
  const cards = await env.CARDS.get('all', { type: 'json' });
  return cards && Array.isArray(cards) ? cards : [];
}

async function saveCards(env, cards) {
  await env.CARDS.put('all', JSON.stringify(cards));
}

// POST /api/admin/cards — Add a card
export async function onRequestPost(context) {
  if (!(await authorize(context.request, context.env))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const required = ['name', 'card_number', 'set_name', 'era', 'variant'];
  for (const field of required) {
    if (!body[field] || !body[field].trim()) {
      return Response.json({ error: `Missing field: ${field}` }, { status: 400 });
    }
  }

  const cards = await getCards(context.env);
  const maxId = cards.reduce((max, c) => Math.max(max, c.id || 0), 0);
  const newCard = {
    id: maxId + 1,
    name: body.name.trim(),
    card_number: body.card_number.trim(),
    set_name: body.set_name.trim(),
    era: body.era.trim(),
    variant: body.variant.trim(),
  };
  cards.push(newCard);
  await saveCards(context.env, cards);

  return Response.json({ status: 'added', card: newCard }, { status: 201 });
}

// PUT /api/admin/cards — Edit a card (card_id in body)
export async function onRequestPut(context) {
  if (!(await authorize(context.request, context.env))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Get card_id from URL path: /api/admin/cards/123
  const url = new URL(context.request.url);
  const pathParts = url.pathname.split('/');
  const cardId = parseInt(pathParts[pathParts.length - 1]);
  if (isNaN(cardId)) {
    return Response.json({ error: 'Invalid card ID' }, { status: 400 });
  }

  const cards = await getCards(context.env);
  const card = cards.find(c => c.id === cardId);
  if (!card) {
    return Response.json({ error: 'Card not found' }, { status: 404 });
  }

  for (const field of ['name', 'card_number', 'set_name', 'era', 'variant']) {
    if (body[field] && body[field].trim()) {
      card[field] = body[field].trim();
    }
  }

  await saveCards(context.env, cards);
  return Response.json({ status: 'updated', card });
}

// DELETE /api/admin/cards — Delete a card (card_id from URL)
export async function onRequestDelete(context) {
  if (!(await authorize(context.request, context.env))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(context.request.url);
  const pathParts = url.pathname.split('/');
  const cardId = parseInt(pathParts[pathParts.length - 1]);
  if (isNaN(cardId)) {
    return Response.json({ error: 'Invalid card ID' }, { status: 400 });
  }

  const cards = await getCards(context.env);
  const filtered = cards.filter(c => c.id !== cardId);
  if (filtered.length === cards.length) {
    return Response.json({ error: 'Card not found' }, { status: 404 });
  }

  await saveCards(context.env, filtered);
  return Response.json({ status: 'deleted' });
}
