require('dotenv').config();
const express    = require('express');
const https      = require('https');
const QRCode     = require('qrcode');
const selfsigned = require('selfsigned');
const Anthropic  = require('@anthropic-ai/sdk');
const crypto     = require('crypto');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const multer = require('multer');
const XLSX   = require('xlsx');
const PizZip = require('pizzip');
const AdmZip = require('adm-zip');

/* ── 本番(Render) か ローカルか ── */
const IS_PROD = !!(process.env.RENDER || process.env.NODE_ENV === 'production');

/* ── Claude API ── */
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/* ── セッション管理 ── */
const sessions = new Map();
// { token → { context: [], history: [], dictionary: [], viewToken, viewers: Set<res>, lastActivity } }
const viewTokens = new Map(); // viewToken → sessionToken

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [token, s] of sessions) {
    if (s.lastActivity < cutoff) {
      if (s.viewToken) viewTokens.delete(s.viewToken);
      for (const res of s.viewers) { try { res.end(); } catch {} }
      sessions.delete(token);
    }
  }
}, 60 * 60 * 1000);

function requireSession(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: '認証が必要です' });
  }
  const sess = sessions.get(token);
  sess.lastActivity = Date.now();
  req.sess = sess;
  next();
}

/* ── レート制限 ── */
const rateMap = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < 60000);
  arr.push(now);
  rateMap.set(key, arr);
  if (arr.length > 60) return res.status(429).json({ error: 'レート制限: しばらく待ってから再試行してください' });
  next();
}

/* ── ローカルIP取得 ── */
function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

/* ── 自己署名証明書 (ローカル用) ── */
async function getCert(ips) {
  const dir      = path.join(__dirname, '.certs');
  const certFile = path.join(dir, 'cert.pem');
  const keyFile  = path.join(dir, 'key.pem');
  const ipsFile  = path.join(dir, 'ips.json');

  let needsRegen = !fs.existsSync(certFile);
  if (!needsRegen && fs.existsSync(ipsFile)) {
    const saved = JSON.parse(fs.readFileSync(ipsFile, 'utf8'));
    needsRegen = JSON.stringify([...ips].sort()) !== JSON.stringify([...saved].sort());
  }
  if (needsRegen) {
    fs.mkdirSync(dir, { recursive: true });
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...ips.map(ip => ({ type: 7, ip })),
    ];
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'voice-translator' }],
      { days: 825, extensions: [{ name: 'subjectAltName', altNames }] }
    );
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(ipsFile, JSON.stringify(ips));
    console.log('  🔐 SSL証明書を生成 (.certs/)');
    return { cert: pems.cert, key: pems.private };
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/* ── Express ── */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── PIN 認証 → セッショントークン発行 ── */
app.post('/api/auth', rateLimit, (req, res) => {
  const { pin } = req.body;
  const APP_PIN = process.env.APP_PIN;
  if (!APP_PIN) return res.status(503).json({ error: '管理者設定: APP_PIN が未設定です' });
  if (typeof pin !== 'string' || pin !== APP_PIN) {
    return res.status(401).json({ error: 'PINが正しくありません' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, {
    context: [], history: [], dictionary: [],
    viewToken: null, viewers: new Set(),
    lastActivity: Date.now(),
  });
  res.json({ token });
});

/* ── セッション確認 ── */
app.get('/api/session', requireSession, (req, res) => {
  res.json({ ok: true, historyCount: req.sess.history.length });
});

/* ── QR コード ── */
app.get('/api/qr', async (req, res) => {
  const ip   = getLocalIPs()[0] || 'localhost';
  const PORT = process.env.PORT || 3000;
  const proto = IS_PROD ? 'https' : 'https';
  const svg  = await QRCode.toString(`${proto}://${ip}:${PORT}`, {
    type: 'svg', color: { dark: '#4f46e5', light: '#ffffff' }, margin: 2, width: 200,
  });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

/* ── ネットワーク情報 ── */
app.get('/api/netinfo', (req, res) => {
  const PORT  = process.env.PORT || 3000;
  const proto = IS_PROD ? 'https' : 'https';
  res.json({ ips: getLocalIPs(), port: PORT, protocol: proto });
});

/* ── 視聴専用リンク (PIN不要でリアルタイム翻訳をフォロー) ── */
app.get('/api/view-token', requireSession, (req, res) => {
  const sess = req.sess;
  if (!sess.viewToken) {
    sess.viewToken = crypto.randomUUID();
    viewTokens.set(sess.viewToken, req.headers['x-session-token']);
  }
  const url = `${req.protocol}://${req.get('host')}/view.html?t=${sess.viewToken}`;
  res.json({ viewToken: sess.viewToken, url });
});

app.get('/api/view/:viewToken/qr', async (req, res) => {
  const token = viewTokens.get(req.params.viewToken);
  if (!token || !sessions.has(token)) return res.status(404).send('Not found');
  const url = `${req.protocol}://${req.get('host')}/view.html?t=${req.params.viewToken}`;
  const svg = await QRCode.toString(url, {
    type: 'svg', color: { dark: '#4f46e5', light: '#ffffff' }, margin: 2, width: 200,
  });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/api/view/:viewToken/stream', (req, res) => {
  const token = viewTokens.get(req.params.viewToken);
  const sess  = token && sessions.get(token);
  if (!sess) return res.status(410).send('Link expired');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sess.viewers.add(res);
  const last = sess.context.at(-1);
  if (last) res.write(`data: ${JSON.stringify(last)}\n\n`);

  req.on('close', () => sess.viewers.delete(res));
});

/* ── TTS プロキシ (ミャンマー語など内蔵ボイスのない言語用) ── */
app.get('/api/tts', async (req, res) => {
  const { text, lang } = req.query;
  if (!text || !lang) return res.status(400).send('Missing params');
  const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=gtx&q=${encodeURIComponent(text.slice(0, 200))}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://translate.google.com',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(502).send('TTS unavailable');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).send('TTS error');
  }
});

/* ── 翻訳 API (Claude Sonnet + コンテキスト) ── */
const LANG_NAMES = { ja: '日本語', vi: 'ベトナム語', my: 'ミャンマー語' };

function buildGlossary(dictionary, targets) {
  if (!dictionary?.length) return '';
  const lines = dictionary
    .map(d => `${d.ja} → ` + targets.map(t => d[t] ? `${t}:${d[t]}` : null).filter(Boolean).join(', '))
    .filter(l => !l.endsWith('→ '));
  if (!lines.length) return '';
  return 'Glossary — always use these exact translations for these terms:\n' + lines.join('\n');
}

const TRANSLATION_SYSTEM = `You are a professional real-time interpreter specializing in Japanese, Vietnamese, and Burmese (Myanmar).

CRITICAL — NATURALNESS RULES:
- Produce translations that sound 100% natural to a native speaker in daily conversation.
- NEVER translate word-for-word or mirror the source grammar.
- Use common spoken expressions, not textbook or overly formal language unless the source is clearly formal.
- Adapt politeness level to match the original (casual speech → casual translation).

LANGUAGE-SPECIFIC GUIDELINES:
Vietnamese (vi):
- Use natural Southern Vietnamese phrasing as the default (phổ thông).
- Prefer colloquial spoken forms over written/formal ones.
- Use appropriate particles (ạ, nhé, đấy, vậy) that a native would naturally add.
- Avoid literal calques from Japanese or English structure.

Burmese/Myanmar (my):
- Write in standard Myanmar script (Unicode). Never use Zawgyi encoding.
- Use natural everyday Burmese, not overly Pali-heavy formal Burmese.
- Match the register: casual workplace → conversational Burmese.
- Use natural sentence-final particles (ပါ, ကွာ, နော် etc.) appropriate to the tone.

OUTPUT FORMAT: Respond ONLY with a single JSON object, no markdown, no explanation:
{"LANG_CODE":"translation","LANG_CODE":"translation"}`;

app.post('/api/translate', requireSession, rateLimit, async (req, res) => {
  const { text, from } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'テキストが必要です' });
  if (!anthropic)    return res.status(503).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  const ALL     = ['ja', 'vi', 'my'];
  const targets = ALL.filter(l => l !== from);
  const sess    = req.sess;

  // 直近5件のコンテキスト（多すぎると品質低下・翻訳ミスが混入する）
  const ctxLines = sess.context.slice(-5).map(ex => {
    const tLine = targets
      .filter(t => ex[t])
      .map(t => `  ${t}: ${ex[t]}`).join('\n');
    return `${ex.from}: ${ex.text}\n${tLine}`;
  }).join('\n---\n');

  const langSpec  = `Translate the following into ${targets.map(t => `${t} (${LANG_NAMES[t]})`).join(' and ')}.`;
  const glossary  = buildGlossary(sess.dictionary, targets);
  const userMsg = [
    langSpec,
    glossary,
    ctxLines ? `Conversation context:\n${ctxLines}` : '',
    `Now translate:\n${from}: ${text.trim()}`,
  ].filter(Boolean).join('\n\n');

  // SSE ストリーミングレスポンス
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Render プロキシの idle タイムアウトを回避するため 15 秒ごとに ping を送る
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  res.on('close', () => clearInterval(ping));

  const MODELS = [
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022',
  ];

  for (const model of MODELS) {
    let accumulated = '';
    try {
      const stream = anthropic.messages.stream({
        model, max_tokens: 800, temperature: 0, system: TRANSLATION_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      });

      stream.on('text', chunk => {
        accumulated += chunk;
        sse({ p: accumulated });
      });

      const finalMsg = await stream.finalMessage();
      const raw = finalMsg.content[0].text.trim();

      let translations = {};
      try { translations = JSON.parse(raw); }
      catch {
        const m = raw.match(/\{[\s\S]*?\}/);
        if (m) { try { translations = JSON.parse(m[0]); } catch {} }
      }

      // モデルが指定フォーマットを守らずJSONを返さなかった場合は失敗扱いにして次のモデルへ
      const hasAnyTranslation = targets.some(t => translations[t]);
      if (!hasAnyTranslation) {
        console.error(`[translate] model=${model} unparseable output: ${raw.slice(0, 200)}`);
        continue;
      }

      const entry = { from, text: text.trim(), timestamp: new Date().toISOString(), ...translations };
      sess.context.push(entry);
      if (sess.context.length > 50) sess.context.shift();
      sess.history.push(entry);
      for (const viewerRes of sess.viewers) {
        try { viewerRes.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
      }

      console.log(`[translate] model=${model} from=${from}`);
      sse({ done: true, t: translations });
      res.end();
      return;

    } catch(err) {
      const status = err.status || err.statusCode;
      console.error(`[translate] model=${model} err${status}: ${err.message?.slice(0,120)}`);
      // ストリーミング前（テキスト未送信）なら次のモデルで再試行
      const canRetry = accumulated === '' && !res.writableEnded;
      if (canRetry) continue;
      break;
    }
  }

  if (!res.writableEnded) {
    sse({ error: '翻訳に失敗しました。しばらく待ってから再度お試しください。' });
    res.end();
  }
});

/* ── ドキュメント翻訳 ── */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const DOC_LANG_NAMES = { Vietnamese: 'Vietnamese', Burmese: 'Burmese (Myanmar)' };
// ミャンマー語は日本語の約2倍トークン → バッチを小さく抑える
const DOC_BATCH = 6;
// 文書翻訳はSonnetで品質優先（Haikuはミャンマー語の精度不足・誤訳多発）
const DOC_MODEL = 'claude-sonnet-4-6';

// 数値・日付・時刻・アイウエオ列挙符号のみのテキストは翻訳不要（そのまま保持）
function isNumericOnly(text) {
  const t = text.trim();
  if (t.length === 0) return true;
  if (/^[\d,]+(\.\d+)?%?$/.test(t)) return true;                          // 数字・小数・%
  if (/^\d{4}[\/\-年]\d{1,2}([\/\-月]\d{1,2}日?)?$/.test(t)) return true; // 日付
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;                    // 時刻
  if (t.length <= 1) return true;
  // ア・イ・ウ等の列挙符号のみ（1文字 + 任意の括弧/句読点）例: ア ア. (ア) ア）
  if (/^[（(]?[ぁ-ゟァ-ヶ][）).。]?$/.test(t)) return true;
  // 丸数字・括弧数字・ローマ数字のみ 例: ①  (1)  Ⅱ
  if (/^[①-⑳㈠-㈩Ⅰ-ⅻ][.。\s]*$/.test(t)) return true;
  return false;
}

// 日本語（ひらがな・カタカナ・漢字）が残っている = 翻訳失敗
// ただし先頭の列挙符号（ア. など）は除いて判定
function hasJapaneseSigns(text) {
  // 先頭の「（ア）」「ア. 」などの列挙符号を除いた本文で検出
  const body = text.replace(/^[\s（(]*[ぁ-ゟァ-ヶ][\s）).。]+/, '');
  // ひらがな・カタカナ・漢字（CJK統合漢字）のいずれかが残っていれば失敗
  return /[ぁ-ゟァ-ヶ一-鿿㐀-䶿]/.test(body);
}

async function translateOne(text, targetLang, client) {
  const langName = DOC_LANG_NAMES[targetLang];
  const r = await client.messages.create({
    model: DOC_MODEL, max_tokens: 2048, temperature: 0,
    messages: [{ role: 'user', content:
      `Translate this Japanese text to ${langName}. Output ONLY in ${langName}. Do NOT include any Japanese characters. EXCEPTION: if the text starts with a kana list marker (ア, イ, ウ, etc.), keep that marker as-is. Return only the translation, no markdown, no explanation.\n\n${text}` }],
  });
  const out = r.content[0].text.trim();
  // 元テキストと同一、またはひらがな/カタカナが残っている場合は失敗
  return (out && out !== text && !hasJapaneseSigns(out)) ? out : null;
}

async function translateDocBatch(texts, targetLang, client, glossary) {
  if (!texts.length) return [];
  const langName = DOC_LANG_NAMES[targetLang];
  const prompt = [
    `Translate the following Japanese texts to ${langName}.`,
    `CRITICAL: Output ONLY in ${langName}. Do NOT include any Japanese hiragana, katakana, or kanji in your translations.`,
    `EXCEPTION: If a text starts with a Japanese kana list marker (e.g. ア, イ, ウ, エ, possibly with punctuation like ア. or （ア）), keep that marker exactly as-is and translate only the remaining text.`,
    glossary,
    `Return ONLY a JSON array of exactly ${texts.length} translated strings in the same order. No explanation, no markdown.`,
    `Input: ${JSON.stringify(texts)}`,
    'Output:',
  ].filter(Boolean).join('\n\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client.messages.create({
      model: DOC_MODEL, max_tokens: 8192, temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    // stop_reason が max_tokens = 出力が切断されている → 即フォールバック
    if (resp.stop_reason === 'max_tokens') {
      console.warn(`[doc-batch] attempt=${attempt+1} truncated (max_tokens), skip to 1-by-1`);
      break;
    }
    const raw = resp.content[0].text.trim();
    const m = raw.match(/\[[\s\S]*\]/);
    try {
      const arr = JSON.parse(m ? m[0] : raw);
      if (Array.isArray(arr) && arr.length === texts.length) return arr;
      console.warn(`[doc-batch] attempt=${attempt+1} got ${arr?.length ?? 'n/a'}/${texts.length} items`);
    } catch {
      console.warn(`[doc-batch] attempt=${attempt+1} JSON parse failed`);
    }
  }

  // フォールバック: 1件ずつ順次翻訳（並列禁止: レート制限を避けるため）
  console.warn(`[doc-batch] 1-by-1 fallback for ${texts.length} texts`);
  const results = [];
  for (const t of texts) {
    try {
      const out = await translateOne(t, targetLang, client);
      results.push(out ?? t);
    } catch { results.push(t); }
  }
  return results;
}

async function translateDocTexts(texts, targetLang, client, glossary) {
  const results = [...texts];
  // 空白・数値・日付のみのテキストは翻訳対象外
  const idxs = texts.reduce((a, t, i) => {
    if (t && t.trim() && !isNumericOnly(t)) a.push(i);
    return a;
  }, []);

  for (let b = 0; b < idxs.length; b += DOC_BATCH) {
    const batch = idxs.slice(b, b + DOC_BATCH);
    const translated = await translateDocBatch(batch.map(i => texts[i]), targetLang, client, glossary);
    batch.forEach((oi, j) => {
      const t = translated[j];
      // 翻訳結果が存在し、元テキストと異なり、ひらがな/カタカナがない場合のみ採用
      if (t && t !== texts[oi] && !hasJapaneseSigns(t)) results[oi] = t;
      else if (t && hasJapaneseSigns(t)) {
        console.warn(`[doc-texts] kana in result idx=${oi}: "${t.slice(0,40)}"`);
      }
    });
  }

  // 第2パス: ひらがな/カタカナが残っているか元テキストのままの項目を個別再試行
  const retryIdxs = idxs.filter(i => hasJapaneseSigns(results[i]) || results[i] === texts[i]);
  if (retryIdxs.length > 0) {
    console.warn(`[doc-texts] 2nd-pass retry for ${retryIdxs.length} items`);
    for (const i of retryIdxs) {
      try {
        const out = await translateOne(texts[i], targetLang, client);
        if (out && !hasJapaneseSigns(out)) results[i] = out;
      } catch {}
    }
  }

  return results;
}

function escXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function extractExcelTexts(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const seen = new Set(); const texts = [];
  wb.SheetNames.forEach(n => {
    const ws = wb.Sheets[n];
    Object.keys(ws).filter(k => !k.startsWith('!')).forEach(addr => {
      const c = ws[addr];
      if (c.t === 's' && c.v && c.v.trim() && !seen.has(c.v)) { seen.add(c.v); texts.push(c.v); }
    });
  });
  return texts;
}

function processExcel(buf, translations, origTexts) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const map = Object.fromEntries(origTexts.map((t, i) => [t, translations[i]]));
  wb.SheetNames.forEach(n => {
    const ws = wb.Sheets[n];
    Object.keys(ws).filter(k => !k.startsWith('!')).forEach(addr => {
      const c = ws[addr];
      if (c.t === 's' && c.v && map[c.v]) { c.v = map[c.v]; delete c.r; delete c.h; }
    });
  });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function extractDocxTexts(buf) {
  const zip = new PizZip(buf);
  const xml = zip.file('word/document.xml').asText();
  const paras = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const txt = [...m[0].matchAll(/<w:t(?:[^>]*)?>([^<]*)<\/w:t>/g)].map(r => r[1]).join('');
    if (txt.trim()) paras.push({ text: txt.trim(), index: m.index, length: m[0].length });
  }
  return { xml, paras };
}

function rebuildDocx(buf, translations, { xml, paras }) {
  let newXml = xml;
  for (let i = paras.length - 1; i >= 0; i--) {
    const { index, length } = paras[i];
    const trans = translations[i];
    if (!trans) continue;
    let replaced = false;
    const newPara = newXml.slice(index, index + length).replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (_, a) => {
      if (!replaced) { replaced = true; return `<w:t${a}>${escXml(trans)}</w:t>`; }
      return `<w:t${a}></w:t>`;
    });
    newXml = newXml.slice(0, index) + newPara + newXml.slice(index + length);
  }
  const zip = new PizZip(buf);
  zip.file('word/document.xml', newXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

app.post('/api/translate-doc', requireSession, rateLimit, upload.single('file'), async (req, res) => {
  if (!req.file)   return res.status(400).json({ error: 'ファイルが必要です' });
  if (!anthropic)  return res.status(503).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  const langs = [req.body.langs].flat().filter(Boolean);
  if (!langs.length) return res.status(400).json({ error: '言語を選択してください' });

  const ext  = path.extname(req.file.originalname).toLowerCase();
  const stem = path.basename(req.file.originalname, ext);
  if (!['.xlsx', '.docx'].includes(ext))
    return res.status(400).json({ error: '.xlsx または .docx のみ対応しています' });

  try {
    const outputs = [];
    for (const lang of langs) {
      const code     = lang === 'Vietnamese' ? 'vi' : 'my';
      const suffix   = lang === 'Vietnamese' ? '(ベトナム)' : '(ミャンマー)';
      const glossary = buildGlossary(req.sess.dictionary, [code]);
      let outBuf;
      if (ext === '.xlsx') {
        const texts = extractExcelTexts(req.file.buffer);
        const translated = await translateDocTexts(texts, lang, anthropic, glossary);
        outBuf = processExcel(req.file.buffer, translated, texts);
      } else {
        const info = extractDocxTexts(req.file.buffer);
        const texts = info.paras.map(p => p.text);
        const translated = await translateDocTexts(texts, lang, anthropic, glossary);
        outBuf = rebuildDocx(req.file.buffer, translated, info);
      }
      outputs.push({ name: `${stem}${suffix}${ext}`, buf: outBuf });
    }

    if (outputs.length === 1) {
      const { name, buf } = outputs[0];
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('Content-Type', ext === '.xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      return res.send(buf);
    }

    const zip = new AdmZip();
    outputs.forEach(o => zip.addFile(o.name, o.buf));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(stem + '_翻訳.zip')}`);
    res.setHeader('Content-Type', 'application/zip');
    res.send(zip.toBuffer());

  } catch (err) {
    console.error('[translate-doc]', err.message);
    res.status(500).json({ error: `翻訳エラー: ${err.message}` });
  }
});

/* ── 翻訳履歴取得 ── */
app.get('/api/history', requireSession, (req, res) => {
  res.json(req.sess.history);
});

/* ── コンテキストリセット (履歴は保持) ── */
app.delete('/api/context', requireSession, (req, res) => {
  req.sess.context = [];
  res.json({ ok: true });
});

/* ── カスタム辞書 ── */
app.get('/api/dictionary', requireSession, (req, res) => {
  res.json(req.sess.dictionary);
});

app.post('/api/dictionary', requireSession, rateLimit, (req, res) => {
  const { ja, vi, my } = req.body;
  if (!ja?.trim() || (!vi?.trim() && !my?.trim())) {
    return res.status(400).json({ error: '日本語 と 少なくとも1つの訳語が必要です' });
  }
  const entry = { id: crypto.randomUUID(), ja: ja.trim(), vi: vi?.trim() || '', my: my?.trim() || '' };
  req.sess.dictionary.push(entry);
  res.json(entry);
});

app.delete('/api/dictionary/:id', requireSession, (req, res) => {
  req.sess.dictionary = req.sess.dictionary.filter(d => d.id !== req.params.id);
  res.json({ ok: true });
});

app.put('/api/dictionary/:id', requireSession, rateLimit, (req, res) => {
  const { ja, vi, my } = req.body;
  if (!ja?.trim() || (!vi?.trim() && !my?.trim())) {
    return res.status(400).json({ error: '日本語 と 少なくとも1つの訳語が必要です' });
  }
  const dict = req.sess.dictionary;
  const idx = dict.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  dict[idx] = { ...dict[idx], ja: ja.trim(), vi: vi?.trim() || '', my: my?.trim() || '' };
  res.json(dict[idx]);
});

/* ── サーバー起動 ── */
const PORT = process.env.PORT || 3000;

if (IS_PROD) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 同時通訳サーバー起動 (port ${PORT})`);
    console.log(`   Claude API: ${anthropic ? '有効' : '未設定'}`);
    console.log(`   PIN認証: ${process.env.APP_PIN ? '有効' : '未設定'}`);
  });
} else {
  (async () => {
    const ips = getLocalIPs();
    const { cert, key } = await getCert(ips);
    https.createServer({ cert, key }, app).listen(PORT, '0.0.0.0', () => {
      console.log('\n🎤 同時通訳 3言語 (ローカル / HTTPS)');
      console.log('─'.repeat(50));
      console.log(`  PC      : https://localhost:${PORT}`);
      ips.forEach(ip => console.log(`  スマホ等: https://${ip}:${PORT}`));
      console.log('─'.repeat(50));
      console.log(`  Claude API: ${anthropic ? '有効' : '⚠️  ANTHROPIC_API_KEY 未設定'}`);
      console.log(`  PIN認証:    ${process.env.APP_PIN ? '有効 (' + process.env.APP_PIN.length + '桁)' : '⚠️  APP_PIN 未設定'}`);
      console.log('');
    });
  })();
}
