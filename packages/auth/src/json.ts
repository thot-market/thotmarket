import { ensure } from '../../storage/src/index.ts';

/** Reject duplicate decoded member names, invalid UTF-8 and excessive depth before trust decisions. */
export function strictJson(bytes: Uint8Array | string, maximumBytes = 16384): any {
  ensure(Buffer.byteLength(bytes) <= maximumBytes, 'AUTH_INPUT_TOO_LARGE', 401);
  let text: string;
  try { text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { ensure(false, 'INVALID_AUTH_JSON', 401); }
  let pos = 0, members = 0;
  const whitespace = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos]!)) pos++; };
  const string = () => {
    const start = pos++; let closed = false;
    while (pos < text.length) { const ch = text[pos++]!; if (ch === '\\') pos++; else if (ch === '"') { closed = true; break; } }
    ensure(closed, 'INVALID_AUTH_JSON', 401);
    try { return JSON.parse(text.slice(start, pos)) as string; } catch { ensure(false, 'INVALID_AUTH_JSON', 401); }
  };
  const value = (depth: number): any => {
    ensure(depth <= 12 && ++members <= 12000, 'INVALID_AUTH_JSON', 401); whitespace();
    const ch = text[pos];
    if (ch === '"') return string();
    if (ch === '{' || ch === '[') {
      const object = ch === '{', result: any = object ? {} : [], names = new Set<string>(); pos++; whitespace();
      const end = object ? '}' : ']'; if (text[pos] === end) { pos++; return result; }
      while (true) {
        whitespace(); let name: string | undefined;
        if (object) { ensure(text[pos] === '"', 'INVALID_AUTH_JSON', 401); name = string(); ensure(!names.has(name), 'DUPLICATE_AUTH_FIELD', 401); names.add(name); whitespace(); ensure(text[pos++] === ':', 'INVALID_AUTH_JSON', 401); }
        const item = value(depth + 1);
        if (object) Object.defineProperty(result, name!, { value: item, enumerable: true, configurable: true, writable: true }); else result.push(item);
        whitespace(); const separator = text[pos++]; if (separator === end) return result;
        ensure(separator === ',', 'INVALID_AUTH_JSON', 401);
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    ensure(match, 'INVALID_AUTH_JSON', 401); pos += match[0].length;
    const primitive = JSON.parse(match[0]); ensure(typeof primitive !== 'number' || Number.isFinite(primitive), 'INVALID_AUTH_JSON', 401); return primitive;
  };
  const parsed = value(0); whitespace(); ensure(pos === text.length, 'INVALID_AUTH_JSON', 401); return parsed;
}
