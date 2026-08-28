// Hand-build a minimal valid single-page PDF (no dependencies).
import fs from 'node:fs';

const objs = [];
objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const stream = 'BT /F1 18 Tf 20 100 Td (PoC-7 test PDF) Tj ET';
objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

let pdf = '%PDF-1.4\n';
const offsets = [0];
for (let i = 1; i <= 5; i++) {
  offsets[i] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 6\n0000000000 65535 f \n`;
for (let i = 1; i <= 5; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

fs.writeFileSync('fixtures/test-doc.pdf', Buffer.from(pdf, 'latin1'));
console.log('wrote fixtures/test-doc.pdf', Buffer.byteLength(pdf, 'latin1'), 'bytes');
