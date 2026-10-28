const DAY = 86400000;
const number = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const fmt = n => n.toLocaleString('en-US');
const date = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const files = item => item.content_kind === 'research';
const source = item => { const raw=item.capture_model?.source; return ({'codex-jsonl':'Codex','claude-code-jsonl':'Claude Code','zai':'Z.AI','openrouter':'OpenRouter'})[raw] || raw || (files(item) ? 'Files & datasets' : 'Imported'); };
const model = item => item.capture_model?.returned_model || item.capture_model?.requested_model || item.capture_model?.claimed_model || 'Not recorded';
const thot = atoms => {
  if (!/^\d{1,78}$/.test(String(atoms))) return '—';
  const n = BigInt(atoms), unit = 10n ** 18n;
  const fraction = String(n % unit).padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return fmt(n / unit) + (fraction ? '.' + fraction : '');
};

// Reconstruct the current catalogue, never a claim about historical net supply.
export function catalogueTimeline(items, asOf, metric = 'listings') {
  const end = Math.floor(Date.parse(asOf) / DAY) * DAY;
  if (!Number.isFinite(end)) return [];
  const dated = items.map(item => ({ time: Date.parse(item.created_at), amount: metric === 'turns' ? number(item.turn_count) : 1 }))
    .filter(item => Number.isFinite(item.time) && item.time <= Date.parse(asOf));
  if (!dated.length) return [];
  const start = Math.max(Math.min(...dated.map(item => Math.floor(item.time / DAY) * DAY)), end - 365 * DAY);
  const points = [];
  let total = dated.filter(item => item.time < start).reduce((sum, item) => sum + item.amount, 0);
  for (let day = start; day <= end; day += DAY) {
    total += dated.filter(item => item.time >= day && item.time < day + DAY).reduce((sum, item) => sum + item.amount, 0);
    points.push({ day: new Date(day).toISOString(), value: total });
  }
  return points;
}

export function catalogueSummary(items, asOf) {
  const end = Date.parse(asOf);
  return { turns: items.reduce((sum, item) => sum + number(item.turn_count), 0),
    knownTurns: items.filter(item => Number.isSafeInteger(item.turn_count) && item.turn_count >= 0).length,
    week: items.filter(item => Date.parse(item.created_at) > end - 7 * DAY && Date.parse(item.created_at) <= end).length,
    sources: Object.entries(items.reduce((counts, item) => { const key = source(item); counts[key] = (counts[key] || 0) + 1; return counts; }, Object.create(null))).sort((a, b) => b[1] - a[1]) };
}

function start() {
  const $ = selector => document.querySelector(selector);
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  let payload, filter = 'all', measure = 'listings', loading = false;
  const put = (key, value) => { $(`[data-stat="${key}"]`).textContent = value; };
  function drawChart() {
    const container = $('[data-chart-container]');
    const points = catalogueTimeline(payload.listings, payload.as_of, measure);
    if (!points.length) { container.replaceChildren(el('p', 'No dated public listings yet.', 'market-placeholder')); $('[data-chart-range]').textContent = '—'; return; }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const width=Math.max(300,Math.min(720,container.clientWidth-24));
    svg.setAttribute('viewBox', `0 0 ${width} 220`); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Today's catalogue by listing date: ${points.at(-1).value} ${measure}. Removed listings excluded.`);
    function shape(tag, attrs, text) { const n = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value)); if (text !== undefined) n.textContent = text; svg.append(n); return n; }
    const max = Math.max(1, ...points.map(p => p.value)), left = 36, right = width-16, top = 20, bottom = 184;
    const x = i => points.length === 1 ? right : left + i / (points.length - 1) * (right - left);
    const y = value => bottom - value / max * (bottom - top);
    for (let i = 0; i <= 4; i++) { const value = max * i / 4, height = y(value); shape('line', {x1:left,y1:height,x2:right,y2:height,stroke:'#e1e5d4','stroke-dasharray':'3 5'}); shape('text',{x:left-8,y:height+4,'text-anchor':'end'},String(Math.round(value))); }
    const path = points.length===1 ? `M${left} ${y(points[0].value)} H${right}` : points.map((p, i) => `${i ? 'H' + x(i) + ' V' : 'M' + x(i) + ' '}${y(p.value)}`).join(' ');
    // A stepped curve preserves actual observation dates and flat periods.
    shape('path',{d:`${path} L${right} ${bottom} L${left} ${bottom} Z`,fill:'#d7e4a4','fill-opacity':'.45'});
    shape('path',{d:path,fill:'none',stroke:'#527136','stroke-width':2.5,'stroke-linejoin':'round'});
    shape('circle',{cx:right,cy:y(points.at(-1).value),r:4,fill:'#527136',stroke:'#fffdf3','stroke-width':2});
    for (const i of [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]) shape('text',{x:x(i),y:210,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'},date(points[i].day));
    container.replaceChildren(svg);
    $('[data-chart-range]').textContent = `${date(points[0].day)} – ${date(points.at(-1).day)} · UTC`;
  }
  function drawTable() {
    if (!payload) return;
    const query = $('[data-search]').value.trim().toLowerCase();
    const items = payload.listings.filter(item => (filter === 'all' || (filter === 'files') === files(item)) && `${item.title} ${source(item)} ${model(item)}`.toLowerCase().includes(query));
    const sort = $('[data-sort]').value;
    items.sort((a,b) => sort === 'turns' ? number(b.turn_count)-number(a.turn_count) : sort === 'price' ? (BigInt(a.price_atoms || '0') < BigInt(b.price_atoms || '0') ? -1 : BigInt(a.price_atoms || '0') > BigInt(b.price_atoms || '0') ? 1 : 0) : (Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0));
    $('[data-results-count]').textContent = fmt(items.length);
    const rows = items.map(item => {
      const tr = el('tr'), title = el('td'), link = el('a', item.title || 'Untitled listing');
      link.href = /^\/l\/[A-Za-z0-9_-]{1,80}$/.test(item.public_path) ? 'https://app.thot.market' + item.public_path : 'https://app.thot.market/app#thot-available';
      title.append(link); const subtitle = el('small'); subtitle.append(el('span', files(item) ? 'DATASET' : 'TRACE', 'market-type'), document.createTextNode((item.workflow || 'research').replaceAll('_',' '))); title.append(subtitle);
      const origin = el('td', source(item)); origin.append(el('small', model(item)));
      const size = el('td', files(item) ? `${fmt(number(item.file_count))} files` : Number.isSafeInteger(item.turn_count) ? `${fmt(number(item.turn_count))} turns` : 'Not recorded');
      const when = el('td', Number.isFinite(Date.parse(item.created_at)) ? date(item.created_at) : '—');
      const price = el('td', thot(item.price_atoms));price.append(el('small','THOT'));
      const action = el('td'), open = el('a','↗');open.href=link.href;open.setAttribute('aria-label',`View ${item.title || 'listing'}`);action.append(open);
      tr.append(title,origin,size,when,price,action);return tr;
    });
    if (!rows.length) { const tr=el('tr'),td=el('td',payload.listings.length?'No listings match. Try another search or filter.':'No public listings yet.');td.colSpan=6;tr.append(td);rows.push(tr); }
    $('[data-catalogue]').replaceChildren(...rows);
  }
  function render() {
    const stats=payload.stats, items=payload.listings, summary=catalogueSummary(items,payload.as_of), partial=items.length < stats.listings_active;
    put('listings',fmt(stats.listings_active));put('sellers',fmt(stats.sellers_listing));put('turns',fmt(summary.turns));put('week',fmt(summary.week));
    $('[data-week-scope]').textContent=partial?'Within latest displayed listings':'Still listed today · UTC';
    $('[data-turns-scope]').textContent=`${summary.knownTurns}/${items.length} displayed listings report turns`;
    $('[data-catalogue-scope]').textContent=`Showing ${items.length} of ${stats.listings_active} active listings${partial?' · latest 48 maximum':''}`;
    $('[data-chart-subtitle]').textContent=`${partial?'Latest displayed listings':'Current listings'}, grouped by original listing date`;
    $('[data-sources]').replaceChildren(...summary.sources.map(([name,count])=>{const div=el('div',undefined,'market-source-item');div.append(el('span',name),el('strong',`${count} listings`));const bar=el('progress');bar.max=items.length;bar.value=count;bar.setAttribute('aria-label',`${name}: ${count} listings`);div.append(bar);return div;}));
    if(!items.length)$('[data-sources]').append(el('p','No public sources yet.','market-placeholder'));
    if(stats.independent){put('purchases',fmt(stats.independent.purchases));put('paid',thot(stats.independent.paid_to_sellers_atoms));$('[data-sales]').hidden=false;}else $('[data-sales]').hidden=true;
    drawChart();drawTable();
  }
  async function load() {
    if(loading)return;loading=true;$('[data-refresh]').disabled=true;
    try {
      const response=await fetch('/v1/public/catalogue',{credentials:'omit',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Unavailable');const next=await response.json();
      if(!Array.isArray(next.listings)||!Number.isSafeInteger(next.stats?.listings_active)||!Number.isSafeInteger(next.stats?.sellers_listing)||!Number.isFinite(Date.parse(next.as_of)))throw Error('Invalid catalogue');
      payload=next;render();
      $('[data-stats-note]').textContent=`Updated ${new Date(payload.as_of).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} · public catalogue · refreshes every minute`;
    }catch{
      $('[data-stats-note]').textContent=payload?'Update unavailable. Showing the last successful snapshot.':'Market unavailable. Try refreshing.';
      if(!payload){$('[data-chart-container]').replaceChildren(el('p','Timeline unavailable','market-placeholder'));$('[data-sources]').replaceChildren(el('p','Sources unavailable','market-placeholder'));const tr=el('tr'),td=el('td','Could not load listings. Use Refresh to retry.');td.colSpan=6;tr.append(td);$('[data-catalogue]').replaceChildren(tr);}
    }finally{loading=false;$('[data-refresh]').disabled=false;}
  }
  $('[data-refresh]').addEventListener('click',load);
  $('[data-search]').addEventListener('input',drawTable);$('[data-sort]').addEventListener('change',drawTable);
  document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));drawTable();}));
  document.querySelectorAll('[data-chart]').forEach(button=>button.addEventListener('click',()=>{measure=button.dataset.chart;document.querySelectorAll('[data-chart]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(payload)drawChart();}));
  window.addEventListener('resize',()=>{if(payload)drawChart();});
  load();setInterval(()=>{if(document.visibilityState==='visible')load();},60000);
}
if(typeof document !== 'undefined')start();
