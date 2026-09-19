import { createHash } from 'node:crypto';

export type SimilaritySketch = { version:'thot.similarity/1'; tokens:number; shingles:Set<string> };
/** Private, bounded review heuristic. Never a provenance, ownership, quality or fraud verdict. */
export function similaritySketch(content: unknown): SimilaritySketch | null {
  if(!content||typeof content!=='object'||!Array.isArray((content as any).turns))return null;
  const turns=(content as any).turns;
  if(turns.length>500)return null;
  const tokens:string[]=[];let bytes=0;
  for(const turn of turns){
    if(!turn||!['user','assistant','tool','system'].includes(turn.role)||typeof turn.content!=='string')return null;
    bytes+=Buffer.byteLength(turn.content);if(bytes>100_000)return null;
    const words=turn.content.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[];
    // Explicit boundaries preserve role/turn distinctions; quoted instructions remain ordinary tokens.
    tokens.push('<'+turn.role+'>',...words,'</turn>');if(tokens.length>8000)return null;
  }
  if(tokens.length<10)return null; // Short text is too ambiguous for this advisory signal.
  const shingles=new Set<string>();
  for(let i=0;i+5<=tokens.length;i++){
    shingles.add(createHash('sha256').update(JSON.stringify(tokens.slice(i,i+5))).digest('hex'));
  }
  return {version:'thot.similarity/1',tokens:tokens.length,shingles};
}
export function similarityBasisPoints(a:SimilaritySketch,b:SimilaritySketch):number {
  let intersection=0;for(const hash of a.shingles)if(b.shingles.has(hash))intersection++;
  const union=a.shingles.size+b.shingles.size-intersection;
  return union===0?0:Math.floor(intersection*10000/union);
}
