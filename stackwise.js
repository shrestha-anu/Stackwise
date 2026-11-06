// ─────────────────────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────────────────────
// Loaded from stackwise-data.js (or stackwise-data.json as a fallback) at startup (see INIT).
// LOYALTY_PROGRAMS: fixed cents-per-point values for co-brand currencies (not adjustable by the user's slider).
let CATS, CAT_COLORS, LOYALTY_PROGRAMS, ISSUER_NAMES, CARDS, VALUATION;

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let owned = new Set(); // filled from cards marked owned:true once data loads
// Monthly spend keyed by spend line (see buildSpendLines); missing keys count as 0. Starts with a
// sample profile ($4,700/month) that goes with the sample wallet (cards marked owned:true in the
// data), so the Optimizer shows results right away. Merch_ keys are store rows those cards add.
let spend = {
  Dining: 500,
  Sub_Grocery_Supermarkets: 200, Merch_Whole_Foods: 600, Sub_Grocery_Online_grocery: 200, Sub_Grocery_Wholesale_clubs: 600,
  TravelFlights: 500, TravelHotels: 400, TravelCars: 100,
  Gas: 400,
  Streaming: 100,
  Sub_Shopping_Online_shopping: 200, Merch_Amazon___Audible: 300, 'Sub_Shopping_In_store___other': 200,
  Other: 400
};
// Ways to redeem bank points, one valuation table column each. Airline and hotel points have one
// set value each (LOYALTY_PROGRAMS), so there's nothing to choose for them.
const REDEEM_STYLES = { sc:'cash back', portal:'bank travel portal', transfer:'transfer partners' };
// "bank travel portal" → "Bank Travel Portal", for the redemption dropdowns
const titleCase = s => s.replace(/\b\w/g, ch => ch.toUpperCase());

// How the user redeems each points currency (a valuation table column): { program: 'sc' | 'portal' | 'transfer' }.
// Starts with choices for the sample wallet's currencies. A currency added later has no choice, and
// the Optimizer waits until every currency in the wallet has one.
let redeemByProgram = { ur: 'portal', mr: 'portal' };
// Only for valuing cards outside the wallet in "Cards that would earn you more" when their
// currency hasn't been chosen.
const UNCHOSEN_STYLE = 'transfer';

// Cash back cards whose rewards move into a points currency when the wallet has a card that earns
// it, e.g. Freedom Unlimited points into a Sapphire's Ultimate Rewards balance. Anchors are listed
// best first; the first one in the wallet is named.
const POOLS = [
  { program: 'ur', joiners: ['Chase Freedom Unlimited', 'Chase Freedom Flex'], anchors: ['Chase Sapphire Reserve', 'Chase Sapphire Preferred'] },
  { program: 'thankyou', joiners: ['Citi Double Cash'], anchors: ['Citi Strata Elite', 'Citi Strata Premier'] },
  { program: 'capone', joiners: ['Capital One Quicksilver', 'Capital One QuicksilverOne', 'Capital One Savor', 'Capital One SavorOne'],
    anchors: ['Capital One Venture X', 'Capital One Venture', 'Capital One VentureOne'] }
];

// The currency a card's rewards end up in: its own program, or a pooled one (and the card that allows it).
function cardProgram(card) {
  const pool = POOLS.find(p => p.joiners.includes(card.name));
  const anchor = pool && pool.anchors.find(name => owned.has(name));
  return anchor ? { program: pool.program, via: anchor } : { program: card.program };
}

function styleLabel(row, style) { return REDEEM_STYLES[style]; }

// The valuation row for a points currency. Some currencies have one row per group of cards (e.g.
// Chase Ultimate Rewards transfer at 1.8¢ with a Sapphire Reserve, 1.4¢ with a Sapphire Preferred),
// listed best first. Points in one balance can be redeemed through the best card that holds it, so
// the first row matching the given cards or any wallet card wins. A row without `cards` matches any.
function valuationRow(program, names = []) {
  const rows = VALUATION.filter(v => v.program === program);
  if (!rows.length) return null;
  const have = new Set([...names, ...owned]);
  return rows.find(v => !v.cards || v.cards.some(n => have.has(n))) || rows[rows.length - 1];
}

// Dollar value of one point earned on a card, for how its currency is redeemed.
//  - Cards whose rewards pool into a points currency (see POOLS): that currency's value.
//  - Cash back cards: fixed 1¢.
//  - Cards whose program has a row in the valuation table: that row's value (see valuationRow) for
//    the style chosen in redeemByProgram. `pending` is true until a style is chosen; the value is
//    then UNCHOSEN_STYLE's, used only for suggesting cards outside the wallet.
//  - Airline, hotel and other co-brand programs: the fixed value in LOYALTY_PROGRAMS.
function cardCpp(card) {
  if (!card) return { cpp: 0.01, label: 'cash back, fixed' };
  const { program, via } = card.name ? cardProgram(card) : { program: card.program };
  if (card.currency === 'cash' && program === card.program) return { cpp: 0.01, label: 'cash back, fixed' };
  const row = valuationRow(program, [card.name, via].filter(Boolean));
  if (row) {
    const chosen = redeemByProgram[program];
    let style = chosen || UNCHOSEN_STYLE;
    if (row[style] == null) {
      style = Object.keys(REDEEM_STYLES).filter(k => row[k] != null).sort((a, b) => row[b] - row[a])[0];
    }
    return { cpp: row[style] / 100, label: `${row.name}, ${styleLabel(row, style)}`, style, program, row, pending: !chosen };
  }
  const prog = LOYALTY_PROGRAMS[card.program];
  if (prog) return { cpp: prog.cpp, label: `${prog.label}, fixed` };
  return { cpp: 0.01, label: 'no valuation, 1¢ assumed' };
}

function fmtCpp(cpp) { return `${+(cpp * 100).toFixed(2)}¢/pt`; }

// Names of the points currencies among these cards that don't have a redemption choice yet.
function pendingCurrencies(cards) {
  const programs = new Set(cards.map(cardCpp).filter(v => v.pending).map(v => v.program));
  return [...new Set(VALUATION.filter(v => programs.has(v.program)).map(v => v.name))];
}
let cardSpend = {}; // { cardName: { Dining: 0, Grocery: 0, ... } }

// ─────────────────────────────────────────────────────────────
// SPEND LINES
// ─────────────────────────────────────────────────────────────
// Both tabs use the same breakdown:
//  - Travel is split into Flights / Hotels / Cars. How to book (direct or through a bank travel
//    site) isn't an input: the Optimizer works out the better way for each type (see travelOptions).
//  - Categories listed in SUB_CATEGORIES (e.g. Grocery, Shopping) are split by type of store.
//  - A card's home-merchant rates (card.merchantRates, e.g. Prime Visa at Amazon) add a row for
//    that merchant under its parent line, only for the cards passed in (the wallet, or one card).
const TRAVEL_TYPES = ['Flights','Hotels','Cars'];
// What each travel type is called on screen. "Cars" stays the key in the data and saved spend.
const TRAVEL_LABELS = { Flights: 'Flights', Hotels: 'Hotels', Cars: 'Car rentals' };
const CHANNELS = ['direct', 'portal'];
let SUB_CATEGORIES = {}; // { Grocery: [{ name, defaultsTo? }, ...] } from data
let SPEND_LINES = [];    // Optimizer lines, rebuilt whenever the wallet changes

function subKey(cat, label) { return 'Sub_' + cat + '_' + label.replace(/[^a-zA-Z0-9]/g, '_'); }
function merchKey(merchant) { return 'Merch_' + merchant.replace(/[^a-zA-Z0-9]/g, '_'); }

// Merchant rows the given cards add under one line (path is "Category" or "Category/Sub-type").
// Each row copies the parent line's fields, so cards without that merchant earn the parent's rate.
function merchantLines(path, parent, cards) {
  const lines = [];
  cards.forEach(c => (c.merchantRates || []).forEach(m => {
    if (m.line !== path || lines.some(l => l.merchant === m.merchant)) return;
    lines.push({ ...parent, key:merchKey(m.merchant), merchant:m.merchant, label:`${parent.cat} — ${m.merchant}` });
  }));
  return lines;
}

// Lines for one non-travel category, with merchant rows for the given cards' home merchants.
// Merchant rows come first; the line they belong to follows as "All other …".
function categoryLines(cat, cards) {
  const subs = SUB_CATEGORIES[cat];
  const baseLines = subs
    ? subs.map(s => ({ key:subKey(cat, s.name), cat, sub:s.name, label:`${cat} — ${s.name}` }))
    : [{ key:cat, cat, label:cat }];
  return baseLines.flatMap(line => [...merchantLines(line.sub ? `${cat}/${line.sub}` : cat, line, cards), line]);
}

// Travel lines: Flights / Hotels / Cars, each after the brand rows split out of it (e.g. Hilton
// hotels, then All other hotels), then brand rows that aren't one travel type (e.g. cruise lines).
// `splits` is the set of brands split out: splitBrands on the Optimizer, one card's set on Card utilization.
function travelLines(cards, splits = splitBrands) {
  const lines = TRAVEL_TYPES.flatMap(t => {
    const line = { key:'Travel' + t, cat:'Travel', label:`Travel — ${TRAVEL_LABELS[t]}`, travelType:t };
    return [...merchantLines(`Travel/${t}`, line, cards).filter(l => splits.has(l.merchant)), line];
  });
  return [...lines, ...merchantLines('Travel', { cat:'Travel' }, cards)];
}

// ── Airline and hotel brands: grey line and split out ──────────────────────────────────────
// Airline and hotel brands (on Flights / Hotels) don't get a Monthly spend row of their own. Under the
// travel type's card, a grey line says what the brand's card earns there when it beats your other
// cards ("At Marriott hotels: 6x @ 0.7¢ with … · Split out"), or which card is still best. "Split out"
// adds the brand row with a small amount box; what goes in it is taken out of the travel type.
const splitBrands = new Set(); // Optimizer: merchant names split out of their travel type
const utilSplits = {};         // Card utilization: card name → Set of merchant names
const utilSplitSet = name => utilSplits[name] || (utilSplits[name] = new Set());

// Brands on a travel type that the given cards have but that aren't split out
function brandNoteLines(line, cards, splits = splitBrands) {
  if (!line.travelType || line.merchant) return [];
  return merchantLines(`Travel/${line.travelType}`, line, cards).filter(l => !splits.has(l.merchant));
}
// What each card earns per $1 at a brand, best first (a tie goes to the brand's own card)
function brandRanking(brandLine, cards) {
  return cards.map(c => {
    const o = bestTravelOption(c, brandLine);
    return { card: c, rate: o.rate, value: o.rate * cardCpp(c).cpp, brand: !!merchantRate(c, brandLine) };
  }).filter(x => x.rate > 0).sort((a, b) => b.value - a.value || b.brand - a.brand);
}
// The grey line. `self` (Card utilization) is the card under review, named "this card".
function brandNote(brandLine, cards, attrs = '', self = null) {
  const rank = brandRanking(brandLine, cards);
  const mine = rank.find(x => x.brand);
  if (!mine) return '';
  const name = c => c === self ? 'this card' : c.name;
  const where = shortLabel(brandLine);
  if (rank[0] === mine) {
    return `<span class="other-way brand-way">At ${where}: ${mine.rate}x @ ${+(cardCpp(mine.card).cpp * 100).toFixed(2)}¢ with ${name(mine.card)} · <button type="button" class="brand-split" data-brand="${brandLine.merchant}" ${attrs}>Split out</button></span>`;
  }
  return `<span class="other-way brand-way">At ${where}: ${name(rank[0].card)} is still best</span>`;
}

// Move a brand's amount back into its travel type
function foldBack(brand, travelType, store) {
  const key = merchKey(brand), parent = 'Travel' + travelType;
  store[parent] = (store[parent] || 0) + (store[key] || 0);
  delete store[key];
}
// Set a brand's amount. The change comes out of (or goes back to) its travel type's "All other" amount,
// which never goes below $0. There's no cap: past what All other holds, the travel total grows.
function setBrandAmount(line, value, store) {
  const parent = 'Travel' + line.travelType;
  const x = Math.max(0, value), change = x - (store[line.key] || 0);
  store[line.key] = x; store[parent] = Math.max(0, (store[parent] || 0) - change);
  return x;
}

document.addEventListener('click', e => {
  const split = e.target.closest('.brand-split'), undo = e.target.closest('.brand-unsplit');
  if (!split && !undo) return;
  const btn = split || undo, brand = btn.dataset.brand, key = merchKey(brand), card = btn.dataset.card;
  if (card) { // Card utilization
    const cs = cardSpend[card] = cardSpend[card] || {};
    if (split) { utilSplitSet(card).add(brand); cs[key] = 0; }
    else { utilSplitSet(card).delete(brand); foldBack(brand, btn.dataset.type, cs); }
    renderUtilCards();
    const input = split && document.querySelector(`.util-spend-input[data-card="${card}"][data-cat="${key}"]`);
    if (input) { input.focus(); input.select(); }
    return;
  }
  if (split) { splitBrands.add(brand); spend[key] = 0; }
  else { splitBrands.delete(brand); foldBack(brand, btn.dataset.type, spend); }
  refreshSpendLines(); recalc();
  const input = split && document.getElementById('opt-split-' + key);
  if (input) { input.focus(); input.select(); }
});
// The amount boxes in Points earned per category (a split-out brand and its "All other" row). Monthly
// spend is redrawn to match. The table is redrawn as you type, so focus comes back.
document.addEventListener('input', e => {
  const input = e.target.closest('.split-input');
  if (!input) return;
  const line = SPEND_LINES.find(l => l.key === input.dataset.key);
  const v = parseInt(input.value.replace(/[^0-9]/g, '')) || 0;
  if (line.merchant) setBrandAmount(line, v, spend);
  else spend[line.key] = v;
  buildSpend(); recalc();
  const again = document.getElementById(input.id);
  if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
});
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// All spend lines for the given cards (the wallet in the Optimizer, one card in Card utilization).
function buildSpendLines(cards = CARDS.filter(c => owned.has(c.name)), splits = splitBrands) {
  return CATS.flatMap(cat => cat === 'Travel' ? travelLines(cards, splits) : categoryLines(cat, cards));
}

function merchantRate(c, line) {
  return line.merchant ? (c.merchantRates || []).find(x => x.merchant === line.merchant) : undefined;
}

// Ways to book a travel line with a card: always direct, plus the card's travel site if it has one.
// On a brand row (e.g. Hilton), the brand's own card earns its brand rate when booking direct.
function travelOptions(c, line) {
  const brand = merchantRate(c, line);
  const t = line.travelType;
  const direct = brand ? brand.rate : (c.travelSplit ? c.travelSplit[t] : (c.rates.Travel ?? 1));
  const opts = [{ channel:'direct', rate:direct, label:brand ? `${line.merchant} direct` : 'Book direct' }];
  if (c.portalRate && c.portalLabel && c.portalLabel !== 'Direct only') {
    const p = typeof c.portalRate === 'object' ? c.portalRate[t] : c.portalRate;
    opts.push({ channel:'portal', rate:p !== undefined ? p : (c.travelSplit ? c.travelSplit[t] : direct), label:c.portalLabel });
  }
  return opts;
}

// The better way to book with this card; a tie goes to direct (it keeps airline/hotel loyalty perks).
function bestTravelOption(c, line) {
  return travelOptions(c, line).reduce((a, b) => b.rate > a.rate ? b : a);
}

// Rate a card earns on a spend line. Used by both tabs.
// Travel lines with a `channel` ('direct' | 'portal') use that way of booking only (0 if the card
// has no travel site); without one, the card's better way of booking.
function lineRate(c, line) {
  const base = c.rates[line.cat] ?? 1;
  if (line.travelType) {
    if (!line.channel) return bestTravelOption(c, line).rate;
    const opt = travelOptions(c, line).find(o => o.channel === line.channel);
    return opt ? opt.rate : 0;
  }
  const m = merchantRate(c, line);
  if (m) return m.rate;
  // No home-merchant rate on this card: it earns its normal rate for the parent line.
  // Brand travel that isn't one travel type (e.g. a cruise) earns a card's general direct travel rate,
  // so a bonus on only some types (e.g. Amex Platinum's 5X on flights) doesn't count: use the lowest.
  if (line.cat === 'Travel') return c.travelSplit ? Math.min(...TRAVEL_TYPES.map(t => c.travelSplit[t])) : base;
  if (!line.sub) return base;
  const subs = c.subRates && c.subRates[line.cat];
  if (subs && subs[line.sub] !== undefined) return subs[line.sub];
  const def = (SUB_CATEGORIES[line.cat] || []).find(s => s.name === line.sub);
  return def && def.defaultsTo ? (c.rates[def.defaultsTo] ?? 1) : base;
}

// Rebuild the Optimizer's lines and spend panel (merchant rows depend on the wallet).
// Rows a newly added card brings flash briefly; rows that leave with a removed card and still
// have spend get a note in their tile (the amount is kept, and comes back if the card does).
let freshKeys = new Set();
const removedRows = new Map(); // line key → line
function refreshSpendLines() {
  const before = SPEND_LINES;
  SPEND_LINES = buildSpendLines();
  // A split-out brand whose card left the wallet goes back into its travel type
  before.filter(l => l.merchant && l.travelType && !SPEND_LINES.some(n => n.key === l.key))
    .forEach(l => { foldBack(l.merchant, l.travelType, spend); splitBrands.delete(l.merchant); });
  const keys = new Set(SPEND_LINES.map(l => l.key));
  freshKeys = new Set(SPEND_LINES.filter(l => !before.some(b => b.key === l.key)).map(l => l.key));
  before.filter(l => !keys.has(l.key) && spend[l.key]).forEach(l => removedRows.set(l.key, l));
  keys.forEach(k => removedRows.delete(k));
  buildSpend();
  freshKeys = new Set();
}

// ─────────────────────────────────────────────────────────────
// BUILD UI
// ─────────────────────────────────────────────────────────────
function buildWallet() {
  renderWalletChips();
  renderUtilCards();
  renderRedeemList();
  renderNewRowsNote();
}

// Rows a just-added card brought into Monthly spend: [{ card, lines }]. Shown as a notice under the
// add box and a "New" tag on each row, until the user fills the row in or clicks "Got it".
let newRowNotes = [];
const newRowKeys = () => new Set(newRowNotes.flatMap(n => n.lines.map(l => l.key)));

// Where a row sits, e.g. "Travel → Hotels"
function rowParent(line) {
  return [line.cat, line.sub || line.travelType].filter(Boolean).join(' → ');
}

function renderNewRowsNote() {
  const el = document.getElementById('new-rows-note');
  if (!newRowNotes.length) { el.innerHTML = ''; return; }
  const list = items => items.length > 1 ? items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1] : items[0];
  el.innerHTML = `<div class="new-rows-note">
    <p class="new-rows-title">New rows in Monthly spend</p>
    ${newRowNotes.map(n => `<p>${cardDot(n.card)}<strong>${n.card.name}</strong> added ${list(n.lines.map(l =>
      `<b>${l.merchant || shortLabel(l)}</b> under ${rowParent(l)}`))}.</p>`).join('')}
    <div class="new-rows-actions">
      <button type="button" class="new-rows-show">Show me</button>
      <button type="button" class="new-rows-dismiss">Got it</button>
    </div>
  </div>`;
  el.querySelector('.new-rows-show').onclick = () => {
    const first = document.getElementById('spend-' + newRowNotes[0].lines[0].key);
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    first.focus({ preventScroll: true });
  };
  el.querySelector('.new-rows-dismiss').onclick = () => { newRowNotes = []; renderNewRowsNote(); buildSpend(); };
}

// "How you redeem points": one dropdown per points currency on the current tab's cards (the wallet
// on the Optimizer, the cards under review on Card utilization), with only the ways that currency
// can be redeemed and their value, starting at "Select One"; then the fixed-value cards as plain text.
// Choices are shared, so a currency picked on one tab is already picked on the other.
// An "i" button that opens a small note; closes on a second click, a click elsewhere or Escape.
function initInfoButton(btnId, popId) {
  const btn = document.getElementById(btnId), pop = document.getElementById(popId);
  const set = open => { pop.hidden = !open; btn.setAttribute('aria-expanded', open); };
  btn.addEventListener('click', () => set(pop.hidden));
  document.addEventListener('mousedown', e => { if (!btn.contains(e.target) && !pop.contains(e.target)) set(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { set(false); btn.focus(); } });
}

// How a fixed-value card's rewards are redeemed, shown under its name: cash back cards (and co-brand
// cards whose rewards can be taken as cash, e.g. Prime Visa) or the loyalty program it earns.
const CASH_LIKE_PROGRAMS = ['amazon', 'costco', 'doordash', 'instacart'];
function redeemKind(c) {
  if (c.currency !== 'cobrand' || CASH_LIKE_PROGRAMS.includes(c.program)) return 'Cash back';
  const p = LOYALTY_PROGRAMS[c.program];
  return 'Loyalty program' + (p ? ' · ' + p.label : '');
}

function renderRedeemList() {
  const el = document.getElementById('redeem-list');
  const onUtil = document.querySelector('.main').classList.contains('tab-utilization');
  const cards = [...(onUtil ? cardsUnderReview : owned)].map(name => CARDS.find(c => c.name === name)).filter(Boolean);
  const dot = c => owned.has(c.name) ? cardDot(c) : ''; // wallet colors only
  const currencies = new Map(); // program → { cards: [{ card, via }] }
  const fixed = [];
  cards.forEach(c => {
    const { program, via } = cardProgram(c);
    const hasRow = !(c.currency === 'cash' && program === c.program) && VALUATION.some(v => v.program === program);
    if (!hasRow) { fixed.push(c); return; }
    if (!currencies.has(program)) currencies.set(program, { cards: [] });
    currencies.get(program).cards.push({ card: c, via });
  });
  el.innerHTML = [...currencies].map(([program, { cards }]) => {
    // The values for the best card holding this currency (e.g. Sapphire Reserve over Preferred)
    const row = valuationRow(program, cards.flatMap(({ card, via }) => [card.name, via]).filter(Boolean));
    const current = redeemByProgram[program];
    const keys = Object.keys(REDEEM_STYLES).filter(k => row[k] != null);
    const options = (current ? '' : '<option value="" selected disabled>Select One</option>') + keys.map(k => {
      return `<option value="${k}" ${k === current ? 'selected' : ''}>${titleCase(styleLabel(row, k))} · ${row[k].toFixed(2)}¢</option>`;
    }).join('');
    const who = cards.map(({ card, via }) => dot(card) + card.name +
      (via ? ` <span class="redeem-via">(moves to ${row.name} with your ${via.replace(/^(Chase|Citi|Capital One) /, '')})</span>` : '')).join('<br>');
    return `<div class="redeem-item">
      <label for="redeem-${program}">${row.name}</label>
      <div class="redeem-cards">${who}</div>
      <select id="redeem-${program}" data-program="${program}" class="${current ? '' : 'unset'}">${options}</select>
    </div>`;
  }).join('') + (fixed.length ? `<div class="redeem-fixed">
      <div class="redeem-fixed-title">Fixed value</div>
      ${fixed.map(c => `<div class="redeem-fixed-row"><span>${dot(c)}${c.name}<span class="redeem-kind">${redeemKind(c)}</span></span><span>${fmtCpp(cardCpp(c).cpp)}</span></div>`).join('')}
    </div>` : '');
  el.querySelectorAll('select').forEach(sel => sel.addEventListener('change', function() {
    redeemByProgram[this.dataset.program] = this.value;
    this.classList.remove('unset');
    recalc();
    renderUtilCards();
  }));
}

// Typeable card box (the wallet's "+ Add a card" and Card utilization's "+ Review a card"): type part
// of a card or bank name to filter, or open the full list. ↑/↓ move, Enter picks, Esc closes.
// `exclude(card)` hides cards already picked; `onPick(card)` handles the choice.
function initCardPicker(pickerId, { exclude, onPick }) {
  const picker = document.getElementById(pickerId);
  const input = picker.querySelector('input');
  const list = picker.querySelector('ul');
  let matches = [], active = -1;

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escHtml = s => s.replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
  const issuerName = c => ISSUER_NAMES[c.issuer] || c.issuer;

  function render() {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Closest matches first when typing (every word starts a word in the name, then shorter names),
    // so "gold" puts Amex Gold ahead of Delta SkyMiles Gold. The list stays grouped by bank, with
    // banks in order of their best match; with nothing typed it's alphabetical.
    const text = c => `${c.name} ${issuerName(c)}`.toLowerCase();
    const score = c => words.every(w => new RegExp(`(^|[^a-z0-9])${escRe(w)}`).test(text(c))) ? 0 : 1;
    // Typing only a bank name (e.g. "chase") just narrows to that bank, so keep it alphabetical
    const bankOnly = c => words.every(w => issuerName(c).toLowerCase().includes(w));
    const ranked = CARDS
      .filter(c => !exclude(c))
      .filter(c => words.every(w => text(c).includes(w)))
      .sort((a, b) => words.length && !(bankOnly(a) && bankOnly(b))
        ? score(a) - score(b) || a.name.length - b.name.length || a.name.localeCompare(b.name)
        : issuerName(a).localeCompare(issuerName(b)) || a.name.localeCompare(b.name));
    const issuers = [...new Set(ranked.map(issuerName))];
    matches = issuers.flatMap(name => ranked.filter(c => issuerName(c) === name));
    const mark = name => words.length ? name.replace(new RegExp(`(${words.map(escRe).join('|')})`, 'gi'), '<mark>$1</mark>') : name;
    let lastIssuer = null;
    list.innerHTML = matches.length ? matches.map((c, i) => {
      const head = issuerName(c) !== lastIssuer ? `<li class="card-picker-group" role="presentation">${issuerName(c)}</li>` : '';
      lastIssuer = issuerName(c);
      return `${head}<li class="card-picker-option" role="option" id="${pickerId}-opt-${i}" data-i="${i}" aria-selected="false">
        <span>${mark(c.name)}</span><span class="fee">$${c.fee}/yr</span></li>`;
    }).join('') : `<li class="card-picker-empty" role="presentation">No cards match “${escHtml(input.value.trim())}”</li>`;
    setActive(matches.length ? 0 : -1);
  }

  function setActive(i) {
    active = i;
    list.querySelectorAll('.card-picker-option').forEach(li => {
      const on = +li.dataset.i === i;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', on);
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) input.setAttribute('aria-activedescendant', `${pickerId}-opt-${i}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function open() { render(); list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
  function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }

  function add(card) {
    input.value = '';
    close();
    onPick(card);
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return open();
      if (matches.length) setActive((active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && matches[active]) add(matches[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  picker.querySelector('.card-picker-toggle').addEventListener('click', () => {
    if (list.hidden) { input.focus(); open(); } else close();
  });
  // mousedown (not click) so the input keeps focus and the list doesn't close first
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('.card-picker-option');
    if (!li) return;
    e.preventDefault();
    add(matches[+li.dataset.i]);
  });
  list.addEventListener('mousemove', e => {
    const li = e.target.closest('.card-picker-option');
    if (li && +li.dataset.i !== active) setActive(+li.dataset.i);
  });
  document.addEventListener('mousedown', e => { if (!picker.contains(e.target)) close(); });
}

// Each wallet card gets a color, in the order it was added, shown as a dot next to its name
// everywhere. Avoids the page's blue (good), orange (warning) and any reds. Repeats after 6 cards;
// the name is always shown, so nothing depends on color alone.
const CARD_COLORS = ['#B8860B', '#0B7A54', '#7A3FD1', '#0E8A9E', '#0B0B0F', '#6B7A99'];
function cardColor(c) { return CARD_COLORS[Math.max(0, [...owned].indexOf(c.name)) % CARD_COLORS.length]; }
function cardDot(c) { return `<span class="card-dot" style="background:${cardColor(c)}" aria-hidden="true"></span>`; }

const X_ICON =`<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"></path></svg>`;

function renderWalletChips() {
  const el = document.getElementById('wallet-chips');
  el.innerHTML = '';
  CARDS.filter(c => owned.has(c.name)).forEach(c => {
    const row = document.createElement('div');
    row.className = 'wallet-row';
    row.title = c.note;
    row.innerHTML = `<div class="wallet-row-name"><span>${cardDot(c)}${c.name}</span><span class="wallet-row-fee">$${c.fee}/yr</span></div>
      <button type="button" class="remove-btn" aria-label="Remove ${c.name}">${X_ICON}</button>`;
    row.querySelector('.remove-btn').onclick = () => {
      owned.delete(c.name);
      newRowNotes = newRowNotes.filter(n => n.card !== c);
      buildWallet();
      refreshSpendLines();
      recalc();
    };
    el.appendChild(row);
  });
  document.getElementById('owned-count').textContent = owned.size + ' card' + (owned.size !== 1 ? 's' : '');
}


// Does this line have brand rows from the wallet's cards next to it (e.g. Hilton next to Hotels)?
// Then it covers the rest of that spend.
function hasBrandRows(line) {
  return !line.merchant && SPEND_LINES.some(l => l.merchant && l.cat === line.cat && l.sub === line.sub && l.travelType === line.travelType);
}

// How far a line is indented under its category: 0 for the category itself, 1 for everything inside
// a category (store and travel types, and merchant or brand rows, which sit level with their type).
function lineLevel(line) {
  if (!line.merchant) return line.sub || line.travelType || hasBrandRows(line) ? 1 : 0;
  return 1;
}
// A brand row on a travel type names the type too ("Delta flights", "Hilton hotels"); store
// merchants (Whole Foods, Amazon) already say what they are.
function shortLabel(line) {
  if (line.merchant) return line.travelType ? `${line.merchant} ${line.travelType.toLowerCase()}` : line.merchant;
  return line.sub || TRAVEL_LABELS[line.travelType] || line.cat;
}
// Label in Monthly spend and the Optimizer table: a line with brand rows next to it covers the
// rest, e.g. "All other gas", "All other hotels", "All other wholesale clubs".
function rowLabel(line) {
  return hasBrandRows(line) ? `All other ${shortLabel(line).toLowerCase()}` : shortLabel(line);
}

// Lines grouped by category, in category order. A category split into types (e.g. Grocery, Travel)
// has no line of its own, so it gets a heading.
function groupLines(lines) {
  return CATS.map(cat => {
    const catLines = lines.filter(l => l.cat === cat);
    return { cat, lines: catLines, heading: !catLines.some(l => lineLevel(l) === 0) };
  }).filter(g => g.lines.length);
}

// Monthly spend as tiles, one per category, in three fixed columns (SPEND_COLUMNS, top to bottom;
// a category not listed goes in the last one). A category with no types or brand rows is a single input in the
// tile's heading; otherwise its rows sit inside the tile with the category total. Brand rows carry
// the dot of the wallet card that adds them.
const SPEND_COLUMNS = [['Dining', 'Grocery', 'Gas'], ['Travel'], ['Streaming', 'Shopping', 'Other']];
function buildSpend() {
  const el = document.getElementById('spend-panel');
  const walletCards = CARDS.filter(c => owned.has(c.name));
  const dots = line => line.merchant ? walletCards.filter(c => merchantRate(c, line)).map(cardDot).join('') : '';
  const field = line => `<input id="spend-${line.key}" type="number" value="${spend[line.key] || 0}" min="0" step="50" data-cat="${line.key}" aria-label="${line.label}">`;
  const isNew = newRowKeys();
  const row = (line, label) => `
    <div class="spend-item lvl-${lineLevel(line)}${freshKeys.has(line.key) ? ' fresh' : ''}${isNew.has(line.key) ? ' is-new' : ''}">
      <label for="spend-${line.key}">${dots(line)}${label}${isNew.has(line.key) ? '<span class="new-tag">New</span>' : ''}</label>${field(line)}
    </div>`;
  const tile = g => {
    const total = g.lines.reduce((sum, l) => sum + (spend[l.key] || 0), 0);
    const removed = [...removedRows.values()].filter(l => l.cat === g.cat).map(l =>
      `<p class="spend-removed">${l.merchant} row removed with its card ($${fmt0(spend[l.key])}/mo not counted)</p>`).join('');
    if (g.lines.length === 1 && !removed) {
      const line = g.lines[0];
      return `<div class="spend-tile single"><label class="spend-tile-head" for="spend-${line.key}"><span>${g.cat}</span>${field(line)}</label></div>`;
    }
    return `<div class="spend-tile" data-tile="${g.cat}">
      <div class="spend-tile-head"><span>${g.cat}</span><span class="spend-tile-total">$${fmt0(total)}</span></div>
      ${g.lines.map(l => row(l, rowLabel(l))).join('')}${removed}
    </div>`;
  };
  const groups = groupLines(SPEND_LINES);
  const columnOf = g => { const i = SPEND_COLUMNS.findIndex(cats => cats.includes(g.cat)); return i < 0 ? SPEND_COLUMNS.length - 1 : i; };
  el.innerHTML = SPEND_COLUMNS.map((_, i) =>
    `<div class="spend-col">${groups.filter(g => columnOf(g) === i).map(tile).join('')}</div>`).join('');
  el.querySelectorAll('input').forEach(input => input.addEventListener('input', function() {
    // A split-out brand's amount comes out of its travel type
    const brandLine = SPEND_LINES.find(l => l.key === this.dataset.cat && l.merchant && l.travelType);
    if (brandLine) {
      const v = Math.max(0, parseInt(this.value)||0), x = setBrandAmount(brandLine, v, spend);
      if (x !== v) this.value = x;
      document.getElementById('spend-Travel' + brandLine.travelType).value = spend['Travel' + brandLine.travelType];
    } else
    spend[this.dataset.cat] = Math.max(0, parseInt(this.value)||0);
    // Filling in a new row clears its "New" tag (and the notice, once every new row is filled in)
    if (newRowKeys().has(this.dataset.cat)) {
      newRowNotes = newRowNotes.map(n => ({ ...n, lines: n.lines.filter(l => l.key !== this.dataset.cat) })).filter(n => n.lines.length);
      const item = this.closest('.spend-item');
      item.classList.remove('is-new');
      item.querySelector('.new-tag').remove();
      renderNewRowsNote();
    }
    const tile = this.closest('[data-tile]');
    if (tile) tile.querySelector('.spend-tile-total').textContent = '$' + fmt0([...tile.querySelectorAll('input')].reduce((sum, i) => sum + (spend[i.dataset.cat] || 0), 0));
    recalc();
  }));
}

// ─────────────────────────────────────────────────────────────
// RECALC
// ─────────────────────────────────────────────────────────────
// Best card for a spend line, ranked by value per dollar (points per dollar × value per point).
function getBest(line, ownedOnly) {
  let best = null, bestRate = 0, bestValue = 0;
  CARDS.forEach(c => {
    if (ownedOnly && !owned.has(c.name)) return;
    if (!ownedOnly && c.coBrand) return; // exclude co-brand cards from "best available" — their high rates are brand-restricted, not general category multipliers
    const r = lineRate(c, line);
    const v = r * cardCpp(c).cpp;
    if (v > bestValue) { bestValue = v; bestRate = r; best = c; }
  });
  if (!best) return { card: null, rate: 0, value: 0 }; // empty wallet: nothing earned yet
  return { card: best, rate: bestRate, value: bestValue };
}

// ─────────────────────────────────────────────────────────────
// SPENDING CAPS
// ─────────────────────────────────────────────────────────────
// A card's `caps` limit a bonus rate to a yearly amount of spend (quarterly × 4, monthly × 12,
// assuming spend is even). Spend over a cap earns the cap's `rateAfter` on that card, or moves to the
// next-best card. See stackwise-mapping.md section 3 for the cap format.
const PERIODS_PER_YEAR = { year: 1, quarter: 4, month: 12 };
const PERIOD_LABEL = { year: 'yr', quarter: 'qtr', month: 'mo' };

// Does one entry of a cap's `categories` cover this line, booked this way, on this card?
function capCovers(c, entry, line, channel) {
  if (entry.startsWith('Merchant/')) return line.merchant === entry.slice(9) && channel !== 'portal';
  if (entry.startsWith('Portal/')) return line.travelType === entry.slice(7) && channel === 'portal';
  if (entry.startsWith('Travel/')) return line.travelType === entry.slice(7) && channel !== 'portal' && !merchantRate(c, line);
  const [cat, sub] = entry.split('/');
  if (line.cat !== cat || line.travelType || merchantRate(c, line)) return false;
  if (sub) return line.sub === sub;
  return lineRate(c, line) === c.rates[cat]; // a whole-category cap covers the types earning the category rate
}

// Index of the card's cap that covers this line and way of booking, or -1.
function capIndex(c, line, channel) {
  return (c.caps || []).findIndex(cap => cap.categories.some(entry => capCovers(c, entry, line, channel)));
}

function capText(cap) { return `$${cap.limit.toLocaleString()}/${PERIOD_LABEL[cap.period]}`; }

// Split each line's yearly spend across the given cards. Every dollar goes to the card and way of
// booking worth the most per dollar right now; when a cap fills up, that card drops to its
// rateAfter and the rest of the spend can move to another card. Lines whose best bonus is worth the
// most go first, so a shared cap fills with its highest-rate category. Returns a Map of
// line → [{ card, channel, rate, amount, pts, value }] (amount in dollars a year; a line with no
// spend gets one zero-amount entry, so the table can still show which card to use).
function allocate(cards, lines, monthly = spend) {
  const room = new Map(); // "card#capIndex" → yearly dollars left before the cap
  const roomLeft = (c, i) => {
    const k = c.name + '#' + i;
    if (!room.has(k)) room.set(k, c.caps[i].limit * PERIODS_PER_YEAR[c.caps[i].period]);
    return room.get(k);
  };
  const plans = lines.map(line => {
    const options = cards.flatMap(c => (line.travelType ? travelOptions(c, line) : [{ channel: null, rate: lineRate(c, line) }])
      .filter(o => o.rate > 0)
      .map(o => ({ card: c, channel: o.channel, bonus: o.rate, cpp: cardCpp(c).cpp, cap: capIndex(c, line, o.channel) })));
    return { line, ann: (monthly[line.key] || 0) * 12, options, top: Math.max(0, ...options.map(o => o.bonus * o.cpp)) };
  });
  const result = new Map();
  [...plans].sort((a, b) => b.top - a.top).forEach(({ line, ann, options }) => {
    const allocs = [];
    let left = ann;
    do {
      // Rate each option earns on the next dollar (ties keep the first option: direct before travel site)
      let best = null, bestValue = 0;
      options.forEach(o => {
        const capped = o.cap >= 0 && roomLeft(o.card, o.cap) <= 0;
        const rate = capped ? o.card.caps[o.cap].rateAfter : o.bonus;
        if (rate * o.cpp > bestValue) { best = { ...o, rate, capped }; bestValue = rate * o.cpp; }
      });
      if (!best) break;
      const limited = best.cap >= 0 && !best.capped;
      const amount = limited ? Math.min(left, roomLeft(best.card, best.cap)) : left;
      if (limited) room.set(best.card.name + '#' + best.cap, roomLeft(best.card, best.cap) - amount);
      const prev = allocs[allocs.length - 1];
      if (prev && prev.card === best.card && prev.channel === best.channel && prev.rate === best.rate) prev.amount += amount;
      else allocs.push({ card: best.card, channel: best.channel, rate: best.rate, amount, cap: best.cap });
      left -= amount;
    } while (left > 0.005);
    allocs.forEach(a => { a.pts = a.amount * a.rate; a.value = a.pts * cardCpp(a.card).cpp; });
    result.set(line, allocs);
  });
  return result;
}

const allocValue = allocs => [...allocs.values()].flat().reduce((sum, a) => sum + a.value, 0);

function rateClass(r) {
  if (r >= 5) return 'rate-5x';
  if (r >= 4) return 'rate-4x';
  if (r >= 3) return 'rate-3x';
  if (r >= 2) return 'rate-2x';
  return 'rate-1x';
}

function recalc() {
  const walletCards = CARDS.filter(c => owned.has(c.name));
  const allocs = allocate(walletCards, SPEND_LINES);
  let totalVal = 0, totalSpend = 0;

  // One row per spend line: where its spend goes (`allocs`), split at caps, plus for travel one entry
  // per way of booking. A way of booking with no spend still shows the best wallet card for it, greyed
  // out, for comparison.
  const rows = SPEND_LINES.map(line => {
    const mo = spend[line.key] || 0;
    const ann = mo * 12;
    const lineAllocs = allocs.get(line) || [];
    const earned = lineAllocs.reduce((sum, a) => sum + a.pts, 0);
    const earnedVal = lineAllocs.reduce((sum, a) => sum + a.value, 0);
    totalVal += earnedVal; totalSpend += ann;
    const row = { line, mo, ann, allocs: lineAllocs, earned, earnedVal };
    if (line.travelType) {
      row.channels = CHANNELS.map(channel => {
        const chAllocs = lineAllocs.filter(a => a.channel === channel);
        if (chAllocs.length) return { channel, allocs: chAllocs, recommended: true };
        const o = getBest({ ...line, channel }, true);
        return { channel, recommended: !lineAllocs.length && channel === 'direct', // empty wallet: spend shows on the direct row
          allocs: o.card && o.rate > 0 ? [{ card: o.card, channel, rate: o.rate, amount: 0, pts: 0 }] : [] };
      });
    }
    return row;
  });


  const badge = rate => rate ? `<span class="rate-badge ${rateClass(rate)}">${rate}x</span>` : '—';
  // Travel spend says how to book next to the card; other spend has no channel
  const HOW_TO_BOOK = { direct: 'book direct', portal: 'via bank travel portal' };
  const cardWithSite = (card, channel) => cardDot(card) + card.name + (channel ? ` <span class="site">· ${HOW_TO_BOOK[channel]}</span>` : '');
  // Card and rate cells for one or more allocations. Allocations to the same card (its bonus, then
  // its rate after the cap) show as one card with "6x → 1x"; a split between cards lists each card
  // with its share of the monthly spend.
  const splitWord = (i, n) => i === 0 ? 'first' : i === n - 1 ? 'then' : 'next';
  const perMonth = a => `$${fmt0(a.amount / 12)}/mo`;
  const byCard = allocs => allocs.reduce((groups, a) => {
    const g = groups[groups.length - 1];
    if (g && g.card === a.card && g.channel === a.channel) g.parts.push(a);
    else groups.push({ card: a.card, channel: a.channel, parts: [a] });
    return groups;
  }, []);
  const cardCell = (allocs, none, note = '') => {
    if (!allocs.length) return `<td class="card-name none">${none}${note}</td>`;
    const groups = byCard(allocs);
    return `<td class="card-name">${groups.map((g, gi) => {
      const share = g.parts.length > 1 ? g.parts.map((p, i) => `${splitWord(i, g.parts.length)} ${perMonth(p)}`).join(', ')
        : groups.length > 1 ? `${splitWord(gi, groups.length)} ${perMonth(g.parts[0])}` : '';
      return `<span class="split">${cardWithSite(g.card, g.channel)}${share ? `<span class="split-amt">${share}</span>` : ''}</span>`;
    }).join('')}${note}</td>`;
  };
  // Travel: the way of booking that isn't used, as a grey note under the card, for comparison
  // ("Booking direct: Chase Sapphire Reserve, 4x @ 1¢ = $192/yr"): the best wallet card for that way
  // of booking, always named, and what the row's spend would be worth a year with it (caps aside).
  // No note when there's no other way, or it's the same card and rate.
  const otherWayNote = (r, usedAllocs) => {
    const used = usedAllocs[0];
    const alt = r.channels.filter(ch => !ch.recommended && ch.allocs.length).map(ch => ch.allocs[0])[0];
    if (!alt || (used && alt.card === used.card && alt.rate === used.rate)) return '';
    const label = alt.channel === 'direct' ? 'Booking direct' : 'Via bank travel portal';
    const cpp = cardCpp(alt.card).cpp;
    const worth = r.ann > 0 ? ` = $${fmt0(r.ann * alt.rate * cpp)}/yr` : '';
    return `<span class="other-way">${label}: ${alt.card.name}, ${alt.rate}x @ ${+(cpp * 100).toFixed(2)}¢${worth}</span>`;
  };
  const rateCell = allocs => {
    const groups = byCard(allocs);
    if (!groups.length) return `<td>${badge(0)}</td>`;
    return `<td>${groups.map(g => `<span class="split">${g.parts.map(p => badge(p.rate)).join('<span class="rate-arrow">→</span>')}${
      groups.length > 1 ? '<span class="split-amt">&nbsp;</span>' : ''}</span>`).join('')}</td>`; // blank line keeps badges level with their card
  };
  // Annual points per card, level with each card in the card cell. Points from different cards are
  // different currencies, so a line split between cards isn't totaled.
  const ptsCell = allocs => {
    const groups = byCard(allocs);
    return `<td class="num">${groups.map(g => `<span class="split">${fmt0(g.parts.reduce((sum, p) => sum + p.pts, 0))}${
      groups.length > 1 ? '<span class="split-amt">&nbsp;</span>' : ''}</span>`).join('')}</td>`;
  };
  // What one point from each card is worth with the chosen redemption, level with each card
  const cppCell = allocs => {
    const groups = byCard(allocs);
    if (!groups.length) return '<td class="num">—</td>';
    return `<td class="num">${groups.map(g => `<span class="split">${+(cardCpp(g.card).cpp * 100).toFixed(2)}¢${
      groups.length > 1 ? '<span class="split-amt">&nbsp;</span>' : ''}</span>`).join('')}</td>`;
  };
  // Dollar value of each card's annual points, level with each card
  const valCell = allocs => {
    const groups = byCard(allocs);
    return `<td class="num">${groups.map(g => `<span class="split">$${fmt0(g.parts.reduce((sum, p) => sum + p.value, 0))}${
      groups.length > 1 ? '<span class="split-amt">&nbsp;</span>' : ''}</span>`).join('')}</td>`;
  };
  // `counted` is false for the way of booking travel that isn't used: it shows the rate for
  // comparison, but the spend and points belong to the other row.
  const optRow = (r, label, allocs, none, counted = true, note = '') => {
    const mo = allocs.reduce((sum, a) => sum + a.amount, 0) / 12;
    // A split-out brand row has an amount box and "Undo split"; its travel type's "All other" row
    // gets an amount box too. Both change Monthly spend.
    const b = r.line.merchant && r.line.travelType ? r.line : null;
    const editable = b || (r.line.travelType && hasBrandRows(r.line));
    const box = line => `<span class="split-box">$<input id="opt-split-${line.key}" class="split-input" type="text" inputmode="numeric" autocomplete="off" data-key="${line.key}" value="${spend[line.key] || 0}" aria-label="Monthly spend on ${rowLabel(line).toLowerCase()}"></span>`;
    return `<tr class="${counted ? '' : 'alt-way'}${b ? ' brand-row' : ''}">
      <td class="cat-name lvl-${lineLevel(r.line)}">${label}${b ? `<button type="button" class="brand-unsplit" data-brand="${b.merchant}" data-type="${b.travelType}">Undo split</button>` : ''}</td>
      <td class="num">${editable ? box(r.line) : counted ? '$' + fmt0(r.channels && allocs.length ? mo : r.mo) : '—'}</td>
      ${cardCell(allocs, none, note)}
      ${rateCell(allocs)}
      ${counted && allocs.length ? ptsCell(allocs) : '<td class="num">—</td>'}
      ${cppCell(allocs)}
      ${counted && allocs.length ? valCell(allocs) : '<td class="num">—</td>'}
    </tr>`;
  };

  // Summary banner: what the wallet earns a year, plus the benefits the user says they'll redeem,
  // after its annual fees (the same amount as the total under "Net value per card"). With an empty
  // wallet nothing is earned yet, so no totals.
  const nCards = owned.size;
  const moSpend = totalSpend / 12;
  const hasResults = nCards > 0 && totalSpend > 0;
  summaryState = { nCards, hasResults, totalVal };
  renderSummaryTitle(true); // replaced below if results are held
  document.getElementById('spend-total').textContent = '$' + fmt0(moSpend);

  // Hold the results until every points currency in the wallet has a redemption choice: without
  // one, points can't be valued, so cards can't be compared.
  const pending = pendingCurrencies(walletCards);
  document.getElementById('tab-optimizer').classList.toggle('held', pending.length > 0);
  if (pending.length) {
    const list = pending.length > 1 ? pending.slice(0, -1).join(', ') + ' and ' + pending[pending.length - 1] : pending[0];
    document.getElementById('summary-title').textContent = 'Choose how you redeem your points to see what you can earn.';
    document.getElementById('hold-note').innerHTML = `<p>Your results will appear once you choose how you redeem ${list}.</p>`;
    return;
  }

  // Optimizer table, grouped by category like the spend inputs. Every category gets a heading row; a
  // category that is a single line (Dining, Streaming...) is then called "All dining", "All streaming".
  const tableLabel = line => lineLevel(line) === 0 ? (line.cat === 'Other' ? 'All other' : `All ${line.cat.toLowerCase()}`) : rowLabel(line);
  const rowsFor = r => {
    if (!r.channels) return optRow(r, tableLabel(r.line), r.allocs, 'None owned');
    // Travel: one row with the way of booking that gets the spend (shown next to the card), and the
    // other way as a grey note for comparison
    const used = r.channels.filter(ch => ch.recommended).flatMap(ch => ch.allocs);
    // Brand lines under the other-way note
    const brandNotes = brandNoteLines(r.line, walletCards).map(bl => brandNote(bl, walletCards)).join('');
    return optRow(r, tableLabel(r.line), used, 'None owned', true, otherWayNote(r, used) + brandNotes);
  };
  document.getElementById('opt-tbody').innerHTML = groupLines(SPEND_LINES).map(g =>
    `<tr class="cat-group"><td colspan="7">${g.cat}</td></tr>` +
    g.lines.map(line => rowsFor(rows.find(r => r.line === line))).join('')
  ).join('') +
  // Total row: monthly spend and dollar value only. Points from different cards don't add up.
  `<tr class="total-row">
    <td>Total</td>
    <td class="num">$${fmt0(moSpend)}</td>
    <td></td><td></td><td></td><td></td>
    <td class="num">$${fmt0(totalVal)}</td>
  </tr>`;

  // Fee coverage and the per-card summary
  renderFeeCoverage(rows);
  renderCardGuide(rows);

  // Gap analysis: what adding each card would earn on top of the wallet (caps included) after its
  // annual fee, and the lines it would take over
  const scored = !nCards ? [] : CARDS.filter(c => !owned.has(c.name)).map(c => {
    const withCard = allocate([...walletCards, c], SPEND_LINES);
    const winCats = SPEND_LINES.filter(line => (withCard.get(line) || []).some(a => a.card === c && a.amount > 0)).map(line => line.label);
    return { card: c, uplift: allocValue(withCard) - totalVal - c.fee, winCats };
  }).filter(x => x.uplift > 1).sort((a,b) => b.uplift - a.uplift).slice(0,4);

  const gapEl = document.getElementById('gap-container');
  const hasSpend = SPEND_LINES.some(line => (spend[line.key] || 0) > 0);
  if (!nCards) {
    gapEl.innerHTML = `<div class="empty-gap"><p>Add cards to your wallet to see which cards would earn you more.</p></div>`;
  } else if (!hasSpend) {
    gapEl.innerHTML = `<div class="empty-gap"><p>Enter your monthly spend to see which cards would earn you more.</p></div>`;
  } else if (scored.length === 0) {
    gapEl.innerHTML = `<div class="empty-gap"><p>You already own the top cards for your current spend profile. Try adjusting your spend or removing a card.</p></div>`;
  } else {
    gapEl.innerHTML = `<div class="gap-grid">${scored.map((s,i) => `
      <div class="gap-card ${i===0?'top':''}">
        <div class="gap-rank">${i===0?'Top pick':'#'+(i+1)}</div>
        <div class="gap-name">${s.card.name}</div>
        <div class="gap-note">${s.card.note}</div>
        <div class="gap-uplift">+$${fmt0(s.uplift)}</div>
        <div class="gap-uplift-label">est. annual uplift, ${s.card.fee ? `after its $${s.card.fee} fee` : 'no annual fee'}</div>
        <div class="gap-cats">${s.winCats.map(c=>`<span class="gap-cat-pill">${c}</span>`).join('')}</div>
      </div>`).join('')}</div>`;
  }
}

// What a wallet card is used for in the Optimizer's split: each line it gets spend on, with the
// travel site when booked through one and the monthly share when a cap splits the line.
function cardUses(rows, c) {
  const uses = rows.flatMap(r => {
    const mine = r.allocs.filter(a => a.card === c && a.amount > 0);
    if (!mine.length) return [];
    const amount = mine.reduce((sum, a) => sum + a.amount, 0);
    return [{
      label: r.line.label,
      site: mine.some(a => a.channel === 'portal') ? c.portalLabel : null,
      partial: amount < r.ann - 0.5 ? amount / 12 : null,
      pts: mine.reduce((sum, a) => sum + a.pts, 0)
    }];
  });
  return { uses, pts: uses.reduce((sum, u) => sum + u.pts, 0) };
}

// ─────────────────────────────────────────────────────────────
// CARD BENEFITS (statement credits)
// ─────────────────────────────────────────────────────────────
// Dollar credits read from a card's `perks` text, as a yearly amount: "$120 Uber Cash" → 120,
// "Up to $200 Uber Cash + $120 Uber One credit" → 320, Global Entry/TSA PreCheck (every 4 years)
// → divided by 4. Only perks that start with the amount count; ones whose amount isn't a yearly
// credit (a $0 fee, a points offer, a one-time bonus) are left out.
function cardCredits(card) {
  return (card.perks || []).flatMap(text => {
    const first = text.match(/^(?:Up to )?\$([\d,]+)(?![\d,]*-point)/);
    if (!first || /after first purchase/i.test(text)) return [];
    const extra = [...text.matchAll(/\+ \$([\d,]+)/g)].map(m => +m[1].replace(/,/g, ''));
    let amount = [+first[1].replace(/,/g, ''), ...extra].reduce((sum, a) => sum + a, 0);
    if (/4 yrs|Global Entry/.test(text)) amount /= 4;
    return amount > 0 ? [{ text, name: creditName(text), amount }] : [];
  });
}
// A credit's name without its dollar amounts, which the Worth column shows: "Up to $500 The Edit
// hotel credit" → "The Edit hotel credit", "$300 airline + $150 lifestyle credit" → "airline +
// lifestyle credit". Conditions like "($500+ stay)" are kept.
function creditName(text) {
  return text.replace(/^(?:Up to )?\$[\d,]+(?:\/yr)?\s+/, '').replace(/\+ \$[\d,]+\s+/g, '+ ');
}

// What the user expects to use of each credit a year: { cardName: { creditText: dollars } }
let creditUse = {};
const openBenefits = new Set(); // cards whose benefits list is open in "Net value per card"

// The wallet's net value a year: points value of all spend + benefits the user will redeem − annual
// fees. Shown in the summary banner and the total bar under "Net value per card", so they always match.
let summaryState = { nCards: 0, hasResults: false, totalVal: 0 };
// walletTotals() also gives each part, for the total bar's columns.
function walletTotals() {
  const walletCards = CARDS.filter(c => owned.has(c.name));
  const points = summaryState.totalVal; // same as the Value total in Points earned per category
  const benefits = walletCards.reduce((sum, c) => sum + Object.values(creditUse[c.name] || {}).reduce((a, v) => a + v, 0), 0);
  const worth = walletCards.reduce((sum, c) => sum + cardCredits(c).reduce((a, cr) => a + cr.amount, 0), 0);
  const fees = walletCards.reduce((sum, c) => sum + c.fee, 0);
  return { points, benefits, worth, fees, net: points + benefits - fees };
}
function walletNet() { return walletTotals().net; }
// Banner headline. Dollars, not points: points from different cards are worth different amounts, so
// they don't add up. (The amount is after annual fees; the banner doesn't say so.) Left alone while
// results are held for a redemption choice, since that has its own message.
function renderSummaryTitle(force = false) {
  if (!force && document.getElementById('tab-optimizer').classList.contains('held')) return;
  const { nCards, hasResults } = summaryState;
  const net = walletNet();
  document.getElementById('summary-title').innerHTML = !hasResults
    ? (nCards ? 'Add your monthly spend to see what you can earn.' : 'Add your cards to see what you can earn.')
    : net >= 0 ? `You can earn <em>$${fmt0(net)} a year</em> with your cards.`
    : `Your cards cost <em class="loss">$${fmt0(-net)} a year</em> more in annual fees than they earn.`;
}

// Fee coverage when the wallet is used the way the Optimizer recommends: each card earns only on
// the spend the Optimizer sends to it (travel booked the recommended way, splits at caps), plus the
// card's credits the user says they'll use.
function renderFeeCoverage(rows) {
  const el = document.getElementById('fee-grid');
  const ownedCards = CARDS.filter(c => owned.has(c.name));

  if (ownedCards.length === 0) {
    el.innerHTML = `<div class="empty-gap"><p>Add cards to your wallet to see fee coverage.</p></div>`;
    return;
  }

  const hint = ownedCards.some(c => cardCredits(c).length)
    ? `<p class="fee-hint">Click <b>Enter benefits</b> on each card and type what you'll redeem a year, so its net value counts them.</p>` : '';
  el.innerHTML = hint + ownedCards.map(c => {
    const { pts: annualPts } = cardUses(rows, c);
    const pointValue = cardCpp(c).cpp;
    const earnedVal = annualPts * pointValue;
    const credits = cardCredits(c);
    const use = creditUse[c.name] || {};
    const id = 'fee-' + c.name.replace(/[^a-zA-Z0-9]/g, '-');

    const worth = credits.reduce((sum, cr) => sum + cr.amount, 0);
    const open = openBenefits.has(c.name);
    // One strip per card, read left to right as a sum: points + benefits − fee = net value.
    // The benefits list opens under the strip.
    return `<div class="fee-card${open ? ' open' : ''}" data-card="${c.name}" data-earned="${earnedVal}">
      <div class="fee-strip">
        <div>
          <div class="fee-name">${cardDot(c)}${c.name}</div>
        </div>
        <div class="fee-stat"><div class="fee-label">${fmt0(annualPts)} pts/yr @ ${fmtCpp(pointValue).replace('/pt', '')}</div><div class="fee-v">$${fmt0(earnedVal)}</div></div>
        <div class="fee-stat"><div class="fee-label">+ Benefits</div>${credits.length
          ? `<button class="fee-ben-toggle" type="button" aria-expanded="${open}" aria-controls="${id}-list"><span class="fee-ben-fill">Enter benefits</span><span class="fee-ben-sum"><b class="fee-ben-used"></b> of $${fmt0(worth)}</span><span class="chev" aria-hidden="true">▶</span></button>
             <div class="fee-ben-cap">Worth up to $${fmt0(worth)}</div>`
          : '<div class="fee-ben-none">None to track</div>'}</div>
        <div class="fee-stat"><div class="fee-label">− Annual fee</div><div class="fee-v">$${fmt0(c.fee)}</div></div>
        <div class="fee-net"><div class="fee-label">= Net value</div><span class="fee-net-pill"><span class="fee-net-val"></span></span></div>
      </div>
      ${credits.length ? `
      <div class="fee-credits" id="${id}-list">
        <div class="fee-credit head"><span>Benefit</span><span>Worth</span><span>Redeemed</span></div>
        ${credits.map((cr, i) => `
        <div class="fee-credit">
          <label for="${id}-cr${i}">${cr.name}</label>
          <span class="fee-credit-max">$${fmt0(cr.amount)}</span>
          <span class="fee-credit-use">$<input id="${id}-cr${i}" type="text" inputmode="decimal" autocomplete="off" value="${use[cr.text] || 0}" data-max="${cr.amount}" data-credit="${cr.text}" aria-label="Dollars a year you'll redeem of ${cr.text}"></span>
        </div>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('') + `
    <div class="fee-total">
      <div class="fee-strip">
        <div class="fee-name">Total net value</div>
        <div class="fee-stat"><div class="fee-label">Points value</div><div class="fee-v fee-total-points"></div></div>
        <div class="fee-stat"><div class="fee-label">+ Benefits</div><div class="fee-v fee-total-ben"></div></div>
        <div class="fee-stat"><div class="fee-label">− Annual fees</div><div class="fee-v fee-total-fees"></div></div>
        <div class="fee-net"><div class="fee-label">= Net value</div><span class="fee-net-pill"><span class="fee-net-val"></span></span></div>
      </div>
    </div>`;
  updateFeeTotal();

  el.querySelectorAll('.fee-card').forEach(cardEl => {
    const name = cardEl.dataset.card;
    // Open or close the benefits list; remembered while the page is open, since the strips are
    // redrawn whenever spend changes
    cardEl.querySelector('.fee-ben-toggle')?.addEventListener('click', function() {
      const open = cardEl.classList.toggle('open');
      this.setAttribute('aria-expanded', open);
      open ? openBenefits.add(name) : openBenefits.delete(name);
    });
    // Typed dollar amounts ("$1,200" or "60" both work), capped at what the benefit is worth
    cardEl.querySelectorAll('.fee-credit-use input').forEach(input => {
      input.addEventListener('input', function() {
        const dollars = parseFloat(this.value.replace(/[$,\s]/g, '')) || 0;
        (creditUse[name] = creditUse[name] || {})[this.dataset.credit] = Math.min(+this.dataset.max, Math.max(0, dollars));
        updateFeeCard(cardEl);
        updateFeeTotal();
        renderSummaryTitle();
      });
      input.addEventListener('blur', function() { this.value = fmt0(creditUse[name]?.[this.dataset.credit] || 0); });
    });
    updateFeeCard(cardEl);
  });
}

// The total bar under the strips: each column summed over the wallet, and the wallet's net value
// (the same amount as the summary banner)
function updateFeeTotal() {
  const el = document.querySelector('#fee-grid .fee-total');
  if (!el) return;
  const t = walletTotals();
  el.querySelector('.fee-total-points').textContent = `$${fmt0(t.points)}`;
  el.querySelector('.fee-total-ben').innerHTML = `$${fmt0(t.benefits)}${t.worth ? ` <span class="fee-total-of">of $${fmt0(t.worth)}</span>` : ''}`;
  el.querySelector('.fee-total-fees').textContent = `$${fmt0(t.fees)}`;
  el.querySelector('.fee-net-val').textContent = `${t.net >= 0 ? '+' : '−'}$${fmt0(Math.abs(t.net))}`;
  el.classList.toggle('short', t.net < 0);
}

// Totals for one fee coverage card (points value + benefits used − fee), updated in place as the
// user types, so the inputs keep focus.
function updateFeeCard(cardEl) {
  const c = CARDS.find(x => x.name === cardEl.dataset.card);
  const benefits = Object.values(creditUse[c.name] || {}).reduce((sum, v) => sum + v, 0);
  const net = +cardEl.dataset.earned + benefits - c.fee;
  const usedEl = cardEl.querySelector('.fee-ben-used');
  if (usedEl) usedEl.textContent = `$${fmt0(benefits)}`;
  // Until something is entered, the benefits button asks to be filled in
  cardEl.classList.toggle('ben-empty', !!usedEl && benefits === 0);
  // The style says whether the fee is covered. A card with no fee looks like one whose fee is covered.
  const cls = net >= 0 ? 'covered' : 'short';
  cardEl.classList.remove('covered', 'short');
  cardEl.classList.add(cls);
  cardEl.querySelector('.fee-net-val').textContent = `${net >= 0 ? '+' : '−'}$${fmt0(Math.abs(net))}`;
}

// "Which card to use": one line per wallet card listing the spend it should get (travel says which
// way to book), in the order the cards were added.
function renderCardGuide(rows) {
  const el = document.getElementById('card-guide');
  const ownedCards = [...owned].map(name => CARDS.find(c => c.name === name)).filter(Boolean);
  if (!ownedCards.length) {
    el.innerHTML = `<div class="empty-gap"><p>Add cards to your wallet to see what to use each one for.</p></div>`;
    return;
  }
  el.innerHTML = ownedCards.map(c => {
    const { uses: used, pts } = cardUses(rows, c);
    const uses = used.map(u => `<span class="guide-use">${u.label.replace(/ — /, ': ')}${u.site ? ` <em>via ${u.site}</em>` : ''}${u.partial ? ` <span class="guide-part">$${fmt0(u.partial)}/mo</span>` : ''}</span>`);
    return `<div class="guide-row${used.length ? '' : ' unused'}">
      <div class="guide-card">${cardDot(c)}<span>${c.name}</span></div>
      <div class="guide-uses">${uses.length ? uses.join('') : '<span class="guide-none">Not needed for your current spend</span>'}</div>
      <div class="guide-pts">${used.length ? fmt0(pts) + ' pts/yr' : ''}</div>
    </div>`;
  }).join('');
}

function fmt0(n) { return Math.round(n).toLocaleString(); }

// How you redeem points: the menus always open below (see stackwise.css). If there isn't room for the
// whole list under a menu, scroll the page up just enough first, so the list never opens squeezed.
document.addEventListener('pointerdown', e => {
  const sel = e.target.closest('.redeem-item select');
  if (!sel) return;
  const needed = sel.options.length * 36 + 30; // list height plus its gap and padding
  const room = innerHeight - sel.getBoundingClientRect().bottom;
  if (room < needed) window.scrollBy({ top: needed - room + 12, behavior: 'instant' });
}, true);

// ─────────────────────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-current', 'page');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    // The wallet and monthly spend panels only feed the Optimizer, so hide them on other tabs
    document.querySelector('.main').classList.toggle('tab-utilization', btn.dataset.tab === 'utilization');
    document.querySelector('.summary-wrap').hidden = btn.dataset.tab === 'utilization'; // its totals are the Optimizer's
    document.querySelector('.guide-wrap').hidden = btn.dataset.tab === 'utilization';   // its steps are the Optimizer's
    if (btn.dataset.tab === 'utilization') document.querySelector('.main').style.paddingTop = '24px';
    else document.querySelector('.main').style.paddingTop = '';
    if (btn.dataset.tab === 'utilization') renderUtilCards();
    else renderRedeemList(); // each tab lists its own cards' currencies
  });
});

// ─────────────────────────────────────────────────────────────
// CARD UTILIZATION TAB
// ─────────────────────────────────────────────────────────────
let cardsUnderReview = new Set(); // card names currently shown in the utilization tab

function renderUtilCards() {
  renderRedeemList(); // cards under review add their currencies to "How you redeem points"
  const container = document.getElementById('util-cards-container');
  if (cardsUnderReview.size === 0) {
    container.innerHTML = `<div class="util-empty">Pick a card below to see how well you're using it.</div>`;
    return;
  }

  container.innerHTML = '';
  cardsUnderReview.forEach(cardName => {
    const card = CARDS.find(c => c.name === cardName);
    if (!card) return;

    // Same lines the Optimizer uses, with this card's home-merchant rows
    const lines = buildSpendLines([card], utilSplitSet(cardName));
    if (!cardSpend[cardName]) cardSpend[cardName] = {};
    const cs = cardSpend[cardName];
    const blockId = 'util-block-' + cardName.replace(/[^a-zA-Z0-9]/g, '-');

    const block = document.createElement('div');
    block.className = 'util-card-block';
    block.innerHTML = `
      <div class="util-card-header">
        <div>
          <h4>${card.name}</h4>
          <div class="util-spend-sub">${ISSUER_NAMES[card.issuer] || card.issuer} · $${card.fee}/yr annual fee${cardCpp(card).pending ? '' : ` · ${fmtCpp(cardCpp(card).cpp)} (${cardCpp(card).label})`}</div>
        </div>
        <div class="util-actions">
          <select class="util-swap-select" data-card="${cardName}" aria-label="Change card">
            <option value="">Change card…</option>
          </select>
          <button class="util-remove-btn" data-card="${cardName}">Remove</button>
        </div>
      </div>
      <div class="util-grid">
        <div class="util-spend-panel">
          <div class="util-panel-title">Monthly spend on this card</div>
          <div id="${blockId}-rows"></div>
        </div>
        <div>
          <div class="util-credits-panel">
            <div class="util-panel-title">Other card benefits</div>
            ${(card.perks && card.perks.length) ? card.perks.map(p => `
            <div class="util-credit-row">
              <span class="util-credit-icon">✦</span>
              <span>${p}</span>
            </div>`).join('') : `
            <div class="util-credit-row">
              <span class="util-credit-icon">✦</span>
              <span>No additional statement credits or perks beyond points earning.</span>
            </div>`}
            <p class="util-credits-note">
              These perks aren't included in the dollar total below yet — shown here for reference while we figure out how to value them.
            </p>
          </div>
          <div id="${blockId}-result"></div>
        </div>
      </div>
    `;
    container.appendChild(block);

    // Populate the swap dropdown: all cards grouped by issuer, excluding ones already under review
    const swapSel = block.querySelector('.util-swap-select');
    const byIssuer = {};
    CARDS.filter(c => c.name === cardName || !cardsUnderReview.has(c.name)).forEach(c => {
      (byIssuer[c.issuer] = byIssuer[c.issuer] || []).push(c);
    });
    Object.keys(byIssuer).sort().forEach(issuerCode => {
      const group = document.createElement('optgroup');
      group.label = ISSUER_NAMES[issuerCode] || issuerCode;
      byIssuer[issuerCode].sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        if (c.name === cardName) opt.disabled = true; // already showing this one
        group.appendChild(opt);
      });
      swapSel.appendChild(group);
    });

    document.getElementById(`${blockId}-rows`).innerHTML = lines.map(line => {
      const rate = lineRate(card, line);
      // Travel rows: say which way of booking the rate assumes, and what the other way earns
      let sub = '';
      if (line.travelType) {
        const opts = travelOptions(card, line);
        const best = bestTravelOption(card, line);
        sub = opts.length === 1
          ? (merchantRate(card, line) ? `booked direct with ${line.merchant}` : 'booked direct (no travel site)')
          : `best: ${best.channel === 'direct' ? 'book direct' : 'via ' + best.label} · ` +
            opts.filter(o => o.channel !== best.channel).map(o => `${o.rate}x ${o.channel === 'direct' ? 'direct' : 'via ' + o.label}`).join(' · ');
      }
      // Capped rate: say how far it goes, and what it drops to
      const ci = capIndex(card, line, line.travelType ? bestTravelOption(card, line).channel : null);
      if (ci >= 0) {
        const cap = card.caps[ci];
        const shared = cap.categories.length > 1 ? ' (shared)' : '';
        sub += `${sub ? ' · ' : ''}${rate}x on first ${capText(cap)}${shared}, then ${cap.rateAfter}x`;
      }
      // Brand lines for this card against your wallet, and "Undo split" on a split-out brand
      const others = CARDS.filter(c => owned.has(c.name) && c !== card);
      sub += brandNoteLines(line, [card], utilSplitSet(cardName)).map(bl => brandNote(bl, [card, ...others], `data-card="${cardName}"`, card)).join('');
      if (line.merchant && line.travelType) sub += `${sub ? ' · ' : ''}taken out of ${line.travelType.toLowerCase()} · <button type="button" class="brand-unsplit" data-card="${cardName}" data-brand="${line.merchant}" data-type="${line.travelType}">Undo split</button>`;
      return `
      <div class="spend-row">
        <span class="spend-label">${line.label}${sub ? `<span class="spend-sub">${sub}</span>` : ''}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(rate)}">${rate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="${line.key}" value="${cs[line.key] || 0}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
    }).join('');

    block.querySelectorAll('.util-spend-input').forEach(input => {
      input.addEventListener('input', function() {
        // A split-out brand's amount comes out of its travel type
        const store = cardSpend[this.dataset.card], v = Math.max(0, parseFloat(this.value) || 0);
        const brandLine = lines.find(l => l.key === this.dataset.cat && l.merchant && l.travelType);
        if (brandLine) {
          const x = setBrandAmount(brandLine, v, store);
          if (x !== v) this.value = x;
          block.querySelector(`.util-spend-input[data-cat="Travel${brandLine.travelType}"]`).value = store['Travel' + brandLine.travelType];
        } else store[this.dataset.cat] = v;
        renderUtilResult(card, cardSpend[this.dataset.card], blockId);
      });
    });

    renderUtilResult(card, cs, blockId);
  });

  // Remove buttons
  container.querySelectorAll('.util-remove-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      cardsUnderReview.delete(this.dataset.card);
      renderUtilCards();
    });
  });

  // Swap-card dropdowns — change which card a block represents without losing entered spend
  container.querySelectorAll('.util-swap-select').forEach(sel => {
    sel.addEventListener('change', function() {
      if (!this.value) return;
      const oldName = this.dataset.card;
      const newName = this.value;
      if (oldName === newName) return;

      // Carry over spend on the lines every card has; home-merchant rows belong to the old card so we leave them behind
      const oldSpend = cardSpend[oldName] || {};
      const carried = {};
      buildSpendLines([]).forEach(line => { if (oldSpend[line.key]) carried[line.key] = oldSpend[line.key]; });
      cardSpend[newName] = carried;

      // Rebuild the Set in the same order, swapping oldName -> newName in place
      const ordered = Array.from(cardsUnderReview).map(n => n === oldName ? newName : n);
      cardsUnderReview = new Set(ordered);

      renderUtilCards();
    });
  });
}

function renderUtilResult(card, cs, blockId) {
  // Travel assumes each type is booked this card's better way; spend over a cap earns the cap's rateAfter
  const annualPts = [...allocate([card], buildSpendLines([card], utilSplitSet(card.name)), cs).values()].flat().reduce((sum, a) => sum + a.pts, 0);
  // Value per point for this card's own currency and the chosen redemption style
  const { cpp: effectiveCpp, label: currencyLabel, pending } = cardCpp(card);
  if (pending) {
    document.getElementById(`${blockId}-result`).innerHTML = `
    <div class="util-result-bar">
      <div>
        <div class="util-result-label">Points earned/yr</div>
        <div class="util-result-pts">${fmt0(annualPts)} pts · choose how you redeem ${pendingCurrencies([card])[0]} under “How you redeem points” to see their value</div>
      </div>
    </div>`;
    return;
  }
  const cppLabel = `${fmtCpp(effectiveCpp)} (${currencyLabel})`;

  const earnedVal = annualPts * effectiveCpp;
  const net = earnedVal - card.fee;
  const covered = net >= 0;

  document.getElementById(`${blockId}-result`).innerHTML = `
    <div class="util-result-bar ${covered ? 'covered' : 'short'}">
      <div>
        <div class="util-result-label">Points earned/yr</div>
        <div class="util-result-pts">${fmt0(annualPts)} pts · $${fmt0(earnedVal)} @ ${cppLabel}</div>
      </div>
      <div>
        <div class="util-result-label">Net vs $${card.fee} fee</div>
        <div class="util-result-val">${net >= 0 ? '+' : '−'}$${fmt0(Math.abs(net))}</div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
const dataReady = window.STACKWISE_DATA
  ? Promise.resolve(window.STACKWISE_DATA)
  : fetch('stackwise-data.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

dataReady
  .catch(err => {
    document.querySelector('.main').insertAdjacentHTML('afterbegin',
      `<p style="flex:1 1 100%;color:var(--warn-text);font-size:14px">Couldn't load card data (${err.message}). Keep stackwise-data.js next to stackwise.html, or serve the page from a web server so stackwise-data.json can load.</p>`);
    throw err;
  })
  .then(data => {
    ({ categories: CATS, categoryColors: CAT_COLORS, loyaltyPrograms: LOYALTY_PROGRAMS,
       issuerNames: ISSUER_NAMES, cards: CARDS, valuations: VALUATION } = data);
    SUB_CATEGORIES = data.subCategories || {};
    // Sample wallet: cards marked owned:true, in the order they were added for the sample (a card's
    // dot color follows the order it was added); any other owned:true card goes last
    const sampleOrder = ['Amex Blue Cash Preferred', 'Chase Sapphire Reserve', 'Amex Gold', 'Chase Prime Visa', 'Amex Marriott Bonvoy Brilliant'];
    const rank = name => (i => i < 0 ? sampleOrder.length : i)(sampleOrder.indexOf(name));
    owned = new Set(CARDS.filter(c => c.owned).map(c => c.name).sort((a, b) => rank(a) - rank(b)));
    SPEND_LINES = buildSpendLines();
    // Adding a card: note any Monthly spend rows it brings in (see renderNewRowsNote)
    const addToWallet = c => {
      const before = new Set(SPEND_LINES.map(l => l.key));
      owned.add(c.name);
      const lines = buildSpendLines().filter(l => !before.has(l.key));
      if (lines.length) newRowNotes.push({ card: c, lines });
      buildWallet(); refreshSpendLines(); recalc();
    };
    initCardPicker('card-picker', {
      exclude: c => owned.has(c.name),
      onPick: addToWallet
    });
    initCardPicker('util-picker', {
      exclude: c => cardsUnderReview.has(c.name),
      onPick: c => { cardsUnderReview.add(c.name); renderUtilCards(); }
    });
    buildWallet();
    buildSpend();
    recalc();
    initInfoButton('val-source-btn', 'val-source');
  });
