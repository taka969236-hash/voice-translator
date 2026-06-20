// Generates simple PNG icons using pure JS (no native modules)
// Creates a PNG with purple gradient background + white mic symbol
const fs = require('fs');
const path = require('path');

function writePNG(filename, size) {
  // Minimal PNG structure: IHDR + IDAT + IEND
  const { createHash } = require('crypto');
  const zlib = require('zlib');

  const width = size;
  const height = size;

  // Generate pixel data (RGBA)
  const pixels = Buffer.alloc(width * height * 4);

  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // Rounded rect mask
      const r = size * 0.188; // corner radius ~96/512
      const inRect = x >= r && x < width - r && y >= 0 && y < height;
      const inTop = y >= r && x >= 0 && x < width;
      const corner = (x < r && y < r && Math.hypot(x - r, y - r) > r) ||
                     (x >= width - r && y < r && Math.hypot(x - (width - r), y - r) > r) ||
                     (x < r && y >= height - r && Math.hypot(x - r, y - (height - r)) > r) ||
                     (x >= width - r && y >= height - r && Math.hypot(x - (width - r), y - (height - r)) > r);

      if (corner) {
        pixels[idx] = 0; pixels[idx+1] = 0; pixels[idx+2] = 0; pixels[idx+3] = 0;
        continue;
      }

      // Gradient: indigo top-left to darker indigo bottom-right
      const t = (x / width + y / height) / 2;
      const rC = Math.round(99 + (55 - 99) * t);   // 99→55
      const gC = Math.round(102 + (48 - 102) * t);  // 102→48
      const bC = Math.round(241 + (163 - 241) * t); // 241→163

      pixels[idx]   = rC;
      pixels[idx+1] = gC;
      pixels[idx+2] = bC;
      pixels[idx+3] = 255;

      // Draw mic body (rounded rect in center)
      const mw = size * 0.195, mh = size * 0.351, mr = size * 0.098;
      const ml = cx - mw / 2, mt = cy - mh * 0.65;
      if (x >= ml && x <= ml + mw && y >= mt && y <= mt + mh) {
        const cornerMic = (x < ml + mr && y < mt + mr && Math.hypot(x - (ml + mr), y - (mt + mr)) > mr) ||
                          (x > ml + mw - mr && y < mt + mr && Math.hypot(x - (ml + mw - mr), y - (mt + mr)) > mr) ||
                          (x < ml + mr && y > mt + mh - mr && Math.hypot(x - (ml + mr), y - (mt + mh - mr)) > mr) ||
                          (x > ml + mw - mr && y > mt + mh - mr && Math.hypot(x - (ml + mw - mr), y - (mt + mh - mr)) > mr);
        if (!cornerMic) {
          pixels[idx] = 255; pixels[idx+1] = 255; pixels[idx+2] = 255; pixels[idx+3] = 255;
        }
      }
    }
  }

  // Build PNG
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const b of buf) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcIn = Buffer.concat([typeB, data]);
    const crcB = Buffer.allocUnsafe(4); crcB.writeUInt32BE(crc32(crcIn));
    return Buffer.concat([len, typeB, data, crcB]);
  }

  // IHDR
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // IDAT: filter byte (0) + row data, then deflate
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(0); // filter type None
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rows.push(pixels[idx], pixels[idx+1], pixels[idx+2], pixels[idx+3]);
    }
  }
  const rawRows = Buffer.from(rows);
  const compressed = zlib.deflateSync(rawRows, { level: 9 });

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(filename, png);
  console.log(`✅ Generated: ${path.basename(filename)} (${size}x${size})`);
}

const iconsDir = path.join(__dirname, 'public', 'icons');
writePNG(path.join(iconsDir, 'icon-192.png'), 192);
writePNG(path.join(iconsDir, 'icon-512.png'), 512);
console.log('アイコン生成完了');
