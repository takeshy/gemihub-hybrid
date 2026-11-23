// The directory filter is independent of chat search conditions and reservation state.
export const directoryGenres = shops => [...new Set(shops.map(s=>s.cuisine).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'en'));
export const filterDirectory = (shops, genre) => shops.filter(s=>!genre||s.cuisine===genre);
export const shopMapQuery = shop => typeof shop?.address==='string' && shop.address.trim() ? shop.address.trim() : '';
export const mapEmbedUrl = query => `https://maps.google.com/maps?q=${encodeURIComponent(query)}&hl=en&z=16&output=embed`;
export const mapOpenUrl = query => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
export function mountShopDirectory({shops,cards}) {
 const genre=document.getElementById('shop-genre'),select=document.getElementById('shop-map-select'),frame=document.getElementById('shop-map-frame'),link=document.getElementById('shop-map-open'),message=document.getElementById('shop-map-status'),count=document.getElementById('shop-visible-count');
 if(!genre||!select||!frame||!link||!message||!count)return;
 const option=(value,label)=>{const n=document.createElement('option');n.value=value;n.textContent=label;return n;};
 genre.replaceChildren(option('','All categories'),...directoryGenres(shops).map(g=>option(g,g)));
 const mapButtons=new Map();
 function showMap(id){
  const shop=filterDirectory(shops,genre.value).find(s=>s.id===id),query=shopMapQuery(shop);select.value=shop?.id||'';
  for(const [key,button]of mapButtons)button.setAttribute('aria-pressed',String(key===id&&!!query));
  if(!query){frame.hidden=true;frame.removeAttribute('src');link.hidden=true;link.removeAttribute('href');message.textContent=shop?'See the shop’s website for its address.':'Select a shop to see it on the map.';return;}
  frame.title=`Map of ${shop.name}`;frame.src=mapEmbedUrl(query);frame.hidden=false;link.href=mapOpenUrl(query);link.hidden=false;message.textContent=`${shop.name} · ${query}`;
 }
 for(const shop of shops){
  const card=cards.get(shop.id);if(!card)continue;card.dataset.shopId=shop.id;
  if(shopMapQuery(shop)){
   const address=document.createElement('p');address.className='muted shop-address';address.textContent=shop.address;card.append(address);
   const button=document.createElement('button');button.type='button';button.className='shop-map-button';button.textContent='Show on map';button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>{showMap(shop.id);document.getElementById('shop-directory-map').scrollIntoView({behavior:'smooth',block:'nearest'});});card.append(button);mapButtons.set(shop.id,button);
  }
 }
 function filter(){
  const visible=filterDirectory(shops,genre.value),previous=select.value;
  for(const shop of shops){const card=cards.get(shop.id);if(card)card.hidden=!visible.some(s=>s.id===shop.id);}
  count.textContent=`${visible.length} ${visible.length === 1 ? "shop" : "shops"}`;select.replaceChildren(option('','Select a shop'),...visible.map(s=>option(s.id,s.name)));select.disabled=!visible.length;
  const keep=visible.find(s=>s.id===previous),first=visible.find(s=>shopMapQuery(s));showMap(keep?.id||first?.id||'');
 }
 genre.addEventListener('change',filter);select.addEventListener('change',()=>showMap(select.value));filter();
}
