'use strict';
const zlib = require('node:zlib');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([header, typeBuffer, data, crc]);
}

// A self-contained PNG stays reliable in the Windows notification area.
module.exports = function createTrayPng() {
  const width = 32; const height = 32;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  const colors = [[91, 206, 250], [245, 169, 184], [255, 255, 255], [245, 169, 184], [91, 206, 250]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const body = ((x - 14) / 12) ** 2 + ((y - 17) / 9) ** 2 < 1;
      const tail = x >= 24 && x <= 30 && Math.abs(y - 17) <= (x - 23) * 0.9;
      const fin = y >= 4 && y <= 12 && x >= 12 && x <= 12 + (y - 4) * 0.8;
      if (!body && !tail && !fin) continue;
      let rgb = colors[Math.min(4, Math.max(0, Math.floor((y - 8) / 4)))];
      if ((x - 8) ** 2 + (y - 16) ** 2 < 3 || (x >= 7 && x <= 11 && y === 21)) rgb = [34, 67, 85];
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      rows.set([...rgb, 255], offset);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};
