// Reads public product listings from Fouani's live catalogue.
// The admin browser is responsible for writing approved records to Firestore.
const BASES = [
  'https://fouanistore.com/nigeria-en/search',
  'https://fouanistore.com/nigeria-en/shop'
];
function decodeHtml(value='') {
  return String(value).replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function plain(html='') {
  return decodeHtml(String(html).replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')).trim();
}
function absolute(url) {
  if(!url||/^(data:|javascript:|#)/i.test(url))return '';
  try{return new URL(url,'https://fouanistore.com').href}catch{return ''}
}
function priceNumber(value) {
  const n=Number(String(value||'').replace(/[^\d.]/g,''));
  return Number.isFinite(n)&&n>0?n:0;
}
function addProduct(out,p) {
  const name=plain(p.name||p.title||'');
  const image=absolute(Array.isArray(p.image)?(typeof p.image[0]==='string'?p.image[0]:p.image[0]?.url):(typeof p.image==='object'?p.image?.url:p.image));
  const price=priceNumber(p.price||p.offers?.price||p.offers?.lowPrice||p.amount);
  const url=absolute(p.url||p.productUrl||p.offers?.url);
  if(!name||name.length<4||!image||!price||!url)return;
  if(/add to cart|view details|sold out|quick view/i.test(name))return;
  const key=url.split('?')[0].toLowerCase();
  if(out.some(x=>x.sourceUrl.split('?')[0].toLowerCase()===key||x.name.toLowerCase()===name.toLowerCase()))return;
  out.push({name,image,price,sourceUrl:url,sourceStore:'Fouani'});
}
function fromJson(value,out) {
  if(!value)return;
  if(Array.isArray(value)){for(const x of value)fromJson(x,out);return}
  if(typeof value!=='object')return;
  const types=Array.isArray(value['@type'])?value['@type']:[value['@type']];
  if(types.some(t=>String(t).toLowerCase()==='product')){
    const offers=Array.isArray(value.offers)?value.offers[0]:(value.offers||{});
    addProduct(out,{name:value.name,image:value.image,price:offers.price||offers.lowPrice,url:value.url||offers.url});
  }
  for(const child of Object.values(value))if(child&&typeof child==='object')fromJson(child,out);
}
function attr(tag,name) {
  const re=new RegExp("(?:^|\\s)"+name+"\\s*=\\s*([\"'])(.*?)\\1","i");
  return tag.match(re)?.[2]||'';
}
function nearestImage(context) {
  const matches=[...context.matchAll(/<img\b[^>]*>/gi)];
  const usable=matches.map(m=>({at:m.index,tag:m[0],url:attr(m[0],'data-src')||attr(m[0],'data-lazy-src')||attr(m[0],'data-original')||attr(m[0],'src')||attr(m[0],'srcset').split(',')[0].trim().split(/\s+/)[0]})).filter(x=>x.url&&!/placeholder|blank\./i.test(x.url));
  return usable.sort((a,b)=>a.at-b.at)[0]?.url||'';
}
function nearestPrice(context) {
  const patterns=[
    /(?:ty-price-num|ty-price|price-num|product-price)[^>]*>([\s\S]{1,140}?)<\//gi,
    /(?:NGN|₦|&#8358;|&#x20a6;)\s*[\d,]+(?:\.\d{1,2})?/gi,
    /(?:data-price|data-ca-price)\s*=\s*["']([\d,.]+)["']/gi
  ];
  const found=[];
  for(const re of patterns)for(const m of context.matchAll(re))found.push({at:m.index,value:m[1]||m[0]});
  found.sort((a,b)=>a.at-b.at);
  for(const x of found){const p=priceNumber(plain(x.value));if(p)return p}
  return 0;
}
function parsePage(html,out) {
  for(const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{fromJson(JSON.parse(m[1]),out)}catch{}
  }
  // Fouani's live shop/search cards use product links, lazy-loaded images and
  // currency text in the same card; don't depend on one theme-specific CSS class.
  const links=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for(let i=0;i<links.length;i++){
    const m=links[i],href=m[1],open=m[0].slice(0,m[0].indexOf('>'));
    // Fouani uses clean localized SEO URLs (for example /nigeria-en/<product-slug>),
    // not necessarily a /products/ path. Exclude navigation routes instead.
    if(/\/(?:shop|search|cart|checkout|account|login|register)(?:[/?#]|$)|dispatch=/i.test(href))continue;
    let name=plain(m[2])||plain(attr(open,'title'))||plain(attr(open,'aria-label'));
    if(!name||name.length<5||name.length>240)continue;
    const pos=m.index||0;
    const context=html.slice(Math.max(0,pos-3200),Math.min(html.length,pos+4200));
    const image=nearestImage(context),price=nearestPrice(context);
    // Only treat it as a product if the surrounding card actually contains
    // both a product image and a numeric price; this excludes menus and banners.
    if(!image||!price)continue;
    addProduct(out,{name,image,price,url:href});
  }
}
module.exports=async function handler(req,res) {
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=900');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const requested=Math.max(1,Math.min(240,Number(req.query?.limit)||220));
  const items=[];let pagesScanned=0;const errors=[];let htmlBytes=0,productLinksSeen=0;
  try{
    // Search contains the full Fouani catalogue (currently 821 listings).
    // Try search pagination first, then shop pagination as a fallback.
    for(const base of BASES){
      let emptyPages=0;
      for(let page=1;page<=20&&items.length<requested;page++){
        const url=base+'?page='+page;
        const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; IzzyPowerCatalogueImporter/1.0)','Accept':'text/html,application/xhtml+xml'}});
        if(!response.ok){errors.push('HTTP '+response.status+' at '+url);break}
        const html=await response.text(),before=items.length;htmlBytes+=html.length;productLinksSeen+=([...html.matchAll(/<a\b[^>]*href=/gi)]).length;
        parsePage(html,items);pagesScanned++;
        if(items.length===before)emptyPages++;else emptyPages=0;
        if(emptyPages>=2)break;
      }
      if(items.length>=requested)break;
    }
    if(!items.length)throw new Error('Fouani pages were reached, but the importer could not recognise product links, prices and images in the returned page markup. No products were saved. The importer now checks the full search catalogue as well as the shop pages. Diagnostic: pagesScanned+" pages, "+htmlBytes+" HTML characters, "+productLinksSeen+" links inspected."');
    return res.status(200).json({source:'Fouani Nigeria official catalogue',count:Math.min(items.length,requested),pagesScanned,items:items.slice(0,requested)});
  }catch(error){
    console.error('Fouani catalogue import:',error);
    return res.status(502).json({error:error.message||'Could not retrieve Fouani catalogue.',pagesScanned,diagnostics:errors.slice(0,5)});
  }
};
