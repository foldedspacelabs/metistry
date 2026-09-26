#!/usr/bin/env node
// Verify every board's declared frame is tall enough for its content (C67).
//
// A board declares $preview width/height and fills a fixed-size div, so content
// taller than the declaration spills past the frame the canvas lays out to —
// invisibly, because the ground colour matches. Seven of twelve boards were
// overflowing when this was first run, one by 1283px.
//
//   npm i playwright        # chromium only; no need for `playwright install`
//                           # if PW_EXEC points at an existing binary
//   PW_EXEC=/path/to/chrome node check-frames.mjs <canvas>/project/*.dc.html
//
// Fonts matter: the SANS/SERIF/MONO stacks are system faces, so alias them to
// metric-compatible ones (Liberation Sans, Bitstream Charter, Liberation Mono)
// in ~/.config/fontconfig/fonts.conf or every number comes back inflated.
//
// A board that fits reports scrollHeight exactly equal to its declared height;
// anything larger is the overflow in pixels. Raise CW,CH in the board module
// until every line reads `fits`.
import { chromium } from 'playwright';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: check-frames.mjs <project>/*.dc.html'); process.exit(2); }
const browser = await chromium.launch(process.env.PW_EXEC ? { executablePath: process.env.PW_EXEC } : {});
const page = await browser.newPage({ viewport: { width: 3000, height: 1200 } });
let bad = 0;
for (const f of files) {
  await page.goto('file://' + f);
  const { declared, scroll } = await page.evaluate(() => {
    const m = document.body.querySelector('script[data-dc-script]')?.dataset?.props;
    const h = m ? JSON.parse(m).$preview?.height : null;
    return { declared: h, scroll: document.documentElement.scrollHeight };
  });
  const name = f.split('/').pop();
  if (declared == null) { console.log(`${name.padEnd(24)} no $preview height`); continue; }
  const over = scroll - declared;
  if (over > 0) { bad++; console.log(`${name.padEnd(24)} OVERFLOWS by ${over}px (declared ${declared})`); }
  else console.log(`${name.padEnd(24)} fits (${declared})`);
}
await browser.close();
process.exit(bad ? 1 : 0);
