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
let spend = { Dining:500, Grocery:400, Travel:300, Gas:150, Streaming:50, Shopping:200, Other:400 };
let cpp = 0.018;
let cardSpend = {}; // { cardName: { Dining: 0, Grocery: 0, ... } }

// ─────────────────────────────────────────────────────────────
// BUILD UI
// ─────────────────────────────────────────────────────────────
function buildWallet() {
  populateWalletSelect();
  renderWalletChips();
  if (document.getElementById('util-card-select')) { populateUtilSelect(); renderUtilCards(); }
}

function populateWalletSelect() {
  const sel = document.getElementById('wallet-select');
  sel.innerHTML = '<option value="">+ Add a card…</option>';

  const byIssuer = {};
  CARDS.forEach(c => {
    if (owned.has(c.name)) return; // already added, don't offer again
    (byIssuer[c.issuer] = byIssuer[c.issuer] || []).push(c);
  });

  Object.keys(byIssuer).sort().forEach(issuer => {
    const group = document.createElement('optgroup');
    group.label = issuer;
    byIssuer[issuer]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = `${c.name} — $${c.fee}/yr`;
        group.appendChild(opt);
      });
    sel.appendChild(group);
  });
}

function renderWalletChips() {
  const el = document.getElementById('wallet-chips');
  el.innerHTML = '';
  CARDS.filter(c => owned.has(c.name)).forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.title = `${c.issuer} · $${c.fee}/yr · ${c.note}`;
    chip.innerHTML = `<span>${c.name}</span><span class="chip-x">✕</span>`;
    chip.querySelector('.chip-x').onclick = (e) => {
      e.stopPropagation();
      owned.delete(c.name);
      buildWallet();
      document.getElementById('owned-count').textContent = owned.size + ' card' + (owned.size !== 1 ? 's' : '');
      recalc();
    };
    el.appendChild(chip);
  });
  document.getElementById('owned-count').textContent = owned.size + ' card' + (owned.size !== 1 ? 's' : '');
}

document.getElementById('wallet-select').addEventListener('change', function() {
  if (!this.value) return;
  owned.add(this.value);
  this.value = '';
  buildWallet();
  recalc();
});

function buildSpend() {
  const el = document.getElementById('spend-panel');
  el.innerHTML = '';
  CATS.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'spend-row';
    row.innerHTML = `<span class="spend-label">${cat}</span>
      <div class="spend-input-wrap">
        <span>$</span>
        <input type="number" value="${spend[cat]}" min="0" step="50" data-cat="${cat}">
      </div>`;
    row.querySelector('input').addEventListener('input', function() {
      spend[this.dataset.cat] = Math.max(0, parseInt(this.value)||0);
      recalc();
    });
    el.appendChild(row);
  });
}

function buildValuation() {
  const el = document.getElementById('val-rows');
  el.innerHTML = '';
  VALUATION.forEach(v => {
    const vals = [v.sc, v.portal, v.eco, v.biz].filter(x=>x!==null);
    const best = vals.length ? Math.max(...vals) : 0;
    const fmt = n => n === null
      ? `<div class="val-cell na">—</div>`
      : `<div class="val-cell ${n===best?'best':''}">${n.toFixed(2)}¢</div>`;
    el.innerHTML += `<div class="val-data-row">
      <div class="val-cell name">${v.name}</div>
      ${fmt(v.sc)}${fmt(v.portal)}${fmt(v.eco)}${fmt(v.biz)}
      <div class="val-cell bal">${v.bal.toLocaleString()}</div>
    </div>`;
  });
}

// ─────────────────────────────────────────────────────────────
// RECALC
// ─────────────────────────────────────────────────────────────
function getBest(cat, ownedOnly) {
  let best = null, bestRate = 0;
  CARDS.forEach(c => {
    if (ownedOnly && !owned.has(c.name)) return;
    if (!ownedOnly && c.coBrand) return; // exclude co-brand cards from "best available" — their high rates are brand-restricted, not general category multipliers
    const r = c.rates[cat] || 1;
    if (r > bestRate) { bestRate = r; best = c; }
  });
  return { card: best, rate: Math.max(bestRate, 1) };
}

function rateClass(r) {
  if (r >= 5) return 'rate-5x';
  if (r >= 4) return 'rate-4x';
  if (r >= 3) return 'rate-3x';
  if (r >= 2) return 'rate-2x';
  return 'rate-1x';
}

function recalc() {
  let totalPts = 0, maxPts = 0;
  const rows = [];

  CATS.forEach(cat => {
    const mo = spend[cat] || 0;
    const ann = mo * 12;
    const { card: ownedCard, rate: ownedRate } = getBest(cat, true);
    const { card: bestCard,  rate: bestRate  } = getBest(cat, false);
    const earned = ann * ownedRate;
    const possible = ann * bestRate;
    totalPts += earned;
    maxPts   += possible;
    rows.push({ cat, mo, ann, ownedCard, ownedRate, earned, bestCard, bestRate, possible });
  });

  const gap = Math.max(0, maxPts - totalPts);
  const val = totalPts * cpp;
  const gapVal = gap * cpp;

  // KPIs
  document.getElementById('k-pts').textContent = fmt0(totalPts);
  document.getElementById('k-val').textContent = '$' + fmt0(val);
  document.getElementById('k-gap-pts').textContent = fmt0(gap);
  document.getElementById('k-gap-val').textContent = '$' + fmt0(gapVal);
  document.getElementById('k-cpp-sub').textContent = `@ ${(cpp*100).toFixed(1)}¢/pt`;

  // Optimizer table
  document.getElementById('opt-tbody').innerHTML = rows.map(r => {
    const gapPts = Math.round(r.possible - r.earned);
    const sameCard = r.ownedCard && r.bestCard && r.ownedCard.name === r.bestCard.name;
    return `<tr>
      <td class="cat-name">${r.cat}</td>
      <td class="mono">$${r.mo.toLocaleString()}</td>
      <td class="card-name ${r.ownedCard?'':'none'}">${r.ownedCard ? r.ownedCard.name : 'None owned'}</td>
      <td><span class="rate-badge ${rateClass(r.ownedRate)}">${r.ownedRate}x</span></td>
      <td class="mono">${fmt0(r.earned)}</td>
      <td class="card-name" style="color:var(--muted2);font-size:12px">${r.bestCard ? r.bestCard.name : '—'}</td>
      <td><span class="rate-badge ${rateClass(r.bestRate)}">${r.bestRate}x</span></td>
      <td class="gap-val ${gapPts > 0 && !sameCard ? 'pos' : 'zero'}">${gapPts > 0 && !sameCard ? '+'+fmt0(gapPts) : '—'}</td>
    </tr>`;
  }).join('');

  // Breakdown bars
  const maxEarned = Math.max(...rows.map(r => r.earned), 1);
  document.getElementById('breakdown-panel').innerHTML = rows.map((r, i) =>
    `<div class="breakdown-row">
      <span class="b-label">${r.cat}</span>
      <div class="b-track"><div class="b-fill" style="width:${Math.round(r.earned/maxEarned*100)}%;background:${CAT_COLORS[i]}"></div></div>
      <span class="b-val">${fmt0(r.earned)}</span>
    </div>`
  ).join('');

  // Fee coverage
  renderFeeCoverage();

  // Gap analysis
  const notOwned = CARDS.filter(c => !owned.has(c.name));
  const scored = notOwned.map(c => {
    let uplift = 0;
    const winCats = [];
    CATS.forEach(cat => {
      const currentRate = getBest(cat, true).rate;
      const newRate = c.rates[cat] || 1;
      if (newRate > currentRate) {
        uplift += (spend[cat]||0) * 12 * (newRate - currentRate) * cpp;
        winCats.push(cat);
      }
    });
    return { card:c, uplift, winCats };
  }).filter(x => x.uplift > 1).sort((a,b) => b.uplift - a.uplift).slice(0,4);

  const gapEl = document.getElementById('gap-container');
  if (scored.length === 0) {
    gapEl.innerHTML = `<div class="empty-gap"><p>You already own the top cards for your current spend profile. Try adjusting your spend or removing a card.</p></div>`;
  } else {
    gapEl.innerHTML = `<div class="gap-grid">${scored.map((s,i) => `
      <div class="gap-card ${i===0?'top':''}">
        <div class="gap-rank">${i===0?'// top pick':'// #'+(i+1)}</div>
        <div class="gap-name">${s.card.name}</div>
        <div class="gap-note">${s.card.note}</div>
        <div class="gap-uplift">+$${fmt0(s.uplift)}</div>
        <div class="gap-uplift-label">est. annual uplift</div>
        <div class="gap-cats">${s.winCats.map(c=>`<span class="gap-cat-pill">${c}</span>`).join('')}</div>
      </div>`).join('')}</div>`;
  }
}

function renderFeeCoverage() {
  const el = document.getElementById('fee-grid');
  const ownedCards = CARDS.filter(c => owned.has(c.name));

  if (ownedCards.length === 0) {
    el.innerHTML = `<div class="empty-gap"><p>Add cards to your wallet to see fee coverage.</p></div>`;
    return;
  }

  el.innerHTML = ownedCards.map(c => {
    // Points this specific card earns across your actual monthly spend, annualized
    let annualPts = 0;
    CATS.forEach(cat => {
      const rate = c.rates[cat] || 1;
      annualPts += (spend[cat] || 0) * 12 * rate;
    });
    const earnedVal = annualPts * cpp;
    const net = earnedVal - c.fee;

    let cls, tag;
    if (c.fee === 0) {
      cls = 'free'; tag = 'No annual fee';
    } else if (net >= 0) {
      cls = 'covered'; tag = 'Fee covered';
    } else {
      cls = 'short'; tag = 'Fee not covered';
    }

    return `<div class="fee-card ${cls}">
      <div class="fee-name">${c.name}</div>
      <div class="fee-issuer">${c.issuer}</div>
      <div class="fee-row"><span>Annual fee</span><span class="v">$${c.fee}</span></div>
      <div class="fee-row"><span>Points earned/yr</span><span class="v">${fmt0(annualPts)}</span></div>
      <div class="fee-row"><span>Value @ ${(cpp*100).toFixed(1)}¢/pt</span><span class="v">$${fmt0(earnedVal)}</span></div>
      <div class="fee-net">
        <span class="fee-net-label">NET</span>
        <span class="fee-net-val">${net >= 0 ? '+' : ''}$${fmt0(net)}</span>
      </div>
      <div class="fee-tag">${tag}</div>
    </div>`;
  }).join('');
}

function fmt0(n) { return Math.round(n).toLocaleString(); }

// ─────────────────────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'utilization') { populateUtilSelect(); renderUtilCards(); }
  });
});

// ─────────────────────────────────────────────────────────────
// CARD UTILIZATION TAB
// ─────────────────────────────────────────────────────────────
let cardsUnderReview = new Set(); // card names currently shown in the utilization tab

function populateUtilSelect() {
  const bankSel = document.getElementById('util-bank-select');
  const cardSel = document.getElementById('util-card-select');
  const prevBank = bankSel.value;

  bankSel.innerHTML = '<option value="">Select a bank…</option>';
  Object.keys(ISSUER_NAMES).forEach(code => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = ISSUER_NAMES[code];
    bankSel.appendChild(opt);
  });

  if (prevBank) {
    bankSel.value = prevBank;
    populateUtilCardSelect(prevBank);
  } else {
    cardSel.innerHTML = '<option value="">Select a bank first…</option>';
    cardSel.disabled = true;
  }
}

function populateUtilCardSelect(issuerCode) {
  const cardSel = document.getElementById('util-card-select');
  cardSel.innerHTML = '<option value="">Select a card…</option>';
  cardSel.disabled = false;
  CARDS.filter(c => c.issuer === issuerCode && !cardsUnderReview.has(c.name)).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = `${c.name} — $${c.fee}/yr`;
    cardSel.appendChild(opt);
  });
}

document.getElementById('util-bank-select').addEventListener('change', function() {
  if (!this.value) {
    document.getElementById('util-card-select').innerHTML = '<option value="">Select a bank first…</option>';
    document.getElementById('util-card-select').disabled = true;
    return;
  }
  populateUtilCardSelect(this.value);
});

document.getElementById('util-card-select').addEventListener('change', function() {
  if (!this.value) return;
  cardsUnderReview.add(this.value);
  const bankSel = document.getElementById('util-bank-select');
  const chosenBank = bankSel.value;
  this.value = '';
  populateUtilSelect();
  if (chosenBank) { bankSel.value = chosenBank; populateUtilCardSelect(chosenBank); }
  renderUtilCards();
});

function renderUtilCards() {
  const container = document.getElementById('util-cards-container');
  if (cardsUnderReview.size === 0) {
    container.innerHTML = `<div class="util-empty">Pick a card below to see how well you're using it.</div>`;
    return;
  }

  container.innerHTML = '';
  cardsUnderReview.forEach(cardName => {
    const card = CARDS.find(c => c.name === cardName);
    if (!card) return;

    const isPortalSplit = card.portalRate && typeof card.portalRate === 'object';
    const portalSubTypes = isPortalSplit
      ? ['Flights','Hotels','Cars'].filter(t => card.portalRate[t] !== undefined)
      : [];
    const portalKeys = card.travelSplit
      ? portalSubTypes.map(t => 'Portal' + t) // travelSplit cards: only portal keys needed (Travel* keys come from travelSplit branch below)
      : (isPortalSplit ? portalSubTypes.map(t => 'Portal' + t) : (card.portalRate ? ['Portal'] : []));
    const travelSplitKeys = card.travelSplit ? ['Flights','Hotels','Cars'].map(t => 'Travel' + t) : [];
    const subRateKeys = card.subRates
      ? Object.keys(card.subRates).flatMap(cat => Object.keys(card.subRates[cat]).map(label => 'Sub_' + cat + '_' + label.replace(/[^a-zA-Z0-9]/g, '_')))
      : [];
    const allExtraKeys = [...portalKeys, ...travelSplitKeys, ...subRateKeys];

    if (!cardSpend[cardName]) {
      cardSpend[cardName] = {};
      CATS.forEach(cat => cardSpend[cardName][cat] = 0);
      allExtraKeys.forEach(k => cardSpend[cardName][k] = 0);
    } else {
      allExtraKeys.forEach(k => { if (cardSpend[cardName][k] === undefined) cardSpend[cardName][k] = 0; });
    }
    const cs = cardSpend[cardName];
    const blockId = 'util-block-' + cardName.replace(/[^a-zA-Z0-9]/g, '-');

    const block = document.createElement('div');
    block.className = 'util-card-block';
    block.innerHTML = `
      <div class="util-card-header">
        <div>
          <h4 style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700">${card.name}</h4>
          <div class="util-spend-sub">${card.issuer} · $${card.fee}/yr annual fee · ${
            card.currency === 'cash' ? 'Cash back (fixed 1¢/pt)' :
            card.currency === 'cobrand' && LOYALTY_PROGRAMS[card.program] ? LOYALTY_PROGRAMS[card.program].label + ' (fixed)' :
            'Transferable points (uses your slider)'
          }</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="util-swap-select" data-card="${cardName}" style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;color:var(--muted2);font-family:'JetBrains Mono',monospace;font-size:11px;padding:4px 8px;cursor:pointer">
            <option value="">Change card…</option>
          </select>
          <button class="util-remove-btn" data-card="${cardName}">Remove ✕</button>
        </div>
      </div>
      <div class="util-grid">
        <div class="util-spend-panel">
          <div id="${blockId}-rows"></div>
        </div>
        <div>
          <div class="util-credits-panel">
            <div class="section-label" style="margin-bottom:12px">Other card benefits</div>
            ${(card.perks && card.perks.length) ? card.perks.map(p => `
            <div class="util-credit-row">
              <span class="util-credit-icon">✦</span>
              <span>${p}</span>
            </div>`).join('') : `
            <div class="util-credit-row">
              <span class="util-credit-icon">✦</span>
              <span>No additional statement credits or perks beyond points earning.</span>
            </div>`}
            <p style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5">
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

    document.getElementById(`${blockId}-rows`).innerHTML = CATS.map(cat => {
      if (card.subRates && card.subRates[cat]) {
        // Generic named sub-rows for this category (e.g. Grocery -> Whole Foods / Other groceries)
        let subHtml = '';
        Object.keys(card.subRates[cat]).forEach(label => {
          const subRate = card.subRates[cat][label];
          const subKey = 'Sub_' + cat + '_' + label.replace(/[^a-zA-Z0-9]/g, '_');
          subHtml += `
      <div class="spend-row">
        <span class="spend-label">${cat} — ${label}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(subRate)}">${subRate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="${subKey}" value="${cs[subKey] || 0}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
        });
        return subHtml;
      }
      if (cat === 'Travel' && card.travelSplit) {
        // Direct Flights / Hotels / Cars rows
        let travelHtml = '';
        ['Flights','Hotels','Cars'].forEach(t => {
          const directRate = card.travelSplit[t];
          const tKey = 'Travel' + t;
          travelHtml += `
      <div class="spend-row">
        <span class="spend-label">Travel — ${t}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(directRate)}">${directRate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="${tKey}" value="${cs[tKey] || 0}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
        });
        // Portal Flights / Hotels / Cars rows, as their own peer group — always shown alongside direct, even when the rate is identical
        if (card.portalRate && typeof card.portalRate === 'object') {
          ['Flights','Hotels','Cars'].forEach(t => {
            if (card.portalRate[t] === undefined) return;
            const pRate = card.portalRate[t];
            const pKey = 'Portal' + t;
            travelHtml += `
      <div class="spend-row">
        <span class="spend-label">${card.portalLabel} — ${t}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(pRate)}">${pRate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="${pKey}" value="${cs[pKey] || 0}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
          });
        }
        return travelHtml;
      }

      const rate = card.rates[cat] || 1;
      let rowHtml = `
      <div class="spend-row">
        <span class="spend-label">${cat}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(rate)}">${rate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="${cat}" value="${cs[cat]}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
      // Portal booking: separate row(s) right after regular Travel, only for cards with a distinct portal rate and no travelSplit
      if (cat === 'Travel' && card.portalRate && !card.travelSplit) {
        if (isPortalSplit) {
          portalSubTypes.forEach(t => {
            const key = 'Portal' + t;
            const pRate = card.portalRate[t];
            rowHtml += `
      <div class="spend-row">
        <span class="spend-label">${card.portalLabel} — ${t}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(pRate)}">${pRate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="${key}" value="${cs[key] || 0}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
          });
        } else {
          rowHtml += `
      <div class="spend-row">
        <span class="spend-label">${card.portalLabel}</span>
        <div class="util-spend-row-rate">
          <span class="rate-badge ${rateClass(card.portalRate)}">${card.portalRate}x</span>
          <div class="spend-input-wrap">
            <span>$</span>
            <input type="number" class="util-spend-input" data-card="${cardName}" data-cat="Portal" value="${cs.Portal || 0}" min="0" step="10">
          </div>
        </div>
      </div>
    `;
        }
      }
      return rowHtml;
    }).join('');

    block.querySelectorAll('.util-spend-input').forEach(input => {
      input.addEventListener('input', function() {
        cardSpend[this.dataset.card][this.dataset.cat] = Math.max(0, parseFloat(this.value) || 0);
        renderUtilResult(card, cardSpend[this.dataset.card], blockId);
      });
    });

    renderUtilResult(card, cs, blockId);
  });

  // Remove buttons
  container.querySelectorAll('.util-remove-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      cardsUnderReview.delete(this.dataset.card);
      populateUtilSelect();
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

      // Carry over universal category spend; portal-specific sub-fields are card-shape-dependent so we leave them behind
      const oldSpend = cardSpend[oldName] || {};
      const carried = {};
      CATS.forEach(cat => carried[cat] = oldSpend[cat] || 0);
      cardSpend[newName] = carried;

      // Rebuild the Set in the same order, swapping oldName -> newName in place
      const ordered = Array.from(cardsUnderReview).map(n => n === oldName ? newName : n);
      cardsUnderReview = new Set(ordered);

      populateUtilSelect();
      renderUtilCards();
    });
  });
}

function renderUtilResult(card, cs, blockId) {
  let annualPts = 0;
  CATS.forEach(cat => {
    if (cat === 'Travel' && card.travelSplit) return; // handled separately below
    if (card.subRates && card.subRates[cat]) return; // handled separately below
    const rate = card.rates[cat] || 1;
    annualPts += (cs[cat] || 0) * 12 * rate;
  });

  if (card.subRates) {
    Object.keys(card.subRates).forEach(cat => {
      Object.keys(card.subRates[cat]).forEach(label => {
        const subKey = 'Sub_' + cat + '_' + label.replace(/[^a-zA-Z0-9]/g, '_');
        const subRate = card.subRates[cat][label];
        annualPts += (cs[subKey] || 0) * 12 * subRate;
      });
    });
  }

  if (card.travelSplit) {
    ['Flights','Hotels','Cars'].forEach(t => {
      const directRate = card.travelSplit[t];
      annualPts += (cs['Travel' + t] || 0) * 12 * directRate;
      if (card.portalRate && typeof card.portalRate === 'object' && card.portalRate[t] !== undefined) {
        annualPts += (cs['Portal' + t] || 0) * 12 * card.portalRate[t];
      }
    });
  } else if (card.portalRate) {
    if (typeof card.portalRate === 'object') {
      ['Flights','Hotels','Cars'].forEach(t => {
        if (card.portalRate[t] !== undefined) {
          annualPts += (cs['Portal' + t] || 0) * 12 * card.portalRate[t];
        }
      });
    } else {
      annualPts += (cs.Portal || 0) * 12 * card.portalRate;
    }
  }
  // Determine the right cents-per-point for this card's actual currency
  let effectiveCpp, cppLabel;
  if (card.currency === 'cash') {
    effectiveCpp = 0.01; // fixed cash-back-equivalent value, not adjustable
    cppLabel = '1.0¢/pt (fixed — cash back)';
  } else if (card.currency === 'cobrand' && LOYALTY_PROGRAMS[card.program]) {
    effectiveCpp = LOYALTY_PROGRAMS[card.program].cpp;
    cppLabel = `${(effectiveCpp*100).toFixed(1)}¢/pt (fixed — ${LOYALTY_PROGRAMS[card.program].label})`;
  } else {
    effectiveCpp = cpp; // transferable bank points use the user's adjustable slider
    cppLabel = `${(cpp*100).toFixed(1)}¢/pt`;
  }

  const earnedVal = annualPts * effectiveCpp;
  const net = earnedVal - card.fee;
  const covered = net >= 0;

  document.getElementById(`${blockId}-result`).innerHTML = `
    <div class="util-result-bar ${covered ? 'covered' : 'short'}">
      <div>
        <div class="util-result-label">Points earned/yr</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--text);margin-top:4px">${fmt0(annualPts)} pts · $${fmt0(earnedVal)} @ ${cppLabel}</div>
      </div>
      <div style="text-align:right">
        <div class="util-result-label">Net vs $${card.fee} fee</div>
        <div class="util-result-val">${net >= 0 ? '+' : ''}$${fmt0(net)}</div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
document.getElementById('cpp-input').addEventListener('input', function() {
  cpp = Math.max(0.005, parseFloat(this.value)||0.018) / 100;
  recalc();
  renderUtilCards();
});

const dataReady = window.STACKWISE_DATA
  ? Promise.resolve(window.STACKWISE_DATA)
  : fetch('stackwise-data.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

dataReady
  .catch(err => {
    document.querySelector('.main').insertAdjacentHTML('afterbegin',
      `<p style="grid-column:1/-1;color:var(--red);font-size:13px">Couldn't load card data (${err.message}). Keep stackwise-data.js next to stackwise.html, or serve the page from a web server so stackwise-data.json can load.</p>`);
    throw err;
  })
  .then(data => {
    ({ categories: CATS, categoryColors: CAT_COLORS, loyaltyPrograms: LOYALTY_PROGRAMS,
       issuerNames: ISSUER_NAMES, cards: CARDS, valuations: VALUATION } = data);
    owned = new Set(CARDS.filter(c => c.owned).map(c => c.name));
    buildWallet();
    buildSpend();
    buildValuation();
    recalc();
  });
