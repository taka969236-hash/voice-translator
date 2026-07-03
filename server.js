require('dotenv').config();
const express    = require('express');
const https      = require('https');
const QRCode     = require('qrcode');
const selfsigned = require('selfsigned');
const Groq       = require('groq-sdk');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

/* ── 本番(Render) か ローカルか ── */
const IS_PROD = !!(process.env.RENDER || process.env.NODE_ENV === 'production');

/* ── Groq (ミャンマー語音声認識) ── */
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

/* ── Google Translate 非公式 API (無料・キー不要) ── */
const SRC_MAP = {
  'ja-JP':'ja', 'en-US':'en', 'zh-CN':'zh-CN',
  'ko-KR':'ko', 'vi-VN':'vi', 'th-TH':'th',
};

async function translateGoogle(src, tgt, text) {
  const q   = encodeURIComponent(text.slice(0, 800));
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${q}`;
  const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  // data[0] は [[翻訳文, 原文], ...] の配列
  return (data[0] || []).map(p => p[0]).filter(Boolean).join('');
}

/* ── ローカル開発用 ── */
function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

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

/* QR コード (ローカル用) */
app.get('/api/qr', async (req, res) => {
  const ip   = getLocalIPs()[0] || 'localhost';
  const PORT = process.env.PORT || 3000;
  const proto = IS_PROD ? 'http' : 'https';
  const svg  = await QRCode.toString(`${proto}://${ip}:${PORT}`, {
    type: 'svg', color: { dark: '#4f46e5', light: '#ffffff' }, margin: 2, width: 200,
  });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

/* ネットワーク情報 (ローカル用) */
app.get('/api/netinfo', (req, res) => {
  const PORT  = process.env.PORT || 3000;
  const proto = IS_PROD ? 'http' : 'https';
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
  } catch (err) {
    res.status(502).send('TTS error');
  }
});

/* ── 音声認識 API (Groq Whisper) ── */
app.post('/api/transcribe',
  express.raw({ type: '*/*', limit: '25mb' }),
  async (req, res) => {
    if (!groq) return res.status(503).json({ error: 'GROQ_API_KEY が未設定です' });
    const lang = req.query.lang || 'my';
    try {
      const mimeType = req.headers['content-type'] || 'audio/webm';
      const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([req.body], `rec.${ext}`, { type: mimeType });
      const result = await groq.audio.transcriptions.create({
        file,
        model: 'whisper-large-v3',
        language: lang,
      });
      res.json({ text: result.text });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ── 翻訳 API ── */
app.post('/api/translate', async (req, res) => {
  const { text, from } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'テキストが必要です' });

  const ALL = ['ja', 'vi', 'my'];
  const src = ALL.includes(from) ? from : 'auto';
  const targets = ALL.filter(l => l !== from);

  try {
    const entries = await Promise.all(
      targets.map(async tgt => [tgt, await translateGoogle(src, tgt, text.trim())])
    );
    res.json(Object.fromEntries(entries));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── サーバー起動 ── */
const PORT = process.env.PORT || 3000;

if (IS_PROD) {
  /* 本番: Render が HTTPS を処理 → HTTP で起動 */
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 音声翻訳サーバー起動 (port ${PORT})`);
  });
} else {
  /* ローカル開発: HTTPS (Web Speech API のため) */
  (async () => {
    const ips = getLocalIPs();
    const { cert, key } = await getCert(ips);
    https.createServer({ cert, key }, app).listen(PORT, '0.0.0.0', () => {
      console.log('\n🎤 音声リアルタイム翻訳 (ローカル / HTTPS)');
      console.log('─'.repeat(50));
      console.log(`  PC      : https://localhost:${PORT}`);
      ips.forEach(ip => console.log(`  スマホ等: https://${ip}:${PORT}`));
      console.log('─'.repeat(50));
      console.log('  ⚡ 翻訳エンジン: Lingva Translate (無料・コストゼロ)');
      console.log('  📱 初回: ブラウザの「詳細設定」→「サイトへ移動」');
      console.log('');
    });
  })();
}
