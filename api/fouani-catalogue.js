// Fouani catalogue reader. This endpoint only reads public product listings;
// the signed-in administrator's browser writes selected products to Firestore.
const BASE = 'https://fouanistore.com/nigeria-en/shop';

function decodeHtml(value = '') {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function plain(html = '') {
  return decodeHtml(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}
function absolute(url) {
  if (!url || /^(data:|javascript:)/i.test(url)) return '';
  try { return new URL(url, 'https://fouanistore.com').href; } catch { return ''; }
}
function priceNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function addProduct(out, p) {
  const name = plain(p.name || p.title || '');
  const image = absolute(Array.isArray(p.image) ? (typeof p.image[0] === 'string' ? p.image[0] : p.image[0]?.url) : (typeof p.image === 'object' ? p.image?.url : p.image));
  const price = priceNumber(p.price || p.offers?.price || p.offers?.lowPrice || p.amount);
  const url = absolute(p.url || p.productUrl || p.offers?.url);
  if (!name || !image || !price || !url) return;
  const key = url.split('?')[0].toLowerCase();
  if (out.some(x => x.sourceUrl.split('?')[0].toLowerCase() === key || x.name.toLowerCase() === name.toLowerCase())) return;
  out.push({ name, image, price, sourceUrl: url, sourceStore: 'Fouani' });
}
function fromJson(value, out) {
  if (!value) return;
  if (Array.isArray(value)) { for (const x of value) fromJson(x, out); return; }
  if (typeof value !== 'object') return;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some(t => String(t).toLowerCase() === 'product')) {
    const offers = Array.isArray(value.offers) ? value.offers[0] : value.offers || {};
    addProduct(out, { name: value.name, image: value.image, price: offers.price || offers.lowPrice, url: value.url || offers.url });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'offers' || !types.includes('Product')) fromJson(child, out);
  }
}
function parsePage(html, out) {
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { fromJson(JSON.parse(match[1]), out); } catch {}
  }
  // CS-Cart product cards expose product-title links and ty-price-num values.
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const a of anchors) {
    const attrs = a[0].slice(0, a[0].indexOf('>'));
    if (!/(product-title|ty-product-title|product_name|product-name)/i.test(attrs)) continue;
    const name = plain(a[2]);
    if (name.length < 4) continue;
    const pos = a.index || 0;
    const start = Math.max(0, pos - 2200), end = Math.min(html.length, pos + 6500);
    const context = html.slice(start, end);
    const priceMatch = context.match(/(?:ty-price-num|ty-price|product-price|price-num)[^>]*>([\s\S]{1,100}?)<\//i)
      || context.match(/(?:data-price|data-ca-price)=["']([\d,.]+)["']/i);
    const price = priceNumber(priceMatch?.[1]);
    const imgMatch = context.match(/<img\b[^>]*(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>/i);
    const image = absolute(imgMatch?.[1]);
    addProduct(out, { name, price, image, url: a[1] });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const requested = Math.max(1, Math.min(240, Number(req.query?.limit) || 220));
  const items = [];
  let pagesScanned = 0;
  try {
    for (let page = 1; page <= 20 && items.length < requested; page++) {
      const response = await fetch(`${BASE}?page=${page}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IzzyPowerCatalogueImporter/1.0)', 'Accept': 'text/html' }
      });
      if (!response.ok) throw new Error(`Fouani returned HTTP ${response.status} on catalogue page ${page}`);
      const html = await response.text();
      const before = items.length;
      parsePage(html, items);
      pagesScanned++;
      if (items.length === before && page > 1) break;
    }
    if (!items.length) throw new Error('Fouani pages loaded, but no complete product records (name, price, image and product link) could be extracted. No products were imported.');
    return res.status(200).json({ source: 'Fouani Nigeria official store', count: Math.min(items.length, requested), pagesScanned, items: items.slice(0, requested) });
  } catch (error) {
    console.error('Fouani catalogue import:', error);
    return res.status(502).json({ error: error.message || 'Could not retrieve Fouani catalogue.' });
  }
};
