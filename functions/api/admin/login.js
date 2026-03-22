// Cloudflare Pages Function — /api/admin/login
// Verifies admin password and returns a JWT
// Requires: ADMIN_PASSWORD_HASH env var (werkzeug pbkdf2:sha256 format)
// Requires: ADMIN_JWT_SECRET env var

async function verifyWerkzeugHash(password, storedHash) {
  // Parse werkzeug format: pbkdf2:sha256:iterations$salt$hash
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;

  const [methodInfo, salt, expectedHex] = parts;
  const methodParts = methodInfo.split(':');
  if (methodParts.length !== 3 || methodParts[0] !== 'pbkdf2' || methodParts[1] !== 'sha256') return false;

  const iterations = parseInt(methodParts[2]);
  if (!iterations || iterations < 1) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' },
    key, 256
  );

  const derivedHex = [...new Uint8Array(derived)]
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Timing-safe comparison
  if (derivedHex.length !== expectedHex.length) return false;
  let result = 0;
  for (let i = 0; i < derivedHex.length; i++) {
    result |= derivedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return result === 0;
}

function b64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function createJWT(secret) {
  const encoder = new TextEncoder();
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(encoder.encode(JSON.stringify({
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 86400
  })));

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

// Rate limiting via KV
async function checkRateLimit(ip, env) {
  const key = `ratelimit:${ip}`;
  const data = await env.CARDS.get(key, { type: 'json' });
  const now = Math.floor(Date.now() / 1000);
  if (data && now - data.start < 60 && data.count >= 5) {
    return false; // rate limited
  }
  return true;
}

async function recordAttempt(ip, env) {
  const key = `ratelimit:${ip}`;
  const data = await env.CARDS.get(key, { type: 'json' });
  const now = Math.floor(Date.now() / 1000);
  if (data && now - data.start < 60) {
    await env.CARDS.put(key, JSON.stringify({ count: data.count + 1, start: data.start }), { expirationTtl: 120 });
  } else {
    await env.CARDS.put(key, JSON.stringify({ count: 1, start: now }), { expirationTtl: 120 });
  }
}

async function clearRateLimit(ip, env) {
  await env.CARDS.delete(`ratelimit:${ip}`);
}

export async function onRequestPost(context) {
  const hash = context.env.ADMIN_PASSWORD_HASH;
  const secret = context.env.ADMIN_JWT_SECRET;

  if (!hash || !secret) {
    return Response.json(
      { error: 'Admin not configured. Set ADMIN_PASSWORD_HASH and ADMIN_JWT_SECRET.' },
      { status: 503 }
    );
  }

  const ip = context.request.headers.get('cf-connecting-ip') || 'unknown';

  const allowed = await checkRateLimit(ip, context.env);
  if (!allowed) {
    return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const password = body.password || '';
  if (!password) {
    await recordAttempt(ip, context.env);
    return Response.json({ error: 'Invalid password' }, { status: 401 });
  }

  const valid = await verifyWerkzeugHash(password, hash);
  if (!valid) {
    await recordAttempt(ip, context.env);
    return Response.json({ error: 'Invalid password' }, { status: 401 });
  }

  await clearRateLimit(ip, context.env);
  const token = await createJWT(secret);
  return Response.json({ token });
}
