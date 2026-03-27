// Cloudflare Pages Function — /api/price-check
// Retrieves live-ish card prices by parsing mirrored page snapshots.

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const priceCache = new Map();

function normalizeToken(text = '') {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scoreLine(line, cardName, cardNumber) {
  let score = 0;
  const low = line.toLowerCase();
  const numberNorm = normalizeToken(cardNumber);
  if (numberNorm && normalizeToken(line).includes(numberNorm)) score += 6;
  const tokens = String(cardName).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const token of tokens) {
    if (token.length >= 3 && low.includes(token)) score += 1;
  }
  return score;
}

async function fetchMirrorText(url) {
  const mirrorUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
  const resp = await fetch(mirrorUrl, {
    headers: {
      'User-Agent': 'TrainerVaultPriceBot/1.0',
      'Accept': 'text/plain, text/markdown;q=0.9, */*;q=0.8'
    }
  });
  if (!resp.ok) {
    throw new Error(`Mirror fetch failed (${resp.status})`);
  }
  return await resp.text();
}

function parsePriceCharting(markdown, cardName, cardNumber) {
  const lines = markdown
    .split('\n')
    .map((x) => x.trim())
    .filter((line) => line.includes('pricecharting.com/game/') && line.includes('$') && line.includes('|'));

  if (!lines.length) {
    return { title: cardName, prices: {}, url: '', status: 'no-data' };
  }

  const bestLine = lines.reduce((best, line) => (
    scoreLine(line, cardName, cardNumber) > scoreLine(best, cardName, cardNumber) ? line : best
  ));

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/www\.pricecharting\.com\/game\/[^)\s]+)[^)]*\)/g;
  let title = cardName;
  let productUrl = '';
  for (const m of bestLine.matchAll(linkRegex)) {
    const text = (m[1] || '').trim();
    if (!/^image\s*\d*/i.test(text)) {
      title = text;
      productUrl = m[2] || '';
      break;
    }
  }

  const amountMatches = [...bestLine.matchAll(/\$\d[\d,]*(?:\.\d{2})?/g)].map((m) => m[0]);
  const prices = {};
  if (amountMatches[0]) prices.ungraded = amountMatches[0];
  if (amountMatches[1]) prices.psa9 = amountMatches[1];
  if (amountMatches[2]) prices.psa10 = amountMatches[2];

  return {
    title,
    prices,
    url: productUrl,
    status: Object.keys(prices).length ? 'ok' : 'partial'
  };
}

function parseTcgPlayer(markdown, cardName, cardNumber) {
  const lines = markdown
    .split('\n')
    .map((x) => x.trim())
    .filter((line) => line.includes('####') && line.includes('listings from $') && line.includes('Market Price:$'));

  if (!lines.length) {
    return { title: cardName, market_price: null, low_price: null, url: '', status: 'no-data' };
  }

  const bestLine = lines.reduce((best, line) => (
    scoreLine(line, cardName, cardNumber) > scoreLine(best, cardName, cardNumber) ? line : best
  ));

  const titleMatch = bestLine.match(/####\s*(.*?)\s+\d+\s+listings\s+from\s+\$/);
  const lowMatch = bestLine.match(/listings\s+from\s+(\$\d[\d,]*(?:\.\d{2})?)/);
  const marketMatch = bestLine.match(/Market\s+Price:\s*(\$\d[\d,]*(?:\.\d{2})?)/);
  const urlMatch = bestLine.match(/\]\((https?:\/\/www\.tcgplayer\.com\/[^)\s]+)\)\s*$/);

  return {
    title: titleMatch ? titleMatch[1].trim() : cardName,
    market_price: marketMatch ? marketMatch[1] : null,
    low_price: lowMatch ? lowMatch[1] : null,
    url: urlMatch ? urlMatch[1] : '',
    status: (marketMatch || lowMatch) ? 'ok' : 'partial'
  };
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const cardName = (url.searchParams.get('name') || '').trim();
    const setName = (url.searchParams.get('set') || '').trim();
    const cardNumber = (url.searchParams.get('number') || '').trim();

    if (!cardName) {
      return Response.json({ error: 'Card name required' }, { status: 400 });
    }

    const cacheKey = `${cardName}|${setName}|${cardNumber}`;
    const now = Date.now();
    const cached = priceCache.get(cacheKey);
    if (cached && (now - cached.timestamp <= PRICE_CACHE_TTL_MS)) {
      const cachedData = {
        ...cached.data,
        meta: { ...(cached.data.meta || {}), cached: true }
      };
      return Response.json(cachedData);
    }

    const pcQuery = `pokemon ${cardName} ${setName}`.trim();
    const pcUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(pcQuery)}&type=prices`;
    const tcgQuery = `${cardName} ${setName} ${cardNumber}`.trim();
    const tcgUrl = `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(tcgQuery)}`;

    const result = {
      pricecharting: { title: cardName, prices: {}, url: pcUrl, status: 'error' },
      tcgplayer: { title: cardName, market_price: null, low_price: null, url: tcgUrl, status: 'error' },
      meta: { source: 'cloudflare-mirror', cached: false, fetched_at: Math.floor(now / 1000) }
    };

    try {
      const pcMd = await fetchMirrorText(pcUrl);
      const pcParsed = parsePriceCharting(pcMd, cardName, cardNumber);
      result.pricecharting = { ...pcParsed, url: pcParsed.url || pcUrl };
    } catch (err) {
      result.pricecharting.error = String(err && err.message ? err.message : err);
    }

    try {
      const tcgMd = await fetchMirrorText(tcgUrl);
      const tcgParsed = parseTcgPlayer(tcgMd, cardName, cardNumber);
      result.tcgplayer = { ...tcgParsed, url: tcgParsed.url || tcgUrl };
    } catch (err) {
      result.tcgplayer.error = String(err && err.message ? err.message : err);
    }

    priceCache.set(cacheKey, { data: result, timestamp: now });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: 'Price check failed', detail: String(err && err.message ? err.message : err) }, { status: 500 });
  }
}
