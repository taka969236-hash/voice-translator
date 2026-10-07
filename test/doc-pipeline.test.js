// 文書翻訳パイプラインの回帰テスト（実APIは使わずモックで検証）: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const XLSX   = require('xlsx');
const PizZip = require('pizzip');
const S      = require('../server.js');

const JP = /[ぁ-ゟァ-ヶ一-鿿]/;

// プロンプトから入力テキスト群を取り出し、変換関数 f を適用して返すモック
function mockClient(f, { fail } = {}) {
  const calls = { n: 0 };
  return {
    calls,
    messages: {
      create: async (body) => {
        calls.n++;
        if (fail) throw Object.assign(new Error(fail.message), { status: fail.status });
        const content = body.messages[0].content;
        const m = content.match(/\nInput: (\[.*\])\n/s);
        const text = m
          ? JSON.stringify(JSON.parse(m[1]).map(f))
          : f(content.split('\n\n').pop());
        return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' };
      },
    },
  };
}
const toVi = t => 'Vi:' + t.replace(/[^\x00-\x7f]/g, '').padEnd(3, 'x') + t.length;
const run = (buffer, ext, client, ctx = S.newDocCtx({ tokens: { input: 0, output: 0 } })) =>
  S.translateDocument({ buffer, ext, lang: 'Vietnamese', client, glossary: '', ctx });

function makeXlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const readCells = buf => {
  const ws = XLSX.read(buf, { type: 'buffer' }).Sheets.S1;
  return Object.keys(ws).filter(k => !k.startsWith('!')).map(k => ws[k].v);
};

test('xlsx: 日本語セルが翻訳され、数値・英数字・重複は正しく扱われる', async () => {
  const ctx = S.newDocCtx({ tokens: { input: 0, output: 0 } });
  const client = mockClient(toVi);
  const out = await run(makeXlsx([['教育実施一覧', 12345, 'ABC-001'], ['教育実施一覧', '受講者名簿', null]]), '.xlsx', client, ctx);
  const cells = readCells(out);
  assert.ok(cells.includes(12345) && cells.includes('ABC-001'));
  assert.equal(cells.filter(c => typeof c === 'string' && JP.test(c)).length, 0, '日本語が残っている');
  assert.equal(ctx.stats.total, 2, '重複排除で2件');
  assert.equal(ctx.stats.failed, 0);
  assert.ok(ctx.sess.tokens.input > 0, 'トークン集計');
});

test('docx / pptx: 段落が翻訳される', async () => {
  const docx = new PizZip();
  docx.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>こんにちは世界</w:t></w:r></w:p></w:body></w:document>');
  const o1 = new PizZip(await run(docx.generate({ type: 'nodebuffer' }), '.docx', mockClient(toVi)));
  assert.ok(!JP.test(o1.file('word/document.xml').asText()));

  const pptx = new PizZip();
  pptx.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>進捗報告</a:t></a:r></a:p></p:sld>');
  const o2 = new PizZip(await run(pptx.generate({ type: 'nodebuffer' }), '.pptx', mockClient(toVi)));
  assert.ok(!JP.test(o2.file('ppt/slides/slide1.xml').asText()));
});

test('API全滅: 「完了」を装わず例外で中断する', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`項目${i}の説明`]);
  await assert.rejects(run(makeXlsx(rows), '.xlsx', mockClient(toVi, { fail: { message: 'boom', status: 500 } })), /翻訳APIから結果が得られません/);
});

test('認証/残高エラーは即時中断する', async () => {
  const client = mockClient(toVi, { fail: { message: 'Your credit balance is too low', status: 400 } });
  await assert.rejects(run(makeXlsx([['テスト']]), '.xlsx', client), /credit balance/);
  assert.ok(client.calls.n <= 2);
});

test('原文をそのまま返すモデルは失敗として集計される', async () => {
  const ctx = S.newDocCtx({ tokens: { input: 0, output: 0 } });
  await run(makeXlsx([['原文のまま']]), '.xlsx', mockClient(t => t), ctx);
  assert.equal(ctx.stats.failed, ctx.stats.total);
});

test('人名が一部残る訳文は許容、原文同然は拒否', () => {
  assert.equal(S.isUntranslated('Maeda 前田 đang xử lý', '前田対応中'), false);
  assert.equal(S.isUntranslated('前田対応中', '前田対応中'), true);
  assert.equal(S.isUntranslated('前田対応です', '前田対応中'), true);
});

test('件数上限を超えたら実行前に明示エラー', async () => {
  const rows = Array.from({ length: 3001 }, (_, i) => [`項目${i}`]);
  const client = mockClient(toVi);
  await assert.rejects(run(makeXlsx(rows), '.xlsx', client), /上限/);
  assert.equal(client.calls.n, 0);
});
