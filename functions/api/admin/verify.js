// Cloudflare Pages Function — /api/admin/verify
// Verifies that a JWT token is still valid

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
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

export async function onRequestGet(context) {
  const secret = context.env.ADMIN_JWT_SECRET;
  if (!secret) {
    return Response.json({ error: 'Not configured' }, { status: 503 });
  }

  const auth = context.request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const valid = await verifyJWT(auth.slice(7), secret);
  if (!valid) {
    return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  return Response.json({ valid: true });
}
