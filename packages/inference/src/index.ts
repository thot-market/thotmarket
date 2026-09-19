import { canonicalHash, canonicalJson, parseMoney } from '../../protocol/src/index.ts';
import { DomainError, ensure, type Document } from '../../storage/src/index.ts';

/** Operator-reviewed token-only tariff, not a live quote or an invoice. Prices are micro-USD / million tokens. */
export interface InferenceRateCard {
  version: string; model: string; service_tier: 'default'; currency: 'USD';
  input_micro_usd_per_million: string; cached_micro_usd_per_million: string;
  cache_write_micro_usd_per_million: string | null; output_micro_usd_per_million: string;
  max_input_tokens: number; max_output_tokens: number; verified_at: string; expires_at: string;
  verified: true; example_only: false;
}
export interface InferenceResult {
  provider_response_id: string; status: 'COMPLETED' | 'INCOMPLETE'; text: string;
  usage: { input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number; total_tokens: number };
  actual_minor: string;
}
export interface InferenceProvider {
  readonly provider: string; readonly rateCard: InferenceRateCard;
  validate(): void;
  count(prompt:string,requestId:string): Promise<number>;
  generate(prompt:string,requestId:string): Promise<InferenceResult>;
}
const integer=(v:unknown,max=1_000_000)=>{ensure(Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max,'INVALID_PROVIDER_USAGE');return Number(v);};
const price=(v:unknown)=>{const n=parseMoney(v);ensure(n>0n&&n<=1_000_000_000_000n,'INVALID_INFERENCE_RATE');return n;};
export function validateRateCard(card:InferenceRateCard,now=new Date()) {
  const fields=['version','model','service_tier','currency','input_micro_usd_per_million','cached_micro_usd_per_million','cache_write_micro_usd_per_million','output_micro_usd_per_million','max_input_tokens','max_output_tokens','verified_at','expires_at','verified','example_only'];
  ensure(card&&Object.keys(card).length===fields.length&&Object.keys(card).every(k=>fields.includes(k)),'INVALID_RATE_CARD');
  ensure(card.verified===true&&card.example_only===false&&card.currency==='USD'&&card.service_tier==='default','UNVERIFIED_RATE_CARD');
  ensure(typeof card.model==='string'&&/^[a-zA-Z0-9._-]{1,120}$/.test(card.model)&&typeof card.version==='string'&&/^[a-zA-Z0-9._/-]{1,120}$/.test(card.version),'INVALID_RATE_CARD');
  price(card.input_micro_usd_per_million);price(card.cached_micro_usd_per_million);price(card.output_micro_usd_per_million);
  if(card.cache_write_micro_usd_per_million!==null)price(card.cache_write_micro_usd_per_million);
  ensure(integer(card.max_input_tokens,100_000)>0&&integer(card.max_output_tokens,16_384)>=16,'INVALID_INFERENCE_LIMIT');
  const verified=Date.parse(card.verified_at),expiry=Date.parse(card.expires_at);
  ensure(Number.isFinite(verified)&&Number.isFinite(expiry)&&verified<=now.getTime()&&expiry>now.getTime()&&expiry>verified&&expiry-verified<=7*86400000,'RATE_CARD_EXPIRED_OR_INVALID');
}
/** Round once to the existing ledger's USD cent precision; the fractional numerator is not a float. */
export function ceilTokenCostMinor(numerator:bigint):string {return ((numerator+9_999_999_999n)/10_000_000_000n).toString();}
export function maximumReservation(card:InferenceRateCard):string {
  const rates=[price(card.input_micro_usd_per_million),price(card.cached_micro_usd_per_million),...(card.cache_write_micro_usd_per_million===null?[]:[price(card.cache_write_micro_usd_per_million)])];
  const worst=rates.reduce((a,b)=>a>b?a:b);
  return ceilTokenCostMinor(BigInt(card.max_input_tokens)*worst+BigInt(card.max_output_tokens)*price(card.output_micro_usd_per_million));
}
export function meterResponse(value:Document,card:InferenceRateCard):InferenceResult {
  ensure(value?.model===card.model&&value.service_tier===card.service_tier,'INFERENCE_MODEL_OR_TIER_MISMATCH');
  ensure(['completed','incomplete'].includes(value.status)&&typeof value.id==='string'&&/^resp_[A-Za-z0-9_-]{1,200}$/.test(value.id),'INFERENCE_RESULT_UNCERTAIN');
  const usage=value.usage;ensure(usage&&usage.input_tokens_details,'MISSING_PROVIDER_USAGE');
  const input=integer(usage.input_tokens),output=integer(usage.output_tokens),total=integer(usage.total_tokens,2_000_000);
  const cached=integer(usage.input_tokens_details.cached_tokens);
  if(card.cache_write_micro_usd_per_million!==null)ensure(usage.input_tokens_details.cache_write_tokens!==undefined,'MISSING_CACHE_WRITE_USAGE');
  const written=integer(usage.input_tokens_details.cache_write_tokens??0);
  ensure(card.cache_write_micro_usd_per_million!==null||written===0,'UNPRICED_CACHE_WRITES');
  ensure(input===total-output&&cached+written<=input&&input<=card.max_input_tokens&&output<=card.max_output_tokens,'INFERENCE_USAGE_EXCEEDS_LIMIT');
  ensure(Array.isArray(value.output)&&value.output.length<=100,'INVALID_INFERENCE_OUTPUT');
  const text:string[]=[];
  for(const item of value.output) {
    if(item?.type==='reasoning')continue; // Never expose/store reasoning payloads from the provider.
    ensure(item?.type==='message'&&item.role==='assistant'&&Array.isArray(item.content),'UNEXPECTED_INFERENCE_TOOL_OUTPUT');
    for(const part of item.content) {
      ensure(['output_text','refusal'].includes(part?.type),'INVALID_INFERENCE_OUTPUT');
      const content=part.type==='refusal'?part.refusal:part.text;
      ensure(typeof content==='string','INVALID_INFERENCE_OUTPUT');text.push(content);
    }
  }
  const outputText=text.join('\n');ensure(Buffer.byteLength(outputText)<=500_000,'INFERENCE_OUTPUT_TOO_LARGE');
  const numerator=BigInt(input-cached-written)*price(card.input_micro_usd_per_million)+BigInt(cached)*price(card.cached_micro_usd_per_million)+BigInt(written)*(card.cache_write_micro_usd_per_million===null?0n:price(card.cache_write_micro_usd_per_million))+BigInt(output)*price(card.output_micro_usd_per_million);
  return {provider_response_id:value.id,status:value.status==='completed'?'COMPLETED':'INCOMPLETE',text:outputText,
    usage:{input_tokens:input,cached_tokens:cached,cache_write_tokens:written,output_tokens:output,total_tokens:total},actual_minor:ceilTokenCostMinor(numerator)};
}

/** No endpoint override, redirects, tools, stored conversation, SDK retries, or caller-supplied headers. */
export class OpenAIResponsesProvider implements InferenceProvider {
  readonly provider='openai';readonly rateCard:InferenceRateCard;
  private key:string;private transport:typeof fetch;private clock:()=>Date;
  constructor(config:{apiKey:string;rateCard:InferenceRateCard;clock?:()=>Date},transport:typeof fetch=fetch) {
    ensure(typeof config.apiKey==='string'&&config.apiKey.length>=8&&!/[\r\n]/.test(config.apiKey),'INFERENCE_API_KEY_REQUIRED');
    this.key=config.apiKey;this.rateCard=Object.freeze(structuredClone(config.rateCard));this.clock=config.clock??(()=>new Date());this.transport=transport;this.validate();
  }
  validate(){validateRateCard(this.rateCard,this.clock());}
  private async request(path:'responses'|'responses/input_tokens',body:Document,requestId:string):Promise<Document> {
    this.validate();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20_000);
    try {
      const response=await this.transport('https://api.openai.com/v1/'+path,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json','X-Client-Request-Id':canonicalHash({requestId,path})},body:canonicalJson(body)});
      if(!response.ok){await response.body?.cancel();throw new DomainError('INFERENCE_PROVIDER_HTTP_ERROR',502);}
      if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body){await response.body?.cancel();throw new DomainError('INVALID_INFERENCE_RESPONSE',502);}
      const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;ensure(size<=1_000_000,'INFERENCE_OUTPUT_TOO_LARGE');chunks.push(value);}}
      finally{await reader.cancel();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(error){
      // No raw HTTP errors, response bodies or credentials escape into logs/audit records.
      if(error instanceof DomainError)throw error;
      throw new DomainError('INFERENCE_TRANSPORT_UNCERTAIN',502);
    } finally{clearTimeout(timer);}
  }
  async count(prompt:string,requestId:string):Promise<number>{
    const response=await this.request('responses/input_tokens',{model:this.rateCard.model,input:prompt},requestId);
    ensure(response.object==='response.input_tokens','INVALID_INPUT_TOKEN_COUNT');
    const count=integer(response.input_tokens);ensure(count<=this.rateCard.max_input_tokens,'INFERENCE_INPUT_TOO_LARGE');return count;
  }
  async generate(prompt:string,requestId:string):Promise<InferenceResult>{
    return meterResponse(await this.request('responses',{model:this.rateCard.model,input:prompt,max_output_tokens:this.rateCard.max_output_tokens,
      service_tier:'default',store:false,stream:false,background:false,tools:[],tool_choice:'none'},requestId),this.rateCard);
  }
}

/** OpenAI-compatible chat completions (Z.ai, OpenRouter, ...). No token pre-count endpoint exists, so the
 *  reservation bound is bytes: a UTF-8 BPE token is at least one byte, so byte length is an upper bound on tokens. */
export function meterChatResponse(value:Document,card:InferenceRateCard):InferenceResult {
  ensure(value?.model===card.model,'INFERENCE_MODEL_OR_TIER_MISMATCH');
  ensure(typeof value.id==='string'&&/^[A-Za-z0-9_:.-]{1,200}$/.test(value.id),'INFERENCE_RESULT_UNCERTAIN');
  ensure(card.cache_write_micro_usd_per_million===null,'UNPRICED_CACHE_WRITES');
  const usage=value.usage;ensure(usage,'MISSING_PROVIDER_USAGE');
  const input=integer(usage.prompt_tokens),output=integer(usage.completion_tokens),total=integer(usage.total_tokens,2_000_000);
  // Cached tokens are a discount; a provider that reports none is billed at the full input rate.
  const cached=integer(usage.prompt_tokens_details?.cached_tokens??0);
  ensure(input===total-output&&cached<=input&&input<=card.max_input_tokens&&output<=card.max_output_tokens,'INFERENCE_USAGE_EXCEEDS_LIMIT');
  ensure(Array.isArray(value.choices)&&value.choices.length===1,'INVALID_INFERENCE_OUTPUT');
  const choice=value.choices[0];ensure(choice?.message?.role==='assistant'&&typeof choice.message.content==='string'&&!choice.message.tool_calls,'UNEXPECTED_INFERENCE_TOOL_OUTPUT');
  ensure(['stop','length'].includes(choice.finish_reason),'INFERENCE_RESULT_UNCERTAIN');
  const text=choice.message.content;ensure(Buffer.byteLength(text)<=500_000,'INFERENCE_OUTPUT_TOO_LARGE');
  const numerator=BigInt(input-cached)*price(card.input_micro_usd_per_million)+BigInt(cached)*price(card.cached_micro_usd_per_million)+BigInt(output)*price(card.output_micro_usd_per_million);
  return {provider_response_id:value.id,status:choice.finish_reason==='stop'?'COMPLETED':'INCOMPLETE',text,
    usage:{input_tokens:input,cached_tokens:cached,cache_write_tokens:0,output_tokens:output,total_tokens:total},actual_minor:ceilTokenCostMinor(numerator)};
}
export class OpenAIChatProvider implements InferenceProvider {
  readonly provider:string;readonly rateCard:InferenceRateCard;
  private key:string;private base:string;private transport:typeof fetch;private clock:()=>Date;
  constructor(config:{apiKey:string;baseUrl:string;rateCard:InferenceRateCard;clock?:()=>Date},transport:typeof fetch=fetch) {
    ensure(typeof config.apiKey==='string'&&config.apiKey.length>=8&&!/[\r\n]/.test(config.apiKey),'INFERENCE_API_KEY_REQUIRED');
    const url=new URL(config.baseUrl);ensure(url.protocol==='https:'&&!url.search&&!url.hash&&!url.username,'INVALID_INFERENCE_BASE_URL');
    this.base=config.baseUrl.replace(/\/+$/,'');this.provider=url.host;
    this.key=config.apiKey;this.rateCard=Object.freeze(structuredClone(config.rateCard));this.clock=config.clock??(()=>new Date());this.transport=transport;this.validate();
  }
  validate(){validateRateCard(this.rateCard,this.clock());}
  async count(prompt:string,_requestId:string):Promise<number>{
    const bound=Buffer.byteLength(prompt);ensure(bound<=this.rateCard.max_input_tokens,'INFERENCE_INPUT_TOO_LARGE');return bound;
  }
  async generate(prompt:string,requestId:string):Promise<InferenceResult>{
    this.validate();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60_000);
    try {
      const body={model:this.rateCard.model,messages:[{role:'user',content:prompt}],max_tokens:this.rateCard.max_output_tokens,stream:false};
      const response=await this.transport(this.base+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json','X-Client-Request-Id':canonicalHash({requestId,path:'chat/completions'})},body:canonicalJson(body)});
      if(!response.ok){await response.body?.cancel();throw new DomainError('INFERENCE_PROVIDER_HTTP_ERROR',502);}
      if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body){await response.body?.cancel();throw new DomainError('INVALID_INFERENCE_RESPONSE',502);}
      const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;ensure(size<=1_000_000,'INFERENCE_OUTPUT_TOO_LARGE');chunks.push(value);}}
      finally{await reader.cancel();}
      return meterChatResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')),this.rateCard);
    } catch(error){
      if(error instanceof DomainError)throw error;
      throw new DomainError('INFERENCE_TRANSPORT_UNCERTAIN',502);
    } finally{clearTimeout(timer);}
  }
}
