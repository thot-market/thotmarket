// Token bill: reads Claude Code / Codex session logs in the browser and draws a shareable card. Nothing is uploaded.
// Price per million tokens [input, output, cache read]; cache writes bill at 1.25x input. First match wins.
const PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25], [/fable|mythos/, 10, 50, 1], [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-9])/, 5, 25, 0.5], [/opus/, 15, 75, 1.5], [/sonnet-5/, 2, 10, 0.2], [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01], [/haiku-4/, 1, 5, 0.1], [/haiku/, 0.8, 4, 0.08],
];
const price = model => PRICES.find(([re]) => re.test(model));
const compact = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
// Dollar totals only when most tokens have a known list price; otherwise the card would understate the bill.
export const showCost = s => s.priced >= s.tokens / 2;
const dollars = n => '$' + Math.round(n).toLocaleString('en-US');

export function createBill() {
  const seen = new Set(), models = new Map(), days = new Map(), sessions = new Set();
  const add = (model, day, t) => {
    const m = models.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const k in t) m[k] += t[k];
    models.set(model, m);
    const total = t.input + t.output + t.cacheRead + t.cacheWrite;
    if (day) days.set(day, (days.get(day) ?? 0) + total);
  };
  return {
    // One JSONL file. Claude Code repeats usage per content block, so messages are counted once by id.
    async file(lines, name) {
      let codex = null, codexModel = 'codex', codexDay = null;
      for await (const line of lines) {
        if (!line.includes('"usage"') && !line.includes('token_count') && !line.includes('"model"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const day = typeof o.timestamp === 'string' ? o.timestamp.slice(0, 10) : null;
        const u = o.message?.usage, model = o.message?.model;
        if (u && model && model !== '<synthetic>') {
          const key = o.message.id ?? o.uuid;
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          if (o.sessionId) sessions.add(o.sessionId);
          add(model, day, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
          continue;
        }
        const p = o.payload;
        if (p?.model && (o.type === 'turn_context' || o.type === 'session_meta')) codexModel = p.model;
        // Codex reports running totals for the session; the last one is the session's usage.
        if (p?.type === 'token_count' && p.info?.total_token_usage) { codex = p.info.total_token_usage; codexDay = day ?? codexDay; }
      }
      if (codex) {
        sessions.add('codex:' + name);
        const cached = codex.cached_input_tokens ?? 0;
        add(codexModel, codexDay, { input: Math.max(0, (codex.input_tokens ?? 0) - cached), output: codex.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 });
      }
    },
    summary() {
      let tokens = 0, cost = 0, priced = 0, top = null;
      for (const [model, m] of models) {
        const total = m.input + m.output + m.cacheRead + m.cacheWrite, p = price(model);
        tokens += total;
        if (p) { cost += (m.input * p[1] + m.output * p[2] + m.cacheRead * p[3] + m.cacheWrite * p[1] * 1.25) / 1e6; priced += total; }
        if (!top || total > top[1]) top = [model, total];
      }
      const sorted = [...days].sort(([a], [b]) => a < b ? -1 : 1), peak = sorted.reduce((best, d) => d[1] > (best?.[1] ?? 0) ? d : best, null);
      return { tokens, cost, priced, sessions: sessions.size, days: sorted.length, first: sorted[0]?.[0] ?? null, peak, top: top?.[0] ?? null, series: sorted.slice(-60).map(([, n]) => n) };
    },
  };
}

export function drawCard(canvas, s) {
  const c = canvas.getContext('2d'), W = canvas.width = 1200, H = canvas.height = 675;
  c.fillStyle = '#f7f4e5'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#1a3a29'; c.fillRect(0, 0, W, 10);
  const font = (size, weight = 700) => `${weight} ${size}px "Bricolage Grotesque", "DM Sans", system-ui, sans-serif`;
  c.fillStyle = '#5f6b5a'; c.font = font(30, 600); c.fillText('MY AI TOKEN BILL', 64, 92);
  c.fillStyle = '#1a3a29'; c.font = font(148, 800); c.fillText(compact(s.tokens), 56, 250);
  c.font = font(40, 600); c.fillText('tokens', 64, 304);
  c.fillStyle = '#b4532a'; c.font = font(56, 800); c.fillText(showCost(s) ? dollars(s.cost) : s.top, 64, 400);
  c.fillStyle = '#5f6b5a'; c.font = font(26, 500); c.fillText(showCost(s) ? 'at API list prices' : 'most used model', 64, 440);
  const facts = [[String(s.sessions), s.sessions === 1 ? 'session' : 'sessions'], [String(s.days), s.days === 1 ? 'active day' : 'active days'], [s.peak ? compact(s.peak[1]) : '—', 'busiest day']];
  facts.forEach(([v, label], i) => { const x = 64 + i * 230; c.fillStyle = '#1a3a29'; c.font = font(44, 800); c.fillText(v, x, 530); c.fillStyle = '#5f6b5a'; c.font = font(22, 500); c.fillText(label, x, 562); });
  // Daily usage bars, most recent 60 active days.
  const max = Math.max(1, ...s.series), bx = 760, bw = 376, bh = 300, gap = 2, w = Math.min(28, Math.max(2, bw / Math.max(1, s.series.length) - gap));
  c.fillStyle = '#1a3a29';
  s.series.forEach((n, i) => { const h = Math.max(3, n / max * bh); c.fillRect(bx + i * (w + gap), 450 - h, w, h); });
  c.fillStyle = '#5f6b5a'; c.font = font(20, 500); c.fillText('tokens per active day', bx, 482);
  c.fillStyle = '#1a3a29'; c.fillRect(0, H - 76, W, 76);
  c.fillStyle = '#f7f4e5'; c.font = font(28, 700); c.fillText('These sessions are data. Sell them at thot.market', 64, H - 28);
}

async function* jsonlFiles(input) {
  for (const f of input) if (/\.jsonl$/i.test(f.name)) yield f;
}
async function* lines(file) {
  let rest = '';
  for await (const chunk of file.stream().pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split('\n'); rest = parts.pop();
    yield* parts;
  }
  if (rest) yield rest;
}
// Dropped folders arrive as entries; walk them to plain File objects.
async function filesFromEntry(entry, out) {
  if (entry.isFile) out.push(await new Promise((ok, no) => entry.file(ok, no)));
  else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (let batch; (batch = await new Promise((ok, no) => reader.readEntries(ok, no))).length;) for (const e of batch) await filesFromEntry(e, out);
  }
  return out;
}

if (typeof document !== 'undefined') {
  const $ = s => document.querySelector(s);
  const status = $('[data-bill-status]'), result = $('[data-bill-result]'), canvas = $('[data-bill-card]');
  const run = async files => {
    const bill = createBill(); let n = 0;
    result.hidden = true;
    for await (const f of jsonlFiles(files)) { status.textContent = `Reading ${++n} files…`; await bill.file(lines(f), f.webkitRelativePath || f.name); }
    const s = bill.summary();
    if (!s.tokens) { status.textContent = n ? 'No token usage found in those files. Pick ~/.claude/projects or ~/.codex/sessions.' : 'No .jsonl session files found in that folder.'; return; }
    status.textContent = `Read ${n} files. Nothing left your computer.`;
    await document.fonts?.ready; drawCard(canvas, s);
    $('[data-bill-download]').href = canvas.toDataURL('image/png');
    $('[data-bill-share]').href = 'https://x.com/intent/post?' + new URLSearchParams({ text: `My AI token bill: ${compact(s.tokens)} tokens${showCost(s) ? `, ${dollars(s.cost)} at API prices` : ''}. What's yours?`, url: 'https://thot.market/bill' });
    result.hidden = false; result.scrollIntoView({ behavior: 'smooth' });
  };
  $('[data-bill-input]').addEventListener('change', e => run(e.target.files));
  const drop = $('[data-bill-drop]');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('is-over');
    const files = [];
    for (const item of e.dataTransfer.items) { const entry = item.webkitGetAsEntry?.(); if (entry) await filesFromEntry(entry, files); }
    run(files);
  });
}
