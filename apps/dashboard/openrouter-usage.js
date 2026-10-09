const LIMIT=50;
const COST_PLACES=8;
const statuses={COMPLETED:'Completed',INFLIGHT:'In progress',INTERRUPTED:'Interrupted',FAILED:'Failed'};
const tokenValue=value=>Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
const group=value=>value.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');

// Sum the provider's decimal reports without binary floating-point addition.
// The source values are already JSON numbers; this cannot recover provider
// precision that was lost before they reached the relay.
function costValue(value){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)return null;
  const [mantissa,exponent='0']=value.toString().toLowerCase().split('e');
  const [whole,fraction='']=mantissa.split('.');
  const scale=fraction.length-Number(exponent);
  return scale<0?{units:BigInt(whole+fraction)*10n**BigInt(-scale),scale:0}:{units:BigInt(whole+fraction),scale};
}
function sumCosts(values){
  const scale=Math.max(...values.map(value=>value.scale));
  return {scale,units:values.reduce((total,value)=>total+value.units*10n**BigInt(scale-value.scale),0n)};
}
function formatCost(value){
  if(value===null)return 'Not reported';
  if(value.units===0n)return '$0.00';
  const divisor=value.scale>COST_PLACES?10n**BigInt(value.scale-COST_PLACES):1n;
  if(value.units<divisor)return '<$0.00000001';
  const rounded=value.scale>COST_PLACES?(value.units+divisor/2n)/divisor:value.units*10n**BigInt(COST_PLACES-value.scale);
  const digits=rounded.toString().padStart(COST_PLACES+1,'0');
  const fraction=digits.slice(-COST_PLACES).replace(/0+$/,'').padEnd(2,'0');
  return '$'+group(digits.slice(0,-COST_PLACES))+'.'+fraction;
}
function summarize(rows,field,read){
  const values=rows.map(row=>read(row.usage?.[field])).filter(value=>value!==null);
  return {known:values.length,value:values.length?(field==='cost'?sumCosts(values):values.reduce((sum,value)=>sum+value,0n)):null};
}
function text(value,fallback){return typeof value==='string'&&value.trim()?value.slice(0,200):fallback;}
function requestDate(value){
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return 'Time not reported';
  return new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
}

/** Read-only presentation of the owner-scoped relay status response. */
export function renderOpenRouterUsage(requests,escape){
  const rows=(Array.isArray(requests)?requests:[]).slice(0,LIMIT).map(row=>row&&typeof row==='object'?row:{});
  const input=summarize(rows,'prompt_tokens',tokenValue),output=summarize(rows,'completion_tokens',tokenValue),cost=summarize(rows,'cost',costValue);
  const metric=(label,value,extra='',missing=false)=>`<div class="usage-metric${missing?' usage-missing':''}"><span class="usage-label">${escape(label)}</span><strong>${escape(value)}</strong>${extra}</div>`;
  const coverage=summary=>`<small class="usage-coverage">${summary.known} of ${rows.length} requests reported${summary.known<rows.length?' · partial coverage':''}</small>`;
  const tokenText=value=>value===null?'Not reported':group(value);
  const cards=rows.map(row=>{
    const requested=text(row.requested_model,text(row.model,'Not reported')),returned=text(row.returned_model,null);
    const status=Object.hasOwn(statuses,row.status)?statuses[row.status]:'Status not reported';
    const input=tokenValue(row.usage?.prompt_tokens),output=tokenValue(row.usage?.completion_tokens),cost=costValue(row.usage?.cost);
    return `<article class="usage-request"><div class="usage-request-head"><div class="usage-request-model"><h3>${escape(returned??requested)}</h3><p>${escape(requestDate(row.created_at))}</p><small>Requested: ${escape(requested)}${row.provider_name?` · Provider: ${escape(text(row.provider_name,'Not reported'))}`:''}</small>${!returned?'<small>Returned model not reported</small>':''}</div><span class="usage-status">${escape(status)}</span></div><div class="usage-values">${metric('Input tokens',tokenText(input),'',input===null)}${metric('Output tokens',tokenText(output),'',output===null)}${metric('Reported cost',formatCost(cost),'',cost===null)}</div>${row.status!=='COMPLETED'?'<p class="usage-missing">Incomplete requests can still incur an OpenRouter charge. Missing values do not mean zero.</p>':''}</article>`;
  }).join('');
  return `<section class="openrouter-usage"><p class="usage-scope">OpenRouter bills your OpenRouter account. THOT does not debit you for these model calls.</p><div class="usage-summary">${metric('Reported cost (USD)',formatCost(cost.value),coverage(cost),cost.value===null)}${metric('Input tokens',tokenText(input.value),coverage(input),input.value===null)}${metric('Output tokens',tokenText(output.value),coverage(output),output.value===null)}${metric('Recent requests',group(rows.length),'<small class="usage-coverage">In your relay history</small>')}</div><details class="usage-notes"><summary>About these totals</summary><p class="usage-scope">This view covers up to 50 recent requests sent through THOT, including incomplete requests. Sums include only valid reported values; missing values remain unknown. These provider reports are not your complete OpenRouter account bill and exclude calls made elsewhere. Costs are reported in USD and displayed with up to 8 decimal places.</p></details>${rows.length?`<div class="usage-request-list">${cards}</div>`:'<p class="usage-empty">No relay requests recorded yet. Usage will appear after you send a model request through your THOT endpoint.</p>'}</section>`;
}
