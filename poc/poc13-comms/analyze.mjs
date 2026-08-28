// PoC-13 scratch — metrics + crude body-leak detector over stage2.jsonl.
import { readFileSync, writeFileSync } from 'node:fs';
const D = '/Users/mattcolf/Development/Metistry/.claude/worktrees/metistry-phase-0-poc-12cdbc/poc/poc13-comms';
const src = new Map();
for (const l of readFileSync(`${D}/messages-200.jsonl`, 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(l); src.set(o.rowid, o);
}
const rows = readFileSync(`${D}/stage2.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const words = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
const N = 7; // ">6 consecutive words" == a run of 7 or more

function maxSharedRun(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return 0;
  let best = 0;
  const prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    let diagPrev = 0;
    for (let j = 1; j <= B.length; j++) {
      const tmp = prev[j];
      prev[j] = A[i - 1] === B[j - 1] ? diagPrev + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diagPrev = tmp;
    }
  }
  return best;
}

let leaks = [], maxRunOverall = 0, runHist = {};
const digitRows = [], capRows = [];
const COMMON = new Set(['I','A','The','It','We','You','He','She','They','My','This','That','Get','Send','Check','Pick','Ask','Text','Call','Reply','Confirm','Buy','Pay','Plan','Go','Book','Make','Take','Order','Review','Schedule','Respond','Bring','Meet','Find','Watch','View','Sign','Add','Set','Read','Let','Look','Keep','Wait','Do','Be','Have','Use','Try','Turn','Give','Show','Open','Close','Follow','Update','Renew','Return','Share','Start','Finish','Attend','Arrange','Contact','Deliver','Drop','Drive','Email','Fill','Help','Join','Move','Pack','Post','Prepare','Print','Purchase','Put','Remind','Remove','Rent','Report','Save','Search','See','Select','Submit','Verify','Vote','Write','Charge','Choose','Clean','Complete','Coordinate','Decide','Download','Enter','Fix','Install','Log','Monitor','Notify','Pass','Pause','Pull','Push','Reach','Record','Register','Request','Reschedule','Reserve','Resolve','Restart','Run','Scan','Setup','Stop','Store','Switch','Track','Upload','Wear','Work','Bobcats']);

for (const r of rows) {
  const s = src.get(r.rowid);
  if (!s) continue;
  const combined = [r.action, r.entity, r.date_ref].filter(Boolean).join(' ');
  const run = maxSharedRun(combined, s.text);
  runHist[run] = (runHist[run] || 0) + 1;
  if (run > maxRunOverall) maxRunOverall = run;
  if (run >= N) leaks.push({ rowid: r.rowid, run, combinedLen: words(combined).length });
  if (/\d/.test(`${r.action} ${r.entity}`)) digitRows.push(r.rowid);
  const caps = `${r.action} ${r.entity}`.split(/\s+/).filter(w => /^[A-Z][a-z]{2,}$/.test(w) && !COMMON.has(w));
  if (caps.length) capRows.push({ rowid: r.rowid, caps });
}

const flagged = rows.filter(r => r.has_action === true);
const unflagged = rows.filter(r => r.has_action === false);
const byCat = {};
for (const r of rows) { byCat[r.category] ??= { n: 0, act: 0 }; byCat[r.category].n++; if (r.has_action) byCat[r.category].act++; }

// urgency / date_ref coverage on flagged
const urg = {}; let withDate = 0, withEntity = 0, dupActions = {};
for (const r of flagged) {
  urg[r.urgency] = (urg[r.urgency] || 0) + 1;
  if (r.date_ref) withDate++;
  if (r.entity) withEntity++;
  const k = (r.action || '').toLowerCase().trim();
  dupActions[k] = (dupActions[k] || 0) + 1;
}
const shortActions = flagged.filter(r => words(r.action).length <= 1).length;

console.log(JSON.stringify({
  rows: rows.length,
  errors: rows.filter(r => r.error).length,
  flagged: flagged.length, unflagged: unflagged.length,
  byCat,
  flaggedFromMe: flagged.filter(r => r.is_from_me).length,
  urgency: urg, flaggedWithDateRef: withDate, flaggedWithEntity: withEntity,
  flaggedOneWordAction: shortActions,
  repeatedActions: Object.entries(dupActions).filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, 12),
  leakDetector: { threshold: `${N}+ consecutive shared words`, rowsOverThreshold: leaks.length, maxSharedRunAnyRow: maxRunOverall, runHistogram: runHist, examples: leaks.slice(0, 5) },
  piiHeuristic: { rowsWithDigits: digitRows.length, rowsWithUncommonCapitalisedToken: capRows.length },
}, null, 1));

// side files for my own calibration read (stay on local disk)
writeFileSync(`${D}/_calib_flagged_actions.txt`,
  flagged.map(r => `${r.rowid}\t${r.category}\t${r.urgency}\tact=${r.action}\tent=${r.entity}\tdate=${r.date_ref}`).join('\n'));
writeFileSync(`${D}/_calib_caps.txt`, capRows.map(c => `${c.rowid}\t${c.caps.join(',')}`).join('\n'));
