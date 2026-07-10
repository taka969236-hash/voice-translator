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

/* ── 本番(Render) か ローカルか ── */
const IS_PROD = !!(process.env.RENDER || process.env.NODE_ENV === 'production');

/* ── Claude API ── */
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/* ── セッション管理 ── */
const sessions = new Map();
// { token → { context: [], history: [], lastActivity: timestamp } }

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [token, s] of sessions) {
    if (s.lastActivity < cutoff) sessions.delete(token);
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
  sessions.set(token, { context: [], history: [], lastActivity: Date.now() });
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

/* ── 翻訳 API (Claude Haiku + コンテキスト) ── */
const LANG_NAMES = { ja: '日本語', vi: 'ベトナム語', my: 'ミャンマー語' };

app.post('/api/translate', requireSession, rateLimit, async (req, res) => {
  const { text, from } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'テキストが必要です' });
  if (!anthropic)    return res.status(503).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  const ALL     = ['ja', 'vi', 'my'];
  const targets = ALL.filter(l => l !== from);
  const sess    = req.sess;

  // 直近10件のコンテキスト
  const ctxLines = sess.context.slice(-10).map(ex => {
    const tLine = targets.map(t => `→${LANG_NAMES[t]}: ${ex[t] || '—'}`).join(' | ');
    return `[${LANG_NAMES[ex.from]}] ${ex.text}  ${tLine}`;
  }).join('\n');

  const system = [
    'あなたは日本語・ベトナム語・ミャンマー語の専門通訳者です。',
    'ビジネス・業務シーンを想定し、正確かつ自然な翻訳をしてください。',
    `必ずJSON形式のみで返答してください: {"${targets[0]}":"翻訳文","${targets[1]}":"翻訳文"}`,
    'JSON以外のテキストは一切出力しないでください。',
  ].join('\n');

  const userMsg = ctxLines
    ? `【これまでの会話の流れ】\n${ctxLines}\n\n【今回の翻訳】\n${LANG_NAMES[from]}: ${text.trim()}`
    : `${LANG_NAMES[from]}: ${text.trim()}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMsg }],
    });

    const raw = response.content[0].text.trim();
    let translations = {};
    try { translations = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) { try { translations = JSON.parse(m[0]); } catch {} }
    }

    const entry = {
      from,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      ...translations,
    };
    sess.context.push(entry);
    if (sess.context.length > 50) sess.context.shift();
    sess.history.push(entry);

    res.json(translations);
  } catch(err) {
    res.status(500).json({ error: err.message });
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
