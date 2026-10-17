// Moat Evaluator server: serves the UI and runs automated moat analysis with Claude.
//
// Credentials come from the environment, the same way the Anthropic SDK resolves them:
// ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL for a gateway).
// Optional: PORT (default 8765), MOAT_MODEL (default claude-opus-5-5).

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ARTICLE_URL, MOATS, STRESS, EROSION, EXEC } from './public/framework.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 8765;
const MODEL = process.env.MOAT_MODEL || 'claude-opus-5-5';
const HAS_CREDENTIALS = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const client = HAS_CREDENTIALS ? new Anthropic() : null;
// Learned on first use: some providers (e.g. Bedrock-backed gateways) reject the web search tool.
let webSearchSupported = null;

/* ------------------------------------------------------------------ *
 * Framework → prompt rubric and output schema
 * ------------------------------------------------------------------ */
const QUESTIONS = [
  ...MOATS.flatMap(m => m.questions.map(q => ({ ...q, section: `Moat type: ${m.title}` }))),
  ...Object.entries(STRESS).map(([id, q]) => ({ id, ...q, section: 'Stress test' })),
  ...Object.entries(EXEC).map(([id, q]) => ({ id, ...q, section: 'Execution' })),
];

const RUBRIC = QUESTIONS.map(q =>
  `[${q.id}] (${q.section}) ${q.text}\n  Guidance: ${q.help}\n${q.options.map((o, i) => `  ${i}: ${o}`).join('\n')}`
).join('\n\n') + `\n\n[erosion] Which of these could erode the position? Pick any that apply:\n${EROSION.map(e => `  ${e.id}: ${e.label}`).join('\n')}`;

const Answer = z.object({
  choice: z.number().int(),
  confidence: z.enum(['low', 'medium', 'high']),
  rationale: z.string(),
});
const AnalysisSchema = z.object({
  company_summary: z.string(),
  analysis_summary: z.string(),
  answers: z.object(Object.fromEntries(QUESTIONS.map(q => [q.id, Answer]))),
  erosion: z.array(z.enum(EROSION.map(e => e.id))),
  erosion_rationale: z.string(),
  evidence: z.array(z.object({ claim: z.string(), source: z.string() })),
  caveats: z.string(),
});

// Lenient version for parsing: gateways may not enforce the schema, so missing answers are
// recovered or left unanswered rather than failing the whole analysis.
const LenientSchema = AnalysisSchema.extend({
  answers: z.object(Object.fromEntries(QUESTIONS.map(q => [q.id, Answer.optional()]))),
  erosion: z.array(z.string()).catch([]),
  erosion_rationale: z.string().catch(''),
  evidence: z.array(z.object({ claim: z.string(), source: z.string() })).catch([]),
  caveats: z.string().catch(''),
});
const QUESTION_IDS = new Set(QUESTIONS.map(q => q.id));

const SYSTEM = `You are a skeptical strategy analyst. You evaluate whether a product or platform has a real competitive moat, using the framework from "Finding a Real Moat in the AI Era" (${ARTICLE_URL}).

The framework's core definition: a moat gets stronger with use and harder to copy the longer you hold it. A head start simply decays. It names five moat types (proprietary data that improves with use; distribution and network effects; workflow integration and switching costs; scarce inputs such as talent and compute; trust and permission to operate) and three tests (copy timeline and the half-price test; whether usage makes the company stronger or just more expensive; vulnerability such as single-vendor dependency and erosion).

You answer a fixed questionnaire about the subject. The questions are written in the first person ("we", "our"); read them as referring to the company being evaluated. For each question pick the option index that best fits the evidence, give a one- to three-sentence rationale grounded in specific facts, and rate your confidence. Give credit only for what the evidence supports: marketing claims of "proprietary data" or "network effects" need a concrete mechanism behind them. Where evidence is thin or conflicting, choose the more conservative option and mark confidence low. Name concrete competitors when they bear on the copy timeline.

In "evidence", list the most important facts behind your scoring, each with its source: a URL when you have one, otherwise "model knowledge". In "caveats", state what you could not verify and how current your information is.`;

/* ------------------------------------------------------------------ *
 * Source URLs supplied by the user — fetched server-side as text
 * ------------------------------------------------------------------ */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') ||
    (v6.startsWith('::ffff:') && isPrivateAddress(v6.slice(7)));
}

async function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http(s) URLs are allowed');
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error('private or local addresses are not allowed');
  return url;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const MAX_URLS = 5, MAX_CHARS_PER_URL = 25000;

async function fetchSource(raw, signal) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'user-agent': 'MoatEvaluator/1.0 (+local research tool)', accept: 'text/html,text/plain,application/json' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text\/|json|xml/.test(type)) throw new Error(`unsupported content type ${type || 'unknown'}`);
    const body = await res.text();
    const text = /html/.test(type) ? htmlToText(body) : body;
    return { url: url.href, text: text.slice(0, MAX_CHARS_PER_URL), truncated: text.length > MAX_CHARS_PER_URL };
  }
  throw new Error('too many redirects');
}

/* ------------------------------------------------------------------ *
 * Analysis pipeline
 * ------------------------------------------------------------------ */
async function research(subject, focus, signal) {
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }];
  const prompt = `Research "${subject}" so that an analyst can assess its competitive moat.${focus ? `\nThe user adds: ${focus}` : ''}

Find current, specific facts on: what the product is and who uses it; where its data comes from and whether usage improves it; network effects and how it reaches customers (owned vs partner channels); how embedded it is in customer workflows and what switching involves; its compute, ecosystem and talent position; regulatory permissions, trust record and legal exposure; the closest competitors and how fast they are catching up; pricing pressure and unit economics; which foundation-model vendors it depends on; and whether it is in broad production use.

Write a factual research brief organised under those headings. Cite the source URL for each important fact.`;

  const messages = [{ role: 'user', content: prompt }];
  const sources = new Map();
  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.messages.create({
      model: MODEL, max_tokens: 16000, output_config: { effort: 'medium' }, tools, messages,
    }, { signal });
    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) sources.set(r.url, r.title || r.url);
      }
    }
    if (response.stop_reason !== 'pause_turn') break;
    messages.splice(1, messages.length - 1, { role: 'assistant', content: response.content });
  }
  if (response.stop_reason === 'refusal') throw new Error('The model declined the research request.');
  const brief = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { brief, sources: [...sources].map(([url, title]) => ({ url, title })) };
}

async function score({ subject, focus, brief, documents, method }, signal) {
  const parts = [`Subject to evaluate: ${subject}`];
  if (focus) parts.push(`Context from the user: ${focus}`);
  if (brief) parts.push(`<research_brief>\n${brief}\n</research_brief>`);
  for (const d of documents) parts.push(`<source url="${d.url}">\n${d.text}\n</source>`);
  if (method === 'knowledge') {
    parts.push('No live web research was available. Base your answers on your training knowledge and any sources above, and say in the caveats how current that knowledge is.');
  }
  parts.push(`Today's date is ${new Date().toISOString().slice(0, 10)}. Answer every question in the questionnaire below.\n\n<questionnaire>\n${RUBRIC}\n</questionnaire>`);

  parts.push(`Respond with only the JSON object. Its "answers" object must contain exactly these ${QUESTIONS.length} keys: ${QUESTIONS.map(q => q.id).join(', ')}.`);

  // Some gateways pass output_config.format through without enforcing it, so parse and
  // validate the text ourselves rather than relying on messages.parse().
  const messages = [{ role: 'user', content: parts.join('\n\n') }];
  const call = async (format) => {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 16000, output_config: { effort: 'high', ...(format && { format }) }, system: SYSTEM, messages,
    }, { signal });
    if (response.stop_reason === 'refusal') throw new Error('The model declined to analyse this subject.');
    if (response.stop_reason === 'max_tokens') throw new Error('The analysis was cut off before it finished. Try again.');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return { text, json: parseJson(text) };
  };

  const first = await call(zodOutputFormat(AnalysisSchema));
  if (!first.json) throw new Error('The model returned an analysis that was not valid JSON. Try again.');
  const answers = collectAnswers(first.json);
  const missing = QUESTIONS.filter(q => !answers[q.id]).map(q => q.id);
  if (missing.length) {
    console.warn(`[score] ${subject}: re-asking for ${missing.length} missing answer(s): ${missing.join(', ')}`);
    messages.push({ role: 'assistant', content: first.text }, { role: 'user', content:
      `Your response omitted answers for: ${missing.join(', ')}. Respond with only a JSON object of the form {"answers": {"<id>": {"choice": <int>, "confidence": "low"|"medium"|"high", "rationale": "..."}}} covering exactly those ids.` });
    const retry = await call(null).catch(e => { if (signal.aborted) throw e; return null; });
    const more = retry?.json ? collectAnswers(retry.json) : {};
    for (const id of missing) if (more[id]) answers[id] = more[id];
  }

  const parsed = LenientSchema.safeParse({ ...first.json, answers });
  if (!parsed.success) {
    console.error('[score] invalid analysis:', parsed.error.issues);
    throw new Error('The model returned an analysis that did not match the expected format. Try again.');
  }
  return parsed.data;
}

function parseJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Finds answers keyed by question id anywhere in the output (models sometimes nest
// stress-test answers under their own key instead of "answers").
function collectAnswers(json) {
  const found = {};
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (QUESTION_IDS.has(k) && !found[k] && Answer.safeParse(v).success) found[k] = v;
      else walk(v);
    }
  };
  walk(json.answers); walk(json);
  return found;
}

function normalise(out) {
  const answers = {};
  for (const q of QUESTIONS) {
    const a = out.answers[q.id];
    const valid = a && Number.isInteger(a.choice) && a.choice >= 0 && a.choice < q.options.length;
    answers[q.id] = valid ? a : { choice: null, confidence: 'low', rationale: a?.rationale || 'No valid answer returned.' };
  }
  const valid = new Set(EROSION.map(e => e.id));
  return { ...out, answers, erosion: [...new Set(out.erosion)].filter(id => valid.has(id)) };
}

async function analyze(body, emit, signal) {
  const subject = String(body.subject || '').trim().slice(0, 200);
  const focus = String(body.focus || '').trim().slice(0, 2000);
  if (!subject) throw new Error('Enter a company or product name.');
  const urls = [...new Set(String(body.urls || '').split(/\s+/).filter(Boolean))].slice(0, MAX_URLS);

  const documents = [], skipped = [];
  for (const u of urls) {
    emit({ type: 'status', message: `Reading ${u}` });
    try { documents.push(await fetchSource(u, signal)); }
    catch (e) { if (signal.aborted) throw e; skipped.push({ url: u, reason: e.message }); }
  }

  let method = 'knowledge', brief = '', sources = [];
  if (webSearchSupported !== false) {
    emit({ type: 'status', message: `Researching ${subject} on the web` });
    try {
      ({ brief, sources } = await research(subject, focus, signal));
      method = 'web';
      webSearchSupported = true;
    } catch (e) {
      // A 400 here means this provider doesn't offer the web search tool; fall back to model knowledge.
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      webSearchSupported = false;
      emit({ type: 'status', message: 'Live web search isn\'t available with this provider. Using model knowledge instead.' });
    }
  }

  emit({ type: 'status', message: 'Scoring against the moat framework' });
  const out = normalise(await score({ subject, focus, brief, documents, method }, signal));
  return {
    ...out,
    subject, method, model: MODEL, analyzedAt: new Date().toISOString(),
    sources: [...documents.map(d => ({ url: d.url, title: 'Provided by you' + (d.truncated ? ' (truncated)' : '') })), ...sources],
    skipped,
  };
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The Claude API rejected the credentials. Check ANTHROPIC_API_KEY.';
  if (e instanceof Anthropic.PermissionDeniedError) return `Your credentials can't use the model ${MODEL}. Set MOAT_MODEL to a model you have access to.`;
  if (e instanceof Anthropic.NotFoundError) return `Model ${MODEL} wasn't found. Set MOAT_MODEL to a valid model.`;
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API. Wait a minute and try again.';
  if (e instanceof Anthropic.APIError) return `Claude API error${e.status ? ` ${e.status}` : ''}: ${e.message}`;
  return e.message || String(e);
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

async function readJson(req, limit = 20000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Request too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ configured: HAS_CREDENTIALS, model: MODEL, webSearch: webSearchSupported }));
    return;
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (e) { res.writeHead(400).end(e.message); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    const emit = evt => res.write(JSON.stringify(evt) + '\n');
    if (!client) {
      emit({ type: 'error', message: 'No Claude credentials found. Start the server with ANTHROPIC_API_KEY set.' });
      res.end(); return;
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      emit({ type: 'result', data: await analyze(body, emit, controller.signal) });
    } catch (e) {
      if (!controller.signal.aborted) { console.error('[analyze]', e); emit({ type: 'error', message: describeError(e) }); }
    }
    res.end();
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Moat Evaluator running at http://127.0.0.1:${PORT}/`);
  console.log(HAS_CREDENTIALS ? `Automated analysis enabled (model: ${MODEL})` : 'Automated analysis disabled: set ANTHROPIC_API_KEY to enable it.');
});
