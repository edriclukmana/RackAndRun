// Plays full computer-vs-computer games with the real game logic from www/index.html
// and checks every move against the rules. Run with: npm test
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
const logic = html.split('/* LOGIC START */')[1].split('/* LOGIC END */')[0];
const L = new Function(logic + ';return {TILES,analyze,planAI};')();
const { TILES, analyze, planAI } = L;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; } return a; };
function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

function game(skills) {
  const deck = shuffle(TILES.map(t => t.id));
  const P = skills.map(d => ({ d, rack: deck.splice(0, 14), melded: false }));
  let pool = deck, table = [], cur = 0, passes = 0, slowest = 0;
  for (let turn = 0; turn < 1500; turn++) {
    const p = P[cur], t0 = Date.now();
    const mv = planAI(table, p.rack, p.melded, p.d);
    slowest = Math.max(slowest, Date.now() - t0);
    if (mv) {
      const before = new Set([...table.flat(), ...p.rack]), after = new Set([...mv.table.flat(), ...mv.rack]);
      if (before.size !== after.size || [...before].some(x => !after.has(x))) fail('tiles appeared or vanished');
      const nowOnTable = new Set(mv.table.flat());
      for (const x of table.flat()) if (!nowOnTable.has(x)) fail('a table tile went back to a rack');
      for (const s of mv.table) if (!analyze(s).valid) fail('invalid set ' + JSON.stringify(s));
      if (!mv.played.length) fail('a move played no tiles');
      if (!p.melded) {
        if (mv.meldValue < 30) fail('opening under 30');
        table.forEach((s, i) => { if (JSON.stringify(s) !== JSON.stringify(mv.table[i])) fail('opening touched the table'); });
      }
      table = mv.table; p.rack = mv.rack; p.melded = true; passes = 0;
      if (!p.rack.length) return { winner: cur, slowest };
    } else if (pool.length) p.rack.push(pool.pop());
    else if (++passes >= P.length) return { winner: -1, slowest };
    cur = (cur + 1) % P.length;
  }
  fail('game did not finish');
}

// A few known manipulations from the official rules sheet.
const C = { r: 0, b: 1, o: 2, k: 3 }, used = new Set();
const id = s => { if (s === 'J') { const j = used.has(104) ? 105 : 104; used.add(j); return j; } let n = C[s[0]] * 13 + (+s.slice(1)) - 1; if (used.has(n)) n += 52; used.add(n); return n; };
function expectAllPlayed(name, tableStr, rackStr) {
  used.clear();
  const table = tableStr.map(s => s.split(' ').map(id)), rack = rackStr.split(' ').map(id);
  const mv = planAI(table, rack, true, 'hard');
  if (!mv || mv.rack.length) fail(name + ': expected every rack tile to be played');
}
expectAllPlayed('split a run', ['r4 r5 r6 r7 r8'], 'r6');
expectAllPlayed('multiple split', ['b5 b6 b7', 'r5 r6 r7', 'k5 k6 k7 k8 k9'], 'k10 o5');
expectAllPlayed('free a joker', ['b5 J b7'], 'b6 r1 o1 k1');

let slowest = 0, games = 0;
for (const skills of [['hard', 'hard', 'hard', 'hard'], ['easy', 'normal', 'hard'], ['normal', 'normal']]) {
  for (let g = 0; g < 6; g++) { const r = game(skills); slowest = Math.max(slowest, r.slowest); games++; }
}
console.log(`ok: ${games} games played legally, 3 rule-sheet examples solved, slowest move ${slowest} ms`);
