// Cloudflare Pages Function — /api/price-chat
// Price Oracle is now fully client-side — this endpoint is kept as a no-op fallback

export async function onRequestPost() {
  return Response.json({ reply: 'Price Oracle is now built into the app — no server needed!' });
}
