/* ============================================================
   STATE
   ============================================================ */
let ALL_CARDS = [];
let collectionState = {}; // keyed by card id: { inCollection, condition, notes, purchasePrice, purchaseDate, wantList }
let filteredCards = [];
let currentView = 'grid';
let currentModalCard = null;
let chatHistory = [];
let quickScanOpen = false;
let searchTimeout = null;
let saveTimeout = null;
let imageCache = {}; // cardId -> image URL
let priceCache = {}; // cardId -> { data, timestamp }
let adminToken = null;
let bulkMode = false;
let bulkSelected = new Set();
let unlockedAchievements = {};

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;

const CONDITIONS = ['Mint','NM','LP','MP','HP','HP+'];
const ERA_ORDER = ['Black & White','XY','Sun & Moon','Sword & Shield','Scarlet & Violet','Mega Evolution'];
const ERA_KEYS = { 'Black & White':'bw','XY':'xy','Sun & Moon':'sm','Sword & Shield':'ss','Scarlet & Violet':'sv','Mega Evolution':'mega' };

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  initCanvas();
  await loadCards();
  loadCollectionFromStorage();
  loadCollectionFromServer();
  setupFilters();
  setupViewTabs();
  setupGrading();
  setupQuickScan();
  verifyAdminToken();
  loadAchievements();
  applyTheme(localStorage.getItem('trainerVaultTheme') || 'dark');
  applyFiltersAndRender();

  // Register service worker for PWA / offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Auto-collapse stats on mobile
  if (window.innerWidth <= 768) {
    const sr = document.getElementById('statsRow');
    if (sr) sr.classList.add('stats-collapsed');
  }

  // Filters toggle (JS fallback for browsers without :has())
  const cb = document.getElementById('filtersCheckbox');
  const fb = document.getElementById('filtersBar');
  if (cb && fb) {
    cb.addEventListener('change', () => {
      fb.style.display = cb.checked ? '' : 'none';
    });
    // Auto-collapse filters on mobile
    if (window.innerWidth <= 768) { cb.checked = false; fb.style.display = 'none'; }
  }
});

/* ============================================================
   LOAD CARDS (static JSON file — works on any host)
   ============================================================ */
async function loadCards() {
  let raw = null;
  // Try API endpoint first (supports admin-modified cards)
  try {
    const resp = await fetch('/api/cards');
    if (resp.ok) raw = await resp.json();
  } catch(e) {}
  // Fallback to static file
  if (!raw) {
    try {
      const resp = await fetch('/trainer_vault_cards.json');
      if (resp.ok) raw = await resp.json();
    } catch(e) {}
  }
  if (raw && Array.isArray(raw)) {
    ALL_CARDS = raw.map(c => ({
      id: c.id,
      name: c.name,
      cardNumber: c.card_number,
      set: c.set_name,
      era: c.era,
      variant: c.variant,
    }));
  }
  if (!ALL_CARDS.length) {
    console.error('No cards loaded!');
  }
}

/* ============================================================
   COLLECTION STATE MANAGEMENT
   ============================================================ */
function getCardState(id) {
  if (!collectionState[id]) {
    collectionState[id] = { inCollection: false, condition: null, notes: '', purchasePrice: null, purchaseDate: null, wantList: false };
  }
  return collectionState[id];
}

function loadCollectionFromStorage() {
  try {
    const saved = localStorage.getItem('trainerVaultCollection');
    if (saved) collectionState = JSON.parse(saved);
  } catch(e) { console.warn('localStorage load failed', e); }
}

let serverSavePending = false;

function saveCollection() {
  // Always save to localStorage immediately — this is the primary store
  try { localStorage.setItem('trainerVaultCollection', JSON.stringify(collectionState)); } catch(e) {}
  checkMilestones();
  serverSavePending = true;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    flushToServer();
  }, 2000);
}

function flushToServer() {
  if (!serverSavePending) return;
  serverSavePending = false;
  fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectionState)
  }).catch(() => {});
}

// Flush pending saves when the user leaves / refreshes the page
window.addEventListener('beforeunload', () => {
  // Save to localStorage one final time
  try { localStorage.setItem('trainerVaultCollection', JSON.stringify(collectionState)); } catch(e) {}
  // Use sendBeacon for reliable server save during unload
  if (serverSavePending) {
    serverSavePending = false;
    try {
      navigator.sendBeacon('/api/collection', new Blob([JSON.stringify(collectionState)], { type: 'application/json' }));
    } catch(e) {}
  }
});

async function loadCollectionFromServer() {
  try {
    const resp = await fetch('/api/collection');
    if (resp.ok) {
      const data = await resp.json();
      if (data && Object.keys(data).length > 0) {
        // Only fill in keys the local state doesn't have — localStorage is the source of truth
        let merged = false;
        for (const key in data) {
          if (!collectionState[key]) {
            collectionState[key] = data[key];
            merged = true;
          }
        }
        if (merged) {
          localStorage.setItem('trainerVaultCollection', JSON.stringify(collectionState));
          applyFiltersAndRender();
        }
      }
    }
  } catch(e) {}
}

/* ============================================================
   FILTERS
   ============================================================ */
let activeEra = 'All', activeVariant = 'All', activeColl = 'All', activeCond = 'All', searchQuery = '';

function setupFilters() {
  // Era pills
  document.querySelectorAll('#eraFilters .filter-pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#eraFilters .filter-pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      activeEra = p.dataset.era;
      applyFiltersAndRender();
    });
  });
  // Variant pills
  document.querySelectorAll('#variantFilters .filter-pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#variantFilters .filter-pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      activeVariant = p.dataset.variant;
      applyFiltersAndRender();
    });
  });
  // Collection pills
  document.querySelectorAll('#collectionFilters .filter-pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#collectionFilters .filter-pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      activeColl = p.dataset.coll;
      applyFiltersAndRender();
    });
  });
  // Condition pills
  document.querySelectorAll('#conditionFilters .filter-pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#conditionFilters .filter-pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      activeCond = p.dataset.cond;
      applyFiltersAndRender();
    });
  });
  // Search
  document.getElementById('searchBox').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery = e.target.value.trim().toLowerCase();
      applyFiltersAndRender();
    }, 150);
  });
  // Sort
  document.getElementById('sortSelect').addEventListener('change', () => applyFiltersAndRender());
}

function applyFiltersAndRender() {
  filteredCards = ALL_CARDS.filter(card => {
    const st = getCardState(card.id);
    if (activeEra !== 'All' && card.era !== activeEra) return false;
    if (activeVariant !== 'All' && card.variant !== activeVariant) return false;
    if (activeColl === 'Collected' && !st.inCollection) return false;
    if (activeColl === 'Not Collected' && st.inCollection) return false;
    if (activeColl === 'Want List' && !st.wantList) return false;
    if (activeCond !== 'All' && st.condition !== activeCond) return false;
    if (searchQuery) {
      const q = searchQuery;
      const haystack = (card.name + ' ' + card.set + ' ' + card.cardNumber + ' ' + card.era + ' ' + card.variant).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Sort
  const sortBy = document.getElementById('sortSelect').value;
  filteredCards.sort((a, b) => {
    const sa = getCardState(a.id), sb = getCardState(b.id);
    switch(sortBy) {
      case 'name': return a.name.localeCompare(b.name);
      case 'set': return a.set.localeCompare(b.set) || a.name.localeCompare(b.name);
      case 'era': return ERA_ORDER.indexOf(a.era) - ERA_ORDER.indexOf(b.era) || a.set.localeCompare(b.set);
      case 'condition': return (CONDITIONS.indexOf(sa.condition)||99) - (CONDITIONS.indexOf(sb.condition)||99);
      case 'price': return ((sb.purchasePrice||0) - (sa.purchasePrice||0));
      case 'recent': {
        const da = sa.purchaseDate || '', db = sb.purchaseDate || '';
        if (da || db) return db.localeCompare(da);
        return (sb.inCollection ? 1 : 0) - (sa.inCollection ? 1 : 0);
      }
      case 'id': return a.id - b.id;
      default: return 0;
    }
  });

  document.getElementById('resultsCount').textContent = `Showing ${filteredCards.length} of ${ALL_CARDS.length}`;
  renderCurrentView();
  updateStats();
}

/* ============================================================
   VIEW TABS
   ============================================================ */
function setupViewTabs() {
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentView = tab.dataset.view;
      document.getElementById('cardGrid').classList.toggle('active', currentView === 'grid');
      document.getElementById('timelineView').classList.toggle('active', currentView === 'timeline');
      document.getElementById('setAccordionView').classList.toggle('active', currentView === 'sets');
      document.getElementById('wantListView').classList.toggle('active', currentView === 'wantlist');
      renderCurrentView();
    });
  });
}

function renderCurrentView() {
  switch(currentView) {
    case 'grid': renderGrid(); break;
    case 'timeline': renderTimeline(); break;
    case 'sets': renderSetAccordion(); break;
    case 'wantlist': renderWantList(); break;
  }
}

/* ============================================================
   RENDER: GRID VIEW (with Intersection Observer virtualization)
   ============================================================ */
function renderGrid() {
  const grid = document.getElementById('cardGrid');
  grid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  filteredCards.forEach((card, idx) => {
    const st = getCardState(card.id);
    const tile = document.createElement('div');
    tile.className = 'card-tile glass card-enter ' + (st.inCollection ? 'collected' : 'uncollected') + (bulkMode && bulkSelected.has(card.id) ? ' bulk-selected' : '');
    tile.dataset.id = card.id;
    tile.style.animationDelay = Math.min(idx * 18, 600) + 'ms';

    const eraKey = ERA_KEYS[card.era] || 'bw';
    const condClass = st.condition ? ('cond-' + st.condition.replace('+','P')) : '';
    const condBadge = st.condition ? `<span class="badge badge-condition ${condClass}">${st.condition}</span>` : '';
    const wantBadge = st.wantList ? '<span class="badge badge-want">WANT</span>' : '';
    const rarityScore = computeRarityScore(card);
    const rarityStars = rarityScore >= 90 ? '★★★★★' : rarityScore >= 70 ? '★★★★' : rarityScore >= 50 ? '★★★' : rarityScore >= 30 ? '★★' : '★';

    tile.innerHTML = `
      <div class="collected-check">${st.inCollection ? '✓' : ''}</div>
      <div class="tile-rarity">${rarityStars}</div>
      <div>
        <div class="card-name">${escapeHtml(card.name)}</div>
        <div class="card-number">${escapeHtml(card.cardNumber)}</div>
        <div class="card-set">${escapeHtml(card.set)}</div>
      </div>
      <div class="card-badges">
        <span class="badge badge-era era-${eraKey}">${escapeHtml(card.era)}</span>
        <span class="badge badge-variant">${escapeHtml(card.variant)}</span>
        ${condBadge}${wantBadge}
      </div>
    `;

    // Bulk mode: click selects/deselects. Normal: touch=modal, click=toggle, dblclick=modal
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (bulkMode) {
      tile.addEventListener('click', () => {
        if (bulkSelected.has(card.id)) bulkSelected.delete(card.id); else bulkSelected.add(card.id);
        updateBulkCount();
        applyFiltersAndRender();
      });
    } else if (isTouch) {
      tile.addEventListener('click', () => openModal(card.id));
    } else {
      tile.addEventListener('click', (e) => {
        if (e.detail === 1) {
          setTimeout(() => {
            if (!tile._dblclick) toggleCollection(card.id);
            tile._dblclick = false;
          }, 250);
        }
      });
      tile.addEventListener('dblclick', () => {
        tile._dblclick = true;
        openModal(card.id);
      });
    }
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openModal(card.id);
    });

    fragment.appendChild(tile);
  });
  grid.appendChild(fragment);
}

function toggleCollection(cardId) {
  const st = getCardState(cardId);
  st.inCollection = !st.inCollection;
  saveCollection();
  applyFiltersAndRender();
}

/* ============================================================
   RENDER: TIMELINE VIEW
   ============================================================ */
function renderTimeline() {
  const container = document.getElementById('timelineView');
  container.innerHTML = '';

  ERA_ORDER.forEach(era => {
    const eraCards = filteredCards.filter(c => c.era === era);
    if (!eraCards.length) return;

    const section = document.createElement('div');
    section.className = 'timeline-era-section';

    const eraKey = ERA_KEYS[era] || 'bw';
    section.innerHTML = `<div class="timeline-era-header"><span class="badge badge-era era-${eraKey}" style="font-size:0.8rem;padding:4px 12px;">${escapeHtml(era)}</span><div class="era-line"></div></div>`;

    // Group by set
    const sets = {};
    eraCards.forEach(c => { if (!sets[c.set]) sets[c.set] = []; sets[c.set].push(c); });

    Object.entries(sets).forEach(([setName, cards]) => {
      const collected = cards.filter(c => getCardState(c.id).inCollection).length;
      const pct = Math.round((collected / cards.length) * 100);
      const group = document.createElement('div');
      group.className = 'timeline-set-group';
      group.innerHTML = `
        <div class="timeline-set-name">${escapeHtml(setName)}
          <div class="timeline-set-bar"><div class="timeline-set-bar-fill era-${eraKey}" style="width:${pct}%"></div></div>
          <span style="font-size:0.7rem;color:var(--text-dim)">${collected}/${cards.length}</span>
        </div>
        <div class="timeline-cards-row">
          ${cards.map(c => {
            const st = getCardState(c.id);
            return `<span class="timeline-chip ${st.inCollection ? 'collected' : ''}" data-id="${c.id}" onclick="openModal(${c.id})">${escapeHtml(c.name)}</span>`;
          }).join('')}
        </div>
      `;
      section.appendChild(group);
    });

    container.appendChild(section);
  });
}

/* ============================================================
   RENDER: SET ACCORDION VIEW
   ============================================================ */
function renderSetAccordion() {
  const container = document.getElementById('setAccordionView');
  container.innerHTML = '';

  // Group all cards by set (within filtered)
  const sets = {};
  filteredCards.forEach(c => { if (!sets[c.set]) sets[c.set] = { era: c.era, cards: [] }; sets[c.set].cards.push(c); });

  Object.entries(sets).forEach(([setName, info]) => {
    const collected = info.cards.filter(c => getCardState(c.id).inCollection).length;
    const pct = Math.round((collected / info.cards.length) * 100);
    const eraKey = ERA_KEYS[info.era] || 'bw';

    const section = document.createElement('div');
    section.className = 'set-section';
    section.innerHTML = `
      <div class="set-header glass" onclick="this.parentElement.classList.toggle('open')">
        <span class="badge badge-era era-${eraKey}" style="font-size:0.7rem;">${escapeHtml(info.era)}</span>
        <span class="set-title">${escapeHtml(setName)}</span>
        <div class="set-progress-bar"><div class="set-progress-fill era-${eraKey}" style="width:${pct}%"></div></div>
        <span class="set-count">${collected}/${info.cards.length}</span>
        <span class="set-arrow">▼</span>
      </div>
      <div class="set-body set-body-cards">
        ${info.cards.map(c => {
          const st = getCardState(c.id);
          return `<div class="set-card-thumb ${st.inCollection ? 'collected' : ''}" data-card-id="${c.id}" onclick="openModal(${c.id})">
            <div class="set-card-img-wrap">
              <img class="set-card-img" data-card-id="${c.id}" alt="${escapeHtml(c.name)}" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" loading="lazy">
            </div>
            <div class="set-card-info">
              <div class="set-card-name">${escapeHtml(c.name)}</div>
              <div class="set-card-num">${escapeHtml(c.cardNumber)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;

    // Lazy-load images when accordion opens
    const header = section.querySelector('.set-header');
    header.addEventListener('click', () => {
      setTimeout(() => {
        if (section.classList.contains('open')) {
          section.querySelectorAll('.set-card-img[data-card-id]').forEach(img => {
            if (img.dataset.loaded) return;
            const cardId = parseInt(img.dataset.cardId);
            const card = ALL_CARDS.find(cc => cc.id === cardId);
            if (card) {
              const url = getCardThumbnailUrl(card);
              if (url) {
                img.src = url;
                img.dataset.loaded = '1';
                img.onerror = () => { img.style.display = 'none'; };
              }
            }
          });
        }
      }, 50);
    });

    container.appendChild(section);
  });
}

/* Helper: get a thumbnail URL for a card (cached or computed) */
function getCardThumbnailUrl(card) {
  if (imageCache[card.id] && imageCache[card.id] !== 'failed') return imageCache[card.id];

  let setId = SET_IDS[card.set];
  let num = card.cardNumber.split('/')[0].trim();

  if (setId) {
    const tgMatch = num.match(/^TG\d/);
    const ggMatch = num.match(/^GG\d/);
    if (tgMatch) setId += 'tg';
    else if (ggMatch) setId += 'gg';
    else if (card.set === 'Hidden Fates' && num.match(/^SV\d/)) setId = 'sma';
    else if (card.set === 'SV Promos' && num.match(/^SV\d/)) num = num.replace(/^SV/, '');
    else if (card.set === 'XY Promos') num = num.replace(/[a-z]+$/, '');
    return `https://images.pokemontcg.io/${setId}/${num}.png`;
  }
  return null;
}

/* ============================================================
   RENDER: WANT LIST VIEW
   ============================================================ */
function renderWantList() {
  const container = document.getElementById('wantListView');
  container.innerHTML = '';

  const wantCards = ALL_CARDS.filter(c => getCardState(c.id).wantList);
  if (!wantCards.length) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);font-family:DM Mono,monospace;">No cards on your want list yet. Open a card and toggle Want List.</div>';
    container.style.display = 'block';
    return;
  }

  container.classList.add('active');
  wantCards.forEach(card => {
    const st = getCardState(card.id);
    const eraKey = ERA_KEYS[card.era] || 'bw';
    const tile = document.createElement('div');
    tile.className = 'card-tile glass ' + (st.inCollection ? 'collected' : 'uncollected');
    tile.style.opacity = '1';
    tile.innerHTML = `
      <div>
        <div class="card-name" style="color:var(--crimson);">${escapeHtml(card.name)}</div>
        <div class="card-number">${escapeHtml(card.cardNumber)}</div>
        <div class="card-set">${escapeHtml(card.set)}</div>
      </div>
      <div class="card-badges">
        <span class="badge badge-era era-${eraKey}">${escapeHtml(card.era)}</span>
        <span class="badge badge-variant">${escapeHtml(card.variant)}</span>
        ${st.inCollection ? '<span class="badge" style="background:rgba(255,215,0,0.2);color:var(--gold);">OWNED</span>' : '<span class="badge badge-want">NEEDED</span>'}
      </div>
    `;
    tile.addEventListener('click', () => openModal(card.id));
    container.appendChild(tile);
  });
}

/* ============================================================
   ESTIMATED PRICE
   ============================================================ */
function getEstimatedPrice(card) {
  const estimates = { 'Special Illustration Rare': 35, 'Illustration Rare': 12, 'Full Art': 8, 'Rainbow': 15, 'Secret': 10 };
  return estimates[card.variant] || 5;
}

/* ============================================================
   STATS
   ============================================================ */
function updateStats() {
  const total = ALL_CARDS.length;
  const collected = ALL_CARDS.filter(c => getCardState(c.id).inCollection).length;
  const pct = total ? Math.round((collected / total) * 100) : 0;

  document.getElementById('statTotalVal').textContent = total;
  document.getElementById('statCollVal').textContent = `${collected}/${total}`;
  document.getElementById('statPctVal').textContent = pct + '%';

  // Progress ring
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (pct / 100) * circumference;
  document.getElementById('progressRing').style.strokeDashoffset = offset;
  document.getElementById('progressText').textContent = pct + '%';

  // Era bars
  const eraBarsEl = document.getElementById('eraBars');
  eraBarsEl.innerHTML = '';
  ERA_ORDER.forEach(era => {
    const eraTotal = ALL_CARDS.filter(c => c.era === era).length;
    const eraCollected = ALL_CARDS.filter(c => c.era === era && getCardState(c.id).inCollection).length;
    const eraPct = eraTotal ? Math.round((eraCollected / eraTotal) * 100) : 0;
    const eraKey = ERA_KEYS[era] || 'bw';
    const labels = { 'Black & White':'B&W','XY':'XY','Sun & Moon':'S&M','Sword & Shield':'S&S','Scarlet & Violet':'S&V','Mega Evolution':'Mega' };
    eraBarsEl.innerHTML += `
      <div class="era-bar-row">
        <span class="era-bar-label">${labels[era] || era}</span>
        <div class="era-bar-track"><div class="era-bar-fill era-${eraKey}" style="width:${eraPct}%"></div></div>
        <span class="era-bar-count">${eraCollected}/${eraTotal}</span>
      </div>
    `;
  });

  // Value
  let totalVal = 0;
  let estTotalVal = 0;
  ALL_CARDS.forEach(c => {
    const st = getCardState(c.id);
    if (st.purchasePrice) totalVal += parseFloat(st.purchasePrice) || 0;
    if (st.inCollection) estTotalVal += getEstimatedPrice(c) || 0;
  });
  document.getElementById('totalValue').textContent = '$' + totalVal.toFixed(2);
  document.getElementById('statValueVal').textContent = '$' + (totalVal >= 1000 ? (totalVal/1000).toFixed(1)+'k' : totalVal.toFixed(0));
  document.getElementById('valueSub').textContent = collected + ' cards \u00b7 Est. ~$' + estTotalVal;

  // Update recently added
  renderRecentlyAdded();

  // Want count
  const wantCount = ALL_CARDS.filter(c => getCardState(c.id).wantList).length;
  document.getElementById('wantCount').textContent = wantCount;

  // Sparkline
  trackCollectionHistory();
  renderSparkline();

  // New charts
  renderVariantDonut();
  renderTopSets();
  renderCondChart();
  renderVariantRadar();
  renderHeatmapCalendar();
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal(cardId) {
  const card = ALL_CARDS.find(c => c.id === cardId);
  if (!card) return;
  currentModalCard = card;
  const st = getCardState(card.id);

  document.getElementById('modalName').textContent = card.name;
  document.getElementById('modalSub').textContent = `${card.cardNumber} · ${card.set} · ${card.era} · ${card.variant}`;

  // Rarity score badge
  const rscore = computeRarityScore(card);
  const rstars = rscore >= 90 ? '★★★★★' : rscore >= 70 ? '★★★★' : rscore >= 50 ? '★★★' : rscore >= 30 ? '★★' : '★';
  const rlabel = rscore >= 90 ? 'Legendary' : rscore >= 70 ? 'Ultra Rare' : rscore >= 50 ? 'Rare' : rscore >= 30 ? 'Uncommon' : 'Common';
  document.getElementById('modalRarityBadge').innerHTML = `<span class="rarity-stars">${rstars}</span> ${rscore}/100 <span class="rarity-label">${rlabel}</span>`;

  // Reset lore
  const loreText = document.getElementById('modalLoreText');
  loreText.textContent = '';
  loreText.classList.remove('visible');

  // Reset price results
  const priceResults = document.getElementById('priceResults');
  if (priceResults) priceResults.style.display = 'none';
  const priceData = document.getElementById('priceData');
  if (priceData) priceData.innerHTML = '';
  const priceBtn = document.getElementById('priceCheckBtn');
  if (priceBtn) {
    priceBtn.disabled = false;
    priceBtn.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;display:inline-block;vertical-align:middle;stroke:currentColor;fill:none;stroke-width:2;margin-right:6px;"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>Check Price`;
  }

  // Show cached prices immediately if available
  const cached = priceCache[card.id];
  if (cached && cached.data) {
    renderPriceData(card, cached.data);
  }

  // Load card image
  loadCardImage(card);

  // Collection toggle
  const collBtn = document.getElementById('modalCollToggle');
  collBtn.className = 'toggle-btn' + (st.inCollection ? ' active' : '');

  // Want list toggle
  const wantBtn = document.getElementById('modalWantToggle');
  wantBtn.className = 'toggle-btn' + (st.wantList ? ' want-active' : '');

  // Condition selector
  const condSel = document.getElementById('condSelector');
  condSel.innerHTML = '';
  CONDITIONS.forEach(cond => {
    const btn = document.createElement('button');
    btn.className = 'cond-btn' + (st.condition === cond ? (' active-' + cond.replace('+','P')) : '');
    btn.textContent = cond;
    btn.addEventListener('click', () => {
      st.condition = (st.condition === cond) ? null : cond;
      saveCollection();
      openModal(cardId); // refresh
      applyFiltersAndRender();
    });
    condSel.appendChild(btn);
  });

  // Price
  document.getElementById('modalPrice').value = st.purchasePrice || '';
  document.getElementById('modalDate').value = st.purchaseDate || '';
  document.getElementById('modalNotes').value = st.notes || '';

  // Show
  document.getElementById('modalOverlay').classList.add('open');

  // Live-bind inputs
  document.getElementById('modalPrice').oninput = (e) => { st.purchasePrice = parseFloat(e.target.value) || null; saveCollection(); updateStats(); };
  document.getElementById('modalDate').oninput = (e) => { st.purchaseDate = e.target.value || null; saveCollection(); };
  document.getElementById('modalNotes').oninput = (e) => { st.notes = e.target.value; saveCollection(); };

  // Show admin controls if logged in
  const adminControls = document.getElementById('modalAdminControls');
  if (adminControls) adminControls.style.display = isAdminLoggedIn() ? 'block' : 'none';

  // Auto-fetch prices on modal open (refresh stale cache silently)
  const stale = !cached || (Date.now() - cached.timestamp > PRICE_CACHE_TTL_MS);
  if (stale) {
    setTimeout(() => {
      if (currentModalCard && currentModalCard.id === card.id) {
        fetchCardPrices({ silent: true });
      }
    }, 120);
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  currentModalCard = null;
  applyFiltersAndRender();
}

/* ============================================================
   CARD IMAGE LOADING (direct URL — no API key needed)
   ============================================================ */
const SET_IDS = {
  '151':'sv3pt5','Ancient Origins':'xy7','Ascended Heroes':'me2pt5',
  'Astral Radiance':'swsh10','BREAKpoint':'xy9','BREAKthrough':'xy8',
  'Battle Styles':'swsh5','Black Bolt':'zsv10pt5','Boundaries Crossed':'bw7',
  'Brilliant Stars':'swsh9','Burning Shadows':'sm3','Celebrations':'cel25',
  'Celestial Storm':'sm7','Champion\'s Path':'swsh3pt5','Chilling Reign':'swsh6',
  'Cosmic Eclipse':'sm12','Crimson Invasion':'sm4','Crown Zenith':'swsh12pt5',
  'Darkness Ablaze':'swsh3','Destined Rivals':'sv10','Dragon Majesty':'sm7pt5',
  'Evolutions':'xy12','Evolving Skies':'swsh7','Fates Collide':'xy10',
  'Flashfire':'xy2','Forbidden Light':'sm6','Furious Fists':'xy3',
  'Fusion Strike':'swsh8','Guardians Rising':'sm2','Hidden Fates':'sm11pt5',
  'Journey Together':'sv9','Lost Origin':'swsh11','Lost Thunder':'sm8',
  'Mega Evolution':'me1','Noble Victories':'bw3','Obsidian Flames':'sv3',
  'Paldea Evolved':'sv2','Paldean Fates':'sv4pt5','Paradox Rift':'sv4',
  'Phantasmal Flames':'me2','Phantom Forces':'xy4','Plasma Blast':'bw10',
  'Plasma Freeze':'bw9','Plasma Storm':'bw8','Pokemon GO':'pgo',
  'Primal Clash':'xy5','Prismatic Evolutions':'sv8pt5','Rebel Clash':'swsh2',
  'Roaring Skies':'xy6','SV Promos':'svp','SWSH Promos':'swshp',
  'Scarlet & Violet Base':'sv1','Shining Fates':'swsh4pt5',
  'Shining Legends':'sm3pt5','Shrouded Fable':'sv6pt5','Silver Tempest':'swsh12',
  'Steam Siege':'xy11','Stellar Crown':'sv7','Sun & Moon Base':'sm1',
  'Surging Sparks':'sv8','Sword & Shield Base':'swsh1','Team Up':'sm9',
  'Temporal Forces':'sv5','Twilight Masquerade':'sv6','Ultra Prism':'sm5',
  'Unbroken Bonds':'sm10','Unified Minds':'sm11','Vivid Voltage':'swsh4',
  'White Flare':'rsv10pt5','XY Promos':'xyp'
};

function loadCardImage(card) {
  const wrap = document.getElementById('modalImageWrap');

  // Don't permanently cache failures — allow retry
  if (imageCache[card.id] === 'failed') {
    showImagePlaceholder('No image available (tap to retry)');
    wrap.style.cursor = 'pointer';
    wrap.onclick = () => { delete imageCache[card.id]; wrap.onclick = null; wrap.style.cursor = ''; loadCardImage(card); };
    return;
  }

  // If already cached, show immediately
  if (imageCache[card.id]) {
    showCardImage(imageCache[card.id]);
    return;
  }

  // Show loading state
  showImagePlaceholder('Loading card image...');

  let setId = SET_IDS[card.set];
  let num = card.cardNumber.split('/')[0].trim();

  // Handle sub-set prefixes (TG, GG, SV in Hidden Fates)
  if (setId) {
    const tgMatch = num.match(/^TG\d/);
    const ggMatch = num.match(/^GG\d/);
    if (tgMatch) {
      setId += 'tg';
    } else if (ggMatch) {
      setId += 'gg';
    } else if (card.set === 'Hidden Fates' && num.match(/^SV\d/)) {
      setId = 'sma';
    } else if (card.set === 'SV Promos' && num.match(/^SV\d/)) {
      num = num.replace(/^SV/, '');
    } else if (card.set === 'XY Promos') {
      num = num.replace(/[a-z]+$/, '');
    }
  }

  if (setId) {
    // Build direct image URL — no API call needed
    const hiRes = `https://images.pokemontcg.io/${setId}/${num}_hires.png`;
    const loRes = `https://images.pokemontcg.io/${setId}/${num}.png`;
    tryImageUrl(card, hiRes, loRes);
  } else {
    // Unknown set — fall back to API search
    fetchImageFromApi(card, num);
  }
}

function tryImageUrl(card, primaryUrl, fallbackUrl) {
  const img = new Image();
  img.onload = () => {
    imageCache[card.id] = primaryUrl;
    if (currentModalCard && currentModalCard.id === card.id) showCardImage(primaryUrl);
  };
  img.onerror = () => {
    if (fallbackUrl) {
      tryImageUrl(card, fallbackUrl, null);
    } else {
      imageCache[card.id] = 'failed';
      if (currentModalCard && currentModalCard.id === card.id) showImagePlaceholder('No image found (tap to retry)');
    }
  };
  img.src = primaryUrl;
}

function fetchImageFromApi(card, num) {
  const cleanName = card.name.replace(/'/g, '').replace(/\s*\(.*?\)/g, '').trim();
  const nameWords = cleanName.split(/\s+/).map(w => `name:${w}`).join(' ');
  const query = encodeURIComponent(`${nameWords} number:${num}`);
  fetch(`https://api.pokemontcg.io/v2/cards?q=${query}&pageSize=5&select=id,name,number,images`)
    .then(r => r.json())
    .then(data => {
      if (data.data && data.data.length > 0) {
        const match = data.data[0];
        const imgUrl = match.images.large || match.images.small;
        imageCache[card.id] = imgUrl;
        if (currentModalCard && currentModalCard.id === card.id) showCardImage(imgUrl);
      } else {
        imageCache[card.id] = 'failed';
        if (currentModalCard && currentModalCard.id === card.id) showImagePlaceholder('No image found');
      }
    })
    .catch(() => {
      imageCache[card.id] = 'failed';
      if (currentModalCard && currentModalCard.id === card.id) showImagePlaceholder('Could not load image');
    });
}

function showCardImage(url) {
  const wrap = document.getElementById('modalImageWrap');
  const img = document.createElement('img');
  img.className = 'modal-card-image';
  img.alt = 'Card Image';
  img.src = url;
  img.onerror = () => {
    if (currentModalCard) imageCache[currentModalCard.id] = 'failed';
    wrap.innerHTML = `<div class="modal-card-image-placeholder">Image failed to load (tap to retry)</div>`;
    wrap.style.cursor = 'pointer';
    wrap.onclick = () => {
      if (currentModalCard) {
        delete imageCache[currentModalCard.id];
        wrap.onclick = null;
        wrap.style.cursor = '';
        loadCardImage(currentModalCard);
      }
    };
  };
  wrap.innerHTML = '';
  wrap.appendChild(img);
}

function showImagePlaceholder(text) {
  const wrap = document.getElementById('modalImageWrap');
  wrap.innerHTML = `<div class="modal-card-image-placeholder">${escapeHtml(text)}</div>`;
}

function toggleModalCollection() {
  if (!currentModalCard) return;
  const st = getCardState(currentModalCard.id);
  st.inCollection = !st.inCollection;
  saveCollection();
  openModal(currentModalCard.id);
  applyFiltersAndRender();
}

function toggleModalWantList() {
  if (!currentModalCard) return;
  const st = getCardState(currentModalCard.id);
  st.wantList = !st.wantList;
  saveCollection();
  openModal(currentModalCard.id);
  applyFiltersAndRender();
}

// Close modal on overlay click
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});

/* ============================================================
   GRADING ESTIMATOR
   ============================================================ */
function setupGrading() {
  ['gradeCenter','gradeCorners','gradeEdges','gradeSurface'].forEach(id => {
    const el = document.getElementById(id);
    const valId = id.replace('grade','').toLowerCase();
    const valSpan = { gradeCenter:'centerVal', gradeCorners:'cornerVal', gradeEdges:'edgeVal', gradeSurface:'surfaceVal' }[id];
    el.addEventListener('input', () => {
      document.getElementById(valSpan).textContent = el.value;
      updateGradeEstimate();
    });
  });
}

function updateGradeEstimate() {
  const c = parseInt(document.getElementById('gradeCenter').value);
  const co = parseInt(document.getElementById('gradeCorners').value);
  const e = parseInt(document.getElementById('gradeEdges').value);
  const s = parseInt(document.getElementById('gradeSurface').value);
  const avg = (c + co + e + s) / 4;
  // Map 1-5 to PSA 1-10
  const psa = Math.min(10, Math.max(1, Math.round(avg * 2)));
  let rec = '';
  if (psa >= 9) rec = ' — Worth grading!';
  else if (psa >= 7) rec = ' — Consider grading';
  else rec = ' — Keep raw';
  document.getElementById('gradeResult').textContent = `Est. PSA: ${psa}${rec}`;
}

/* ============================================================
   QUICK SCAN MODE
   ============================================================ */
function toggleQuickScan() {
  quickScanOpen = !quickScanOpen;
  document.getElementById('quickScanBar').classList.toggle('active', quickScanOpen);
  if (quickScanOpen) document.getElementById('quickScanInput').focus();
}

function setupQuickScan() {
  const input = document.getElementById('quickScanInput');
  const suggestions = document.getElementById('scanSuggestions');
  let highlightIdx = -1;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { suggestions.style.display = 'none'; return; }
    const matches = ALL_CARDS.filter(c =>
      c.name.toLowerCase().includes(q) || c.cardNumber.toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { suggestions.style.display = 'none'; return; }
    highlightIdx = -1;
    suggestions.innerHTML = matches.map((c, i) => {
      const st = getCardState(c.id);
      return `<div class="scan-suggestion" data-id="${c.id}" data-idx="${i}">${st.inCollection ? '✓ ' : '○ '}${escapeHtml(c.name)} — ${escapeHtml(c.cardNumber)} (${escapeHtml(c.set)})</div>`;
    }).join('');
    suggestions.style.display = 'block';

    suggestions.querySelectorAll('.scan-suggestion').forEach(el => {
      el.addEventListener('click', () => {
        toggleCollection(parseInt(el.dataset.id));
        input.value = '';
        suggestions.style.display = 'none';
        input.focus();
      });
    });
  });

  input.addEventListener('keydown', (e) => {
    const items = suggestions.querySelectorAll('.scan-suggestion');
    if (e.key === 'ArrowDown') { highlightIdx = Math.min(highlightIdx + 1, items.length - 1); updateHighlight(items); e.preventDefault(); }
    if (e.key === 'ArrowUp') { highlightIdx = Math.max(highlightIdx - 1, 0); updateHighlight(items); e.preventDefault(); }
    if (e.key === 'Enter') {
      if (highlightIdx >= 0 && items[highlightIdx]) {
        toggleCollection(parseInt(items[highlightIdx].dataset.id));
        input.value = '';
        suggestions.style.display = 'none';
      }
      e.preventDefault();
    }
    if (e.key === 'Escape') { suggestions.style.display = 'none'; }
  });

  function updateHighlight(items) {
    items.forEach((el, i) => el.classList.toggle('highlighted', i === highlightIdx));
  }
}

/* ============================================================
   CHATBOT
   ============================================================ */
function toggleChatbot() {
  const panel = document.getElementById('chatbotPanel');
  panel.classList.toggle('open');
}

function toggleCondRef() {
  document.getElementById('condRefTable').classList.toggle('expanded');
}

// Quick ask buttons
document.querySelectorAll('.quick-ask-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    let q = btn.dataset.q;
    if (currentModalCard) {
      q = q.replace('[current card]', currentModalCard.name + ' ' + currentModalCard.cardNumber + ' ' + currentModalCard.set);
    }
    document.getElementById('chatInput').value = q;
    sendChat();
  });
});

function askPriceBot() {
  if (!currentModalCard) return;
  fetchCardPrices({ force: true });
}

async function fetchCardPrices(options = {}) {
  const { force = false, silent = false } = options;
  if (!currentModalCard) return;
  const card = currentModalCard;
  const resultsEl = document.getElementById('priceResults');
  const loadingEl = document.getElementById('priceLoading');
  const dataEl = document.getElementById('priceData');
  const btn = document.getElementById('priceCheckBtn');

  const cached = priceCache[card.id];
  const cacheFresh = !!(cached && cached.data && (Date.now() - cached.timestamp <= PRICE_CACHE_TTL_MS));
  if (!force && cacheFresh) {
    renderPriceData(card, cached.data);
    return;
  }

  resultsEl.style.display = 'block';
  loadingEl.style.display = silent ? 'none' : 'flex';
  dataEl.innerHTML = '';
  btn.disabled = true;
  btn.textContent = silent ? 'Refreshing...' : 'Fetching...';

  const params = new URLSearchParams({
    name: card.name,
    set: card.set,
    number: card.cardNumber
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`/api/price-check?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      let detail = '';
      try {
        const errJson = await resp.json();
        detail = errJson.error || errJson.detail || '';
      } catch(_) {}
      throw new Error(`API ${resp.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await resp.json();

    priceCache[card.id] = { data, timestamp: Date.now() };
    renderPriceData(card, data);
  } catch(e) {
    // Fallback path: use public Pokemon TCG API directly from browser.
    try {
      const fallbackData = await fetchCardPricesFromPublicApi(card);
      priceCache[card.id] = { data: fallbackData, timestamp: Date.now() };
      renderPriceData(card, fallbackData);
      showToast('Price Fallback Active', 'Loaded prices from Pokemon TCG API');
    } catch(fallbackErr) {
      loadingEl.style.display = 'none';
      const tcgSearch = encodeURIComponent(`pokemon ${card.name} ${card.set} ${card.cardNumber}`);
      dataEl.innerHTML = `<div class="price-no-data">Could not fetch prices right now.</div>
        <div class="price-source-meta">API error: ${escapeHtml(String(e && e.message ? e.message : e))}</div>
        <div class="price-source-meta">Fallback error: ${escapeHtml(String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr))}</div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:8px;">
          <a href="https://www.pricecharting.com/search-products?q=${encodeURIComponent(card.name + ' ' + card.set)}&type=prices" target="_blank" rel="noopener noreferrer" class="price-source-link">PriceCharting</a>
          <a href="https://www.tcgplayer.com/search/pokemon/product?q=${tcgSearch}" target="_blank" rel="noopener noreferrer" class="price-source-link">TCGPlayer</a>
        </div>`;
      resultsEl.style.display = 'block';
    }
  }

  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;display:inline-block;vertical-align:middle;stroke:currentColor;fill:none;stroke-width:2;margin-right:6px;"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>Refresh Prices`;
}

function renderPriceData(card, data) {
  const resultsEl = document.getElementById('priceResults');
  const loadingEl = document.getElementById('priceLoading');
  const dataEl = document.getElementById('priceData');
  if (!resultsEl || !loadingEl || !dataEl) return;

  loadingEl.style.display = 'none';
  resultsEl.style.display = 'block';

  let html = '';

  if (data.pricecharting) {
    const pc = data.pricecharting;
    html += `<div class="price-source">
      <div class="price-source-header">
        <span class="price-source-name">PriceCharting</span>
        ${pc.url ? `<a href="${escapeAttr(pc.url)}" target="_blank" rel="noopener noreferrer" class="price-source-link">View &rarr;</a>` : ''}
      </div>`;
    if (pc.prices && Object.keys(pc.prices).length > 0) {
      html += '<div class="price-values">';
      if (pc.prices.ungraded) html += `<div class="price-item"><span class="price-label">Ungraded</span><span class="price-amount">${escapeHtml(pc.prices.ungraded)}</span></div>`;
      if (pc.prices.psa9) html += `<div class="price-item"><span class="price-label">Grade 7</span><span class="price-amount">${escapeHtml(pc.prices.psa9)}</span></div>`;
      if (pc.prices.psa10) html += `<div class="price-item"><span class="price-label">Grade 8</span><span class="price-amount">${escapeHtml(pc.prices.psa10)}</span></div>`;
      html += '</div>';
    } else {
      html += `<div class="price-no-data">No parsed prices. Open source to verify listing.</div>`;
    }
    if (pc.status) html += `<div class="price-source-meta">Status: ${escapeHtml(pc.status)}</div>`;
    html += '</div>';
  }

  if (data.tcgplayer) {
    const tc = data.tcgplayer;
    html += `<div class="price-source">
      <div class="price-source-header">
        <span class="price-source-name">TCGPlayer</span>
        ${tc.url ? `<a href="${escapeAttr(tc.url)}" target="_blank" rel="noopener noreferrer" class="price-source-link">View &rarr;</a>` : ''}
      </div>`;
    if (tc.market_price || tc.low_price) {
      html += '<div class="price-values">';
      if (tc.market_price) html += `<div class="price-item"><span class="price-label">Market</span><span class="price-amount">${escapeHtml(tc.market_price)}</span></div>`;
      if (tc.low_price) html += `<div class="price-item"><span class="price-label">Low</span><span class="price-amount">${escapeHtml(tc.low_price)}</span></div>`;
      html += '</div>';
    } else {
      html += `<div class="price-no-data">No parsed prices. Open source to verify listing.</div>`;
    }
    if (tc.status) html += `<div class="price-source-meta">Status: ${escapeHtml(tc.status)}</div>`;
    html += '</div>';
  }

  const bestPrice = getBestParsedPrice(data);
  if (bestPrice != null) {
    const st = getCardState(card.id);
    const deltaHtml = renderPriceDelta(st.purchasePrice, bestPrice);
    html += `<div class="price-reco-row">
      <div class="price-reco-main">
        <span class="price-label">Best Live Price</span>
        <span class="price-amount">$${bestPrice.toFixed(2)}</span>
      </div>
      <button class="price-mini-btn" onclick="applyFetchedPrice(${bestPrice.toFixed(2)})">Use As Purchase Price</button>
    </div>
    ${deltaHtml}`;
  }

  const fetchedAt = data.meta && data.meta.fetched_at ? new Date(data.meta.fetched_at * 1000) : new Date();
  const cacheLabel = data.meta && data.meta.cached ? 'cached' : 'live';
  html += `<div class="price-source-meta" style="margin-top:8px;">Updated: ${escapeHtml(fetchedAt.toLocaleString())} (${cacheLabel})</div>`;

  dataEl.innerHTML = html;
}

async function fetchCardPricesFromPublicApi(card) {
  const setIdRaw = SET_IDS[card.set];
  if (!setIdRaw) throw new Error('No set ID mapping for this set');

  let setId = setIdRaw;
  let num = card.cardNumber.split('/')[0].trim();
  const tgMatch = num.match(/^TG\d/i);
  const ggMatch = num.match(/^GG\d/i);
  if (tgMatch) setId += 'tg';
  else if (ggMatch) setId += 'gg';
  else if (card.set === 'Hidden Fates' && /^SV\d/i.test(num)) setId = 'sma';
  else if (card.set === 'SV Promos' && /^SV\d/i.test(num)) num = num.replace(/^SV/i, '');
  else if (card.set === 'XY Promos') num = num.replace(/[a-z]+$/i, '');

  const q = encodeURIComponent(`set.id:${setId} number:${num}`);
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=1&select=name,number,tcgplayer,cardmarket,set`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Pokemon TCG API ${resp.status}`);
  const payload = await resp.json();
  const c = payload && payload.data && payload.data[0];
  if (!c) throw new Error('Card not found in Pokemon TCG API');

  const tcg = c.tcgplayer || {};
  const tcgPrices = tcg.prices || {};
  const priceEntries = Object.values(tcgPrices).filter(Boolean);

  let market = null;
  let low = null;
  for (const p of priceEntries) {
    if (!market && typeof p.market === 'number') market = p.market;
    if (!low && typeof p.low === 'number') low = p.low;
    if (market && low) break;
  }

  // For pricecharting slot, use cardmarket trend/avg values as a fallback estimate.
  const cm = c.cardmarket && c.cardmarket.prices ? c.cardmarket.prices : {};
  const ungradedCandidate = typeof cm.trendPrice === 'number' ? cm.trendPrice : (typeof cm.averageSellPrice === 'number' ? cm.averageSellPrice : null);

  return {
    pricecharting: {
      title: c.name || card.name,
      prices: ungradedCandidate != null ? { ungraded: `$${Number(ungradedCandidate).toFixed(2)}` } : {},
      url: `https://www.pricecharting.com/search-products?q=${encodeURIComponent(card.name + ' ' + card.set)}&type=prices`,
      status: ungradedCandidate != null ? 'fallback-estimate' : 'no-data'
    },
    tcgplayer: {
      title: c.name || card.name,
      market_price: market != null ? `$${Number(market).toFixed(2)}` : null,
      low_price: low != null ? `$${Number(low).toFixed(2)}` : null,
      url: `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(`pokemon ${card.name} ${card.set} ${card.cardNumber}`)}`,
      status: (market != null || low != null) ? 'fallback-api' : 'no-data'
    },
    meta: {
      source: 'pokemon-tcg-fallback',
      cached: false,
      fetched_at: Math.floor(Date.now() / 1000)
    }
  };
}

function getBestParsedPrice(data) {
  const candidates = [];
  if (data.tcgplayer && data.tcgplayer.market_price) candidates.push(parseDollarAmount(data.tcgplayer.market_price));
  if (data.pricecharting && data.pricecharting.prices && data.pricecharting.prices.ungraded) candidates.push(parseDollarAmount(data.pricecharting.prices.ungraded));
  if (data.tcgplayer && data.tcgplayer.low_price) candidates.push(parseDollarAmount(data.tcgplayer.low_price));
  const valid = candidates.filter(v => Number.isFinite(v) && v > 0);
  if (!valid.length) return null;
  return valid[0];
}

function parseDollarAmount(text) {
  const m = String(text || '').match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return NaN;
  return parseFloat(m[1].replace(/,/g, ''));
}

function applyFetchedPrice(value) {
  if (!currentModalCard) return;
  const st = getCardState(currentModalCard.id);
  st.purchasePrice = Number(value);
  const priceInput = document.getElementById('modalPrice');
  if (priceInput) priceInput.value = Number(value).toFixed(2);
  saveCollection();
  updateStats();
  showToast('Price Applied', `$${Number(value).toFixed(2)} saved as purchase price`);
}

function renderPriceDelta(currentPurchase, livePrice) {
  if (!Number.isFinite(currentPurchase) || currentPurchase <= 0) return '';
  const delta = livePrice - currentPurchase;
  const pct = (delta / currentPurchase) * 100;
  const cls = delta > 0 ? 'price-delta-up' : delta < 0 ? 'price-delta-down' : 'price-delta-flat';
  const sign = delta > 0 ? '+' : '';
  return `<div class="price-delta ${cls}">Compared to your purchase: ${sign}$${delta.toFixed(2)} (${sign}${pct.toFixed(1)}%)</div>`;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  chatHistory.push({ role: 'user', content: msg });
  appendChatMsg('user', msg);

  // Client-side Price Oracle — no API key needed
  const reply = generatePriceReply(msg);
  chatHistory.push({ role: 'assistant', content: reply.text });
  appendChatMsg('assistant', reply.text, reply.links);
}

function generatePriceReply(msg) {
  const lower = msg.toLowerCase();
  // Try to extract card info from the message
  let cardName = '', setName = '', cardNum = '';
  // Check if asking about current modal card
  if (currentModalCard) {
    const cn = currentModalCard.name.toLowerCase();
    const sn = currentModalCard.set.toLowerCase();
    if (lower.includes(cn.split(' ')[0]) || lower.includes('price check') || lower.includes('this card') || lower.includes('current card')) {
      cardName = currentModalCard.name;
      setName = currentModalCard.set;
      cardNum = currentModalCard.cardNumber;
    }
  }
  // Try to match any known card from the message
  if (!cardName) {
    for (const c of ALL_CARDS) {
      if (lower.includes(c.name.toLowerCase())) {
        cardName = c.name;
        setName = c.set;
        cardNum = c.cardNumber;
        break;
      }
    }
  }
  // Extract from "Price check: X (Y) from Z" pattern
  if (!cardName) {
    const m = msg.match(/Price check:\s*(.+?)\s*\(([^)]+)\)\s*from\s*(.+)/i);
    if (m) { cardName = m[1].trim(); cardNum = m[2].trim(); setName = m[3].trim(); }
  }

  const tcgSearch = encodeURIComponent(`pokemon ${cardName} ${setName} ${cardNum}`.trim());
  const ebaySearch = encodeURIComponent(`pokemon tcg ${cardName} ${setName} full art`.trim());

  if (cardName) {
    const links = [
      { label: 'TCGPlayer', url: `https://www.tcgplayer.com/search/pokemon/product?q=${tcgSearch}` },
      { label: 'eBay Sold', url: `https://www.ebay.com/sch/i.html?_nkw=${ebaySearch}&LH_Complete=1&LH_Sold=1&_sacat=183454` },
      { label: 'PriceCharting', url: `https://www.pricecharting.com/search-products?q=${encodeURIComponent(cardName + ' ' + setName)}&type=prices` }
    ];
    return {
      text: `${cardName} (${cardNum}) from ${setName}\n\nCheck live market prices on these sites for the most accurate data:`,
      links
    };
  }

  // General questions
  if (lower.includes('investment') || lower.includes('invest')) {
    return { text: 'Full Art Trainer cards — especially from older eras (XY, Sun & Moon) — tend to appreciate over time. Special Illustration Rares from Scarlet & Violet have strong collector demand. Check TCGPlayer sold data for trends.', links: [{ label: 'TCGPlayer Trainers', url: 'https://www.tcgplayer.com/search/pokemon/product?q=full+art+trainer&view=grid' }] };
  }
  if (lower.includes('grade') || lower.includes('grading') || lower.includes('psa')) {
    return { text: 'PSA 10 grades typically command 2-5x raw NM prices for modern cards. Vintage Full Arts can see 10x+ premiums. BGS Black Labels are the most valuable. Cards in Mint condition (no whitening, centering, scratches) are worth grading.', links: [] };
  }
  if (lower.includes('condition') || lower.includes('mint') || lower.includes('played')) {
    return { text: 'Condition guide:\n• Mint/NM: 100% value — no whitening, perfect centering\n• LP: ~70-80% — light edge wear\n• MP: ~40-60% — noticeable wear, small creases\n• HP/HP+: ~20-35% — heavy wear, creases, damage\n\nAlways check TCGPlayer for condition-specific pricing.', links: [] };
  }

  return { text: 'Ask me about a specific card\'s price, investment potential, grading, or condition value! Try clicking "Price Check" on any card, or type a card name.', links: [] };
}

function appendChatMsg(cls, text, links) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + cls;
  div.textContent = text;
  if (links && links.length) {
    const linkRow = document.createElement('div');
    linkRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;';
    links.forEach(l => {
      const a = document.createElement('a');
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label;
      a.style.cssText = 'color:var(--gold);font-size:0.75rem;font-weight:600;text-decoration:underline;';
      linkRow.appendChild(a);
    });
    div.appendChild(linkRow);
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */
function exportJSON() {
  const exportData = ALL_CARDS.map(c => {
    const st = getCardState(c.id);
    return { ...c, ...st };
  });
  downloadFile('trainer_vault_backup.json', JSON.stringify(exportData, null, 2), 'application/json');
}

function importJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data)) {
        data.forEach(item => {
          const id = item.id;
          if (id != null) {
            collectionState[id] = {
              inCollection: !!(item.inCollection || item.in_collection),
              condition: item.condition || null,
              notes: item.notes || '',
              purchasePrice: item.purchasePrice || item.purchase_price || null,
              purchaseDate: item.purchaseDate || item.purchase_date || null,
              wantList: !!(item.wantList || item.want_list),
            };
          }
        });
      } else if (typeof data === 'object') {
        Object.assign(collectionState, data);
      }
      saveCollection();
      applyFiltersAndRender();
    } catch(err) {
      console.error('Import failed:', err);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function exportCSV() {
  const headers = ['ID','Name','Card Number','Set','Era','Variant','In Collection','Condition','Notes','Purchase Price','Purchase Date','Want List'];
  const rows = ALL_CARDS.map(c => {
    const st = getCardState(c.id);
    return [c.id, c.name, c.cardNumber, c.set, c.era, c.variant,
      st.inCollection ? 'Yes' : 'No', st.condition || '', st.notes || '',
      st.purchasePrice || '', st.purchaseDate || '', st.wantList ? 'Yes' : 'No'
    ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',');
  });
  downloadFile('trainer_vault_export.csv', [headers.join(','), ...rows].join('\n'), 'text/csv');
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================
   THEME TOGGLE (dark → light → dim → dark)
   ============================================================ */
const THEMES = ['dark', 'light', 'dim'];
function toggleDimMode() {
  const saved = localStorage.getItem('trainerVaultTheme') || 'dark';
  const next = THEMES[(THEMES.indexOf(saved) + 1) % THEMES.length];
  applyTheme(next);
  localStorage.setItem('trainerVaultTheme', next);
}

function applyTheme(theme) {
  document.body.classList.remove('dim-mode', 'light-mode');
  if (theme === 'light') document.body.classList.add('light-mode');
  else if (theme === 'dim') document.body.classList.add('dim-mode');
}

/* ============================================================
   RANDOM CARD
   ============================================================ */
function openRandomCard() {
  if (!ALL_CARDS.length) return;
  const idx = Math.floor(Math.random() * ALL_CARDS.length);
  openModal(ALL_CARDS[idx].id);
}

/* ============================================================
   RESET COLLECTION
   ============================================================ */
function resetCollection() {
  if (!confirm('Are you sure you want to reset your entire collection? This cannot be undone.')) return;
  collectionState = {};
  saveCollection();
  applyFiltersAndRender();
}

/* ============================================================
   RECENTLY ADDED
   ============================================================ */
function renderRecentlyAdded() {
  const section = document.getElementById('recentSection');
  const container = document.getElementById('recentCards');

  // Gather collected cards that have a purchase date, sorted newest first
  const collected = ALL_CARDS
    .filter(c => getCardState(c.id).inCollection)
    .sort((a, b) => {
      const da = getCardState(a.id).purchaseDate || '';
      const db = getCardState(b.id).purchaseDate || '';
      return db.localeCompare(da);
    })
    .slice(0, 12);

  if (!collected.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = '';
  collected.forEach(card => {
    const st = getCardState(card.id);
    const el = document.createElement('div');
    el.className = 'recent-card glass';
    el.innerHTML = `<div class="rc-name">${escapeHtml(card.name)}</div><div class="rc-sub">${escapeHtml(card.set)} ${st.purchaseDate ? '/ ' + st.purchaseDate : ''}</div>`;
    el.addEventListener('click', () => openModal(card.id));
    container.appendChild(el);
  });
}

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener('keydown', (e) => {
  // Ignore if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  switch(e.key.toLowerCase()) {
    case '/':
      e.preventDefault();
      document.getElementById('searchBox').focus();
      break;
    case 'r':
      if (!e.ctrlKey && !e.metaKey) openRandomCard();
      break;
    case 'q':
      toggleQuickScan();
      break;
    case 'p':
      toggleChatbot();
      break;
    case 'b':
      toggleBulkMode();
      break;
    case 's':
      shareCollection();
      break;
    case 'escape':
      if (document.getElementById('shortcutOverlay').classList.contains('open')) closeShortcutOverlay();
      else if (document.getElementById('advisorOverlay').classList.contains('open')) closeAdvisorPanel();
      else if (document.getElementById('adminLoginOverlay').classList.contains('open')) closeAdminLogin();
      else if (document.getElementById('adminPanelOverlay').classList.contains('open')) closeAdminPanel();
      else if (document.getElementById('modalOverlay').classList.contains('open')) closeModal();
      else if (document.getElementById('chatbotPanel').classList.contains('open')) toggleChatbot();
      break;
    case '?':
      e.preventDefault();
      toggleShortcutOverlay();
      break;
    case 't':
      if (!e.ctrlKey && !e.metaKey) toggleDimMode();
      break;
    case 'a':
      if (!e.ctrlKey && !e.metaKey) openAdvisorPanel();
      break;
  }
});

/* ============================================================
   UTILITY
   ============================================================ */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ============================================================
   ADMIN
   ============================================================ */
function isAdminLoggedIn() {
  if (!adminToken) adminToken = sessionStorage.getItem('adminToken');
  return !!adminToken;
}

function updateAdminButton() {
  const btn = document.getElementById('adminBtn');
  if (btn) btn.classList.toggle('active', isAdminLoggedIn());
}

function toggleAdmin() {
  if (isAdminLoggedIn()) {
    openAdminPanel();
  } else {
    openAdminLogin();
  }
}

function openAdminLogin() {
  document.getElementById('adminLoginOverlay').classList.add('open');
  document.getElementById('adminPassword').value = '';
  document.getElementById('adminLoginError').style.display = 'none';
  setTimeout(() => document.getElementById('adminPassword').focus(), 100);
}

function closeAdminLogin() {
  document.getElementById('adminLoginOverlay').classList.remove('open');
}

async function adminLogin() {
  const pw = document.getElementById('adminPassword').value;
  const errEl = document.getElementById('adminLoginError');
  if (!pw) {
    errEl.textContent = 'Please enter a password';
    errEl.style.display = 'block';
    return;
  }
  try {
    const resp = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await resp.json();
    if (resp.ok && data.token) {
      adminToken = data.token;
      sessionStorage.setItem('adminToken', adminToken);
      closeAdminLogin();
      updateAdminButton();
      openAdminPanel();
    } else {
      errEl.textContent = data.error || 'Login failed';
      errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = 'Connection error. Is the server running?';
    errEl.style.display = 'block';
  }
}

function adminLogout() {
  adminToken = null;
  sessionStorage.removeItem('adminToken');
  updateAdminButton();
  closeAdminPanel();
}

function openAdminPanel() {
  document.getElementById('adminPanelOverlay').classList.add('open');
  document.getElementById('adminCardCount').textContent = 'Managing ' + ALL_CARDS.length + ' cards';
  document.getElementById('adminCardName').value = '';
  document.getElementById('adminCardNumber').value = '';
  document.getElementById('adminSetName').value = '';
  document.getElementById('adminEra').value = '';
  document.getElementById('adminVariant').value = '';
  document.getElementById('adminFormError').style.display = 'none';
  document.getElementById('adminFormSuccess').style.display = 'none';
}

function closeAdminPanel() {
  document.getElementById('adminPanelOverlay').classList.remove('open');
}

async function adminAddCard() {
  const errEl = document.getElementById('adminFormError');
  const successEl = document.getElementById('adminFormSuccess');
  errEl.style.display = 'none';
  successEl.style.display = 'none';

  const cardData = {
    name: document.getElementById('adminCardName').value.trim(),
    card_number: document.getElementById('adminCardNumber').value.trim(),
    set_name: document.getElementById('adminSetName').value.trim(),
    era: document.getElementById('adminEra').value,
    variant: document.getElementById('adminVariant').value,
  };

  if (!cardData.name || !cardData.card_number || !cardData.set_name || !cardData.era || !cardData.variant) {
    errEl.textContent = 'All fields are required';
    errEl.style.display = 'block';
    return;
  }

  try {
    const resp = await fetch('/api/admin/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
      body: JSON.stringify(cardData)
    });
    const data = await resp.json();
    if (resp.ok) {
      successEl.textContent = 'Added: ' + data.card.name + ' (ID: ' + data.card.id + ')';
      successEl.style.display = 'block';
      ALL_CARDS.push({
        id: data.card.id,
        name: data.card.name,
        cardNumber: data.card.card_number,
        set: data.card.set_name,
        era: data.card.era,
        variant: data.card.variant,
      });
      applyFiltersAndRender();
      document.getElementById('adminCardCount').textContent = 'Managing ' + ALL_CARDS.length + ' cards';
      document.getElementById('adminCardName').value = '';
      document.getElementById('adminCardNumber').value = '';
      document.getElementById('adminSetName').value = '';
      document.getElementById('adminEra').value = '';
      document.getElementById('adminVariant').value = '';
    } else if (resp.status === 401) {
      errEl.textContent = 'Session expired. Please login again.';
      errEl.style.display = 'block';
      adminLogout();
    } else {
      errEl.textContent = data.error || 'Failed to add card';
      errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = 'Connection error';
    errEl.style.display = 'block';
  }
}

async function adminDeleteCard(cardId) {
  if (!confirm('Delete this card permanently? This cannot be undone.')) return;
  try {
    const resp = await fetch('/api/admin/cards/' + cardId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + adminToken }
    });
    if (resp.ok) {
      ALL_CARDS = ALL_CARDS.filter(c => c.id !== cardId);
      delete collectionState[cardId];
      saveCollection();
      closeModal();
      applyFiltersAndRender();
    } else if (resp.status === 401) {
      alert('Session expired. Please login again.');
      adminLogout();
    } else {
      const data = await resp.json();
      alert(data.error || 'Failed to delete card');
    }
  } catch(e) {
    alert('Connection error');
  }
}

async function adminEditCard(cardId) {
  const card = ALL_CARDS.find(c => c.id === cardId);
  if (!card) return;

  const name = prompt('Card Name:', card.name);
  if (name === null) return;
  const cardNumber = prompt('Card Number:', card.cardNumber);
  if (cardNumber === null) return;
  const setName = prompt('Set Name:', card.set);
  if (setName === null) return;
  const era = prompt('Era (Black & White, XY, Sun & Moon, Sword & Shield, Scarlet & Violet, Mega Evolution):', card.era);
  if (era === null) return;
  const variant = prompt('Variant (Full Art, Illustration Rare, Special Illustration Rare, Rainbow, Secret):', card.variant);
  if (variant === null) return;

  if (!name.trim() || !cardNumber.trim() || !setName.trim() || !era.trim() || !variant.trim()) {
    alert('All fields are required');
    return;
  }

  try {
    const resp = await fetch('/api/admin/cards/' + cardId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
      body: JSON.stringify({ name: name.trim(), card_number: cardNumber.trim(), set_name: setName.trim(), era: era.trim(), variant: variant.trim() })
    });
    if (resp.ok) {
      const data = await resp.json();
      card.name = data.card.name;
      card.cardNumber = data.card.card_number;
      card.set = data.card.set_name;
      card.era = data.card.era;
      card.variant = data.card.variant;
      openModal(cardId);
      applyFiltersAndRender();
    } else if (resp.status === 401) {
      alert('Session expired. Please login again.');
      adminLogout();
    } else {
      const data = await resp.json();
      alert(data.error || 'Failed to edit card');
    }
  } catch(e) {
    alert('Connection error');
  }
}

async function verifyAdminToken() {
  if (!isAdminLoggedIn()) return;
  try {
    const resp = await fetch('/api/admin/verify', {
      headers: { 'Authorization': 'Bearer ' + adminToken }
    });
    if (!resp.ok) {
      adminToken = null;
      sessionStorage.removeItem('adminToken');
    }
  } catch(e) {}
  updateAdminButton();
}

/* ============================================================
   ACHIEVEMENTS & MILESTONES
   ============================================================ */
const MILESTONES = [
  { id: 'first', label: 'First Catch!', desc: 'Added your first card', icon: '⭐', check: n => n >= 1 },
  { id: 'ten', label: 'Getting Started', desc: 'Collected 10 cards', icon: '🔥', check: n => n >= 10 },
  { id: 'twentyfive', label: 'Quarter Century', desc: 'Collected 25 cards', icon: '💎', check: n => n >= 25 },
  { id: 'fifty', label: 'Halfway Hero', desc: 'Collected 50 cards', icon: '🏆', check: n => n >= 50 },
  { id: 'hundred', label: 'Century Club', desc: 'Collected 100 cards', icon: '💯', check: n => n >= 100 },
  { id: 'twofifty', label: 'Vault Master', desc: 'Collected 250 cards', icon: '👑', check: n => n >= 250 },
  { id: 'fivehundred', label: 'Legendary Collector', desc: 'All 500+ cards!', icon: '🌟', check: n => n >= 500 },
];

function loadAchievements() {
  try {
    const saved = localStorage.getItem('trainerVaultAchievements');
    if (saved) unlockedAchievements = JSON.parse(saved);
  } catch(e) {}
}

function checkMilestones() {
  if (!ALL_CARDS.length) return;
  const collected = ALL_CARDS.filter(c => getCardState(c.id).inCollection).length;

  // Count milestones
  MILESTONES.forEach(m => {
    if (!unlockedAchievements[m.id] && m.check(collected)) {
      unlockedAchievements[m.id] = Date.now();
      localStorage.setItem('trainerVaultAchievements', JSON.stringify(unlockedAchievements));
      showToast(m.icon + ' ' + m.label, m.desc);
    }
  });

  // Set completions
  const sets = {};
  ALL_CARDS.forEach(c => {
    if (!sets[c.set]) sets[c.set] = { total: 0, collected: 0 };
    sets[c.set].total++;
    if (getCardState(c.id).inCollection) sets[c.set].collected++;
  });
  Object.entries(sets).forEach(([setName, data]) => {
    const key = 'set_' + setName.replace(/\W+/g, '_');
    if (!unlockedAchievements[key] && data.collected === data.total && data.total > 0) {
      unlockedAchievements[key] = Date.now();
      localStorage.setItem('trainerVaultAchievements', JSON.stringify(unlockedAchievements));
      showToast('🎉 Set Complete!', setName + ' — All ' + data.total + ' cards!');
      launchConfetti();
    }
  });

  // Era completions
  ERA_ORDER.forEach(era => {
    const key = 'era_' + era.replace(/\W+/g, '_');
    if (unlockedAchievements[key]) return;
    const eraCards = ALL_CARDS.filter(c => c.era === era);
    const eraCollected = eraCards.filter(c => getCardState(c.id).inCollection).length;
    if (eraCollected === eraCards.length && eraCards.length > 0) {
      unlockedAchievements[key] = Date.now();
      localStorage.setItem('trainerVaultAchievements', JSON.stringify(unlockedAchievements));
      showToast('🏅 Era Complete!', era + ' — All ' + eraCards.length + ' cards!');
      launchConfetti();
    }
  });
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
function showToast(title, desc) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast glass';
  toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-desc">${escapeHtml(desc)}</div>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

/* ============================================================
   BULK SELECT MODE
   ============================================================ */
function toggleBulkMode() {
  bulkMode = !bulkMode;
  bulkSelected.clear();
  const bar = document.getElementById('bulkBar');
  if (bar) bar.classList.toggle('active', bulkMode);
  updateBulkCount();
  applyFiltersAndRender();
}

function updateBulkCount() {
  const el = document.getElementById('bulkCount');
  if (el) el.textContent = bulkSelected.size + ' selected';
}

function bulkMarkCollected() {
  const count = bulkSelected.size;
  bulkSelected.forEach(id => { getCardState(id).inCollection = true; });
  saveCollection();
  bulkSelected.clear();
  updateBulkCount();
  applyFiltersAndRender();
  showToast('✓ Bulk Collected', count + ' cards marked collected');
}

function bulkMarkWant() {
  const count = bulkSelected.size;
  bulkSelected.forEach(id => { getCardState(id).wantList = true; });
  saveCollection();
  bulkSelected.clear();
  updateBulkCount();
  applyFiltersAndRender();
  showToast('♥ Bulk Want List', count + ' cards added to want list');
}

function bulkRemove() {
  const count = bulkSelected.size;
  bulkSelected.forEach(id => { getCardState(id).inCollection = false; });
  saveCollection();
  bulkSelected.clear();
  updateBulkCount();
  applyFiltersAndRender();
  showToast('✕ Bulk Removed', count + ' cards removed from collection');
}

function bulkClear() {
  bulkSelected.clear();
  updateBulkCount();
  applyFiltersAndRender();
}

/* ============================================================
   SHARE COLLECTION
   ============================================================ */
function shareCollection() {
  const total = ALL_CARDS.length;
  const collected = ALL_CARDS.filter(c => getCardState(c.id).inCollection).length;
  const pct = total ? Math.round((collected / total) * 100) : 0;
  let val = 0;
  ALL_CARDS.forEach(c => { const st = getCardState(c.id); if (st.purchasePrice) val += parseFloat(st.purchasePrice) || 0; });

  const eraLines = ERA_ORDER.map(era => {
    const eraTotal = ALL_CARDS.filter(c => c.era === era).length;
    const eraCollected = ALL_CARDS.filter(c => c.era === era && getCardState(c.id).inCollection).length;
    const labels = { 'Black & White':'B&W','XY':'XY','Sun & Moon':'S&M','Sword & Shield':'S&S','Scarlet & Violet':'S&V','Mega Evolution':'Mega' };
    return `${labels[era]}: ${eraCollected}/${eraTotal}`;
  }).join(' · ');

  const text = `🎴 TRICARD SYNDICATE\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 ${collected}/${total} cards (${pct}%)\n` +
    `💰 Value: $${val.toFixed(2)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    eraLines + `\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Pokémon Full Art Trainer Collection`;

  if (navigator.share) {
    navigator.share({ title: 'Tricard Syndicate', text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 Copied!', 'Collection stats copied to clipboard');
    }).catch(() => {});
  }
}

/* ============================================================
   VARIANT DONUT CHART
   ============================================================ */
function renderVariantDonut() {
  const el = document.getElementById('variantDonut');
  const legend = document.getElementById('variantLegend');
  if (!el || !ALL_CARDS.length) return;

  const variants = {};
  ALL_CARDS.forEach(c => {
    if (getCardState(c.id).inCollection) {
      variants[c.variant] = (variants[c.variant] || 0) + 1;
    }
  });

  const colors = {
    'Full Art': '#FFD700', 'Illustration Rare': '#D4956A', 'Special Illustration Rare': '#FF2255',
    'Rainbow': '#00FFFF', 'Secret': '#5C8374'
  };
  const entries = Object.entries(variants).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);

  if (!total) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:0.7rem;font-family:DM Mono,monospace;padding:20px;">Collect cards to see breakdown</div>';
    legend.innerHTML = '';
    return;
  }

  const size = 110, cx = size / 2, cy = size / 2, r = 40, inner = 26;
  let svgPaths = '';
  let angle = -Math.PI / 2;
  entries.forEach(([name, count]) => {
    const slice = (count / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle + slice), y2 = cy + r * Math.sin(angle + slice);
    const ix1 = cx + inner * Math.cos(angle + slice), iy1 = cy + inner * Math.sin(angle + slice);
    const ix2 = cx + inner * Math.cos(angle), iy2 = cy + inner * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    const color = colors[name] || '#888';
    svgPaths += `<path d="M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${ix1},${iy1} A${inner},${inner} 0 ${large} 0 ${ix2},${iy2}Z" fill="${color}" opacity="0.85"><title>${name}: ${count}</title></path>`;
    angle += slice;
  });
  svgPaths += `<text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle" fill="var(--gold)" font-family="Bebas Neue,sans-serif" font-size="16">${total}</text>`;

  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${svgPaths}</svg>`;
  legend.innerHTML = entries.map(([name, count]) => {
    const color = colors[name] || '#888';
    return `<span class="donut-legend-item"><span class="donut-legend-dot" style="background:${color}"></span>${name.replace('Special Illustration Rare','SIR').replace('Illustration Rare','IR')} ${count}</span>`;
  }).join('');
}

/* ============================================================
   TOP SETS BAR CHART
   ============================================================ */
function renderTopSets() {
  const el = document.getElementById('topSetsChart');
  if (!el || !ALL_CARDS.length) return;

  const sets = {};
  ALL_CARDS.forEach(c => {
    if (!sets[c.set]) sets[c.set] = { total: 0, collected: 0, era: c.era };
    sets[c.set].total++;
    if (getCardState(c.id).inCollection) sets[c.set].collected++;
  });

  const sorted = Object.entries(sets)
    .filter(([_, d]) => d.collected > 0)
    .sort((a, b) => b[1].collected - a[1].collected)
    .slice(0, 7);

  if (!sorted.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:0.7rem;font-family:DM Mono,monospace;padding:10px;">No sets collected yet</div>';
    return;
  }

  const maxCount = sorted[0][1].total;
  const eraColors = { 'Black & White':'var(--era-bw)','XY':'var(--era-xy)','Sun & Moon':'var(--era-sm)','Sword & Shield':'var(--era-ss)','Scarlet & Violet':'var(--era-sv)','Mega Evolution':'var(--era-mega)' };

  el.innerHTML = sorted.map(([name, d]) => {
    const pct = Math.round((d.collected / d.total) * 100);
    const barW = Math.round((d.total / maxCount) * 100);
    const fillW = Math.round((d.collected / d.total) * 100);
    const color = eraColors[d.era] || 'var(--copper)';
    const shortName = name.length > 14 ? name.slice(0, 13) + '…' : name;
    return `<div class="top-set-row">
      <span class="top-set-label" title="${name}">${shortName}</span>
      <div class="top-set-track" style="max-width:${barW}%"><div class="top-set-fill" style="width:${fillW}%;background:${color}"></div></div>
      <span class="top-set-count">${d.collected}/${d.total}</span>
    </div>`;
  }).join('');
}

/* ============================================================
   CONDITION SPREAD CHART
   ============================================================ */
function renderCondChart() {
  const el = document.getElementById('condChart');
  if (!el || !ALL_CARDS.length) return;

  const condColors = { 'Mint':'var(--mint)', 'NM':'var(--cyan)', 'LP':'#FFD700', 'MP':'#FFA500', 'HP':'#FF4444', 'HP+':'var(--crimson)' };
  const counts = {};
  let graded = 0;
  ALL_CARDS.forEach(c => {
    const st = getCardState(c.id);
    if (st.inCollection && st.condition) {
      counts[st.condition] = (counts[st.condition] || 0) + 1;
      graded++;
    }
  });

  const collected = ALL_CARDS.filter(c => getCardState(c.id).inCollection).length;
  const ungraded = collected - graded;

  if (!graded && !ungraded) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:0.7rem;font-family:DM Mono,monospace;">Set conditions in card details</div>';
    return;
  }

  const max = Math.max(...Object.values(counts), ungraded, 1);
  let html = '';
  CONDITIONS.forEach(cond => {
    const n = counts[cond] || 0;
    const pct = Math.round((n / max) * 100);
    html += `<div class="cond-bar-row">
      <span class="cond-bar-label" style="color:${condColors[cond]}">${cond}</span>
      <div class="cond-bar-track"><div class="cond-bar-fill" style="width:${pct}%;background:${condColors[cond]}"></div></div>
      <span class="cond-bar-val">${n}</span>
    </div>`;
  });
  if (ungraded > 0) {
    const pct = Math.round((ungraded / max) * 100);
    html += `<div class="cond-bar-row">
      <span class="cond-bar-label" style="color:var(--text-dim)">?</span>
      <div class="cond-bar-track"><div class="cond-bar-fill" style="width:${pct}%;background:rgba(255,255,255,0.15)"></div></div>
      <span class="cond-bar-val">${ungraded}</span>
    </div>`;
  }
  el.innerHTML = html;
}

/* ============================================================
   VARIANT RADAR / SPIDER CHART
   ============================================================ */
function renderVariantRadar() {
  const el = document.getElementById('variantRadar');
  if (!el || !ALL_CARDS.length) return;

  const variantNames = ['Full Art', 'Illustration Rare', 'Special Illustration Rare', 'Rainbow', 'Secret'];
  const shortNames = ['FA', 'IR', 'SIR', 'Rain', 'Sec'];
  const data = variantNames.map(v => {
    const total = ALL_CARDS.filter(c => c.variant === v).length;
    const collected = ALL_CARDS.filter(c => c.variant === v && getCardState(c.id).inCollection).length;
    return total > 0 ? collected / total : 0;
  });

  const size = 140, cx = size / 2, cy = size / 2;
  const levels = 4, maxR = 52;
  const n = data.length;
  const step = (Math.PI * 2) / n;

  // Grid rings
  let gridSvg = '';
  for (let l = 1; l <= levels; l++) {
    const r = (l / levels) * maxR;
    let pts = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i * step;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
    }
    gridSvg += `<polygon points="${pts.join(' ')}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>`;
  }

  // Axis lines
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * step;
    const x2 = cx + maxR * Math.cos(a), y2 = cy + maxR * Math.sin(a);
    gridSvg += `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>`;
  }

  // Data polygon
  const dataPts = data.map((v, i) => {
    const a = -Math.PI / 2 + i * step;
    const r = Math.max(v, 0.05) * maxR;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  });
  gridSvg += `<polygon points="${dataPts.join(' ')}" fill="rgba(255,215,0,0.15)" stroke="var(--gold)" stroke-width="1.5" stroke-linejoin="round"/>`;

  // Data dots + labels
  data.forEach((v, i) => {
    const a = -Math.PI / 2 + i * step;
    const r = Math.max(v, 0.05) * maxR;
    const dx = cx + r * Math.cos(a), dy = cy + r * Math.sin(a);
    gridSvg += `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="2.5" fill="var(--gold)"/>`;
    // Label
    const lx = cx + (maxR + 14) * Math.cos(a), ly = cy + (maxR + 14) * Math.sin(a);
    const pct = Math.round(v * 100);
    gridSvg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="var(--text-dim)" font-family="DM Mono,monospace" font-size="7">${shortNames[i]} ${pct}%</text>`;
  });

  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${gridSvg}</svg>`;
}

/* ============================================================
   SPARKLINE — Collection History Tracker
   ============================================================ */
function trackCollectionHistory() {
  if (!ALL_CARDS.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const collected = ALL_CARDS.filter(c => getCardState(c.id).inCollection).length;
  let history = [];
  try { history = JSON.parse(localStorage.getItem('trainerVaultHistory') || '[]'); } catch(e) {}
  if (history.length && history[history.length - 1].date === today) {
    history[history.length - 1].count = collected;
  } else {
    history.push({ date: today, count: collected });
  }
  if (history.length > 30) history = history.slice(-30);
  try { localStorage.setItem('trainerVaultHistory', JSON.stringify(history)); } catch(e) {}
}

function renderSparkline() {
  const container = document.getElementById('sparklineWrap');
  if (!container) return;
  let history = [];
  try { history = JSON.parse(localStorage.getItem('trainerVaultHistory') || '[]'); } catch(e) {}
  if (history.length < 2) {
    container.innerHTML = '<div style="font-size:0.6rem;color:var(--text-dim);font-family:\'DM Mono\',monospace;margin-top:4px;">Tracking started today</div>';
    return;
  }
  const max = ALL_CARDS.length || 1;
  const w = 140, h = 36;
  const step = w / (history.length - 1);
  const pts = history.map((e, i) => {
    const x = i * step;
    const y = h - (e.count / max) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastY = h - (history[history.length - 1].count / max) * (h - 4) - 2;
  // Gradient fill
  const fillPts = [`0,${h}`, ...pts, `${w},${h}`].join(' ');
  container.innerHTML = `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible;">
      <defs><linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.3"/><stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${fillPts}" fill="url(#sparkGrad)"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="var(--gold)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${w}" cy="${lastY.toFixed(1)}" r="2.5" fill="var(--gold)"/>
    </svg>
    <div style="font-size:0.55rem;color:var(--text-dim);font-family:'DM Mono',monospace;margin-top:2px;">${history.length}d trend</div>`;
}

/* ============================================================
   RARITY SCORE SYSTEM
   ============================================================ */
function computeRarityScore(card) {
  let score = 0;
  // Variant weight (0-40)
  const variantScores = { 'Special Illustration Rare': 40, 'Rainbow': 30, 'Secret': 25, 'Illustration Rare': 18, 'Full Art': 10 };
  score += variantScores[card.variant] || 5;
  // Era age bonus (0-25) — older = rarer
  const eraAge = { 'Black & White': 25, 'XY': 20, 'Sun & Moon': 15, 'Sword & Shield': 10, 'Scarlet & Violet': 5, 'Mega Evolution': 12 };
  score += eraAge[card.era] || 5;
  // Set scarcity — fewer cards in set = rarer (0-20)
  const setCards = ALL_CARDS.filter(c => c.set === card.set).length;
  score += setCards <= 3 ? 20 : setCards <= 8 ? 15 : setCards <= 15 ? 10 : 5;
  // Collectability — how many people have it (0-15)
  const collectedPct = ALL_CARDS.length ? ALL_CARDS.filter(c => getCardState(c.id).inCollection).length / ALL_CARDS.length : 0;
  const st = getCardState(card.id);
  score += st.inCollection ? 5 : 15; // Missing cards rated higher rarity
  return Math.min(100, Math.max(1, score));
}

/* ============================================================
   AI CARD LORE GENERATOR
   ============================================================ */
function generateCardLore() {
  if (!currentModalCard) return;
  const card = currentModalCard;
  const loreEl = document.getElementById('modalLoreText');

  const trainerAdjectives = ['legendary', 'mysterious', 'renowned', 'enigmatic', 'fearless', 'brilliant', 'cunning', 'noble', 'fierce', 'serene', 'ancient', 'fabled'];
  const eraLore = {
    'Black & White': 'the Unova twilight, when ideals and truth clashed across an awakening world',
    'XY': 'the Kalos renaissance, as Mega Evolution reshaped the bond between Trainers and Pokémon',
    'Sun & Moon': 'the Alolan dawn, where Ultra Beasts breached dimensional boundaries',
    'Sword & Shield': 'the Galar expedition, amidst Dynamax storms and ancient legends',
    'Scarlet & Violet': 'the Paldean chronicle, as time paradoxes echoed through Area Zero',
    'Mega Evolution': 'the Mega Evolution surge, when primal energies awakened dormant power'
  };
  const variantLore = {
    'Full Art': 'rendered in sweeping, full-canvas artistry that captures their essence',
    'Illustration Rare': 'depicted in a rare illustration that reveals a hidden side of their story',
    'Special Illustration Rare': 'immortalized in an extraordinarily rare piece — one of the most coveted in existence',
    'Rainbow': 'transformed into a prismatic vision, shimmering with rainbow energy from beyond',
    'Secret': 'hidden as a secret treasure within the set, known only to the most dedicated seekers'
  };
  const setFlavor = [
    `First documented in the ${card.set} archives`,
    `Their legend was first recorded in ${card.set}`,
    `This depiction originates from the ${card.set} collection`,
    `Discovered within the vaults of ${card.set}`,
    `Catalogued during the ${card.set} expedition`
  ];
  const endings = [
    'Collectors who possess this card carry a piece of history.',
    'Few have witnessed this card in person — even fewer own it.',
    'This card\'s presence in any collection elevates it to legendary status.',
    'Trading circles whisper of its beauty and power.',
    'A cornerstone piece for any serious Full Art Trainer collection.',
    'Its value transcends mere currency — it represents devotion to the craft.'
  ];

  const adj = trainerAdjectives[Math.floor(Math.random() * trainerAdjectives.length)];
  const eraText = eraLore[card.era] || 'an uncharted era of Pokémon history';
  const varText = variantLore[card.variant] || 'captured in stunning detail';
  const setLine = setFlavor[Math.floor(Math.random() * setFlavor.length)];
  const ending = endings[Math.floor(Math.random() * endings.length)];
  const rscore = computeRarityScore(card);
  const rTier = rscore >= 90 ? 'a legendary artifact' : rscore >= 70 ? 'an ultra-rare treasure' : rscore >= 50 ? 'a prized collectible' : 'a notable piece';

  const lore = `${card.name} — the ${adj} trainer of ${eraText}. ${setLine}, ${varText}. With a rarity score of ${rscore}/100, this card is considered ${rTier} among Full Art collectors. ${card.cardNumber} bears witness to a singular moment in the Pokémon TCG timeline. ${ending}`;

  loreEl.textContent = lore;
  loreEl.classList.add('visible');
}

/* ============================================================
   KEYBOARD SHORTCUT OVERLAY
   ============================================================ */
function toggleShortcutOverlay() {
  document.getElementById('shortcutOverlay').classList.toggle('open');
}
function closeShortcutOverlay() {
  document.getElementById('shortcutOverlay').classList.remove('open');
}

/* ============================================================
   AI SMART COLLECTION ADVISOR
   ============================================================ */
function openAdvisorPanel() {
  document.getElementById('advisorOverlay').classList.add('open');
  generateAdvisorInsights();
}
function closeAdvisorPanel() {
  document.getElementById('advisorOverlay').classList.remove('open');
}

function generateAdvisorInsights() {
  const content = document.getElementById('advisorContent');
  if (!ALL_CARDS.length) {
    content.innerHTML = '<div class="advisor-loading">No cards loaded yet.</div>';
    return;
  }

  const collected = ALL_CARDS.filter(c => getCardState(c.id).inCollection);
  const missing = ALL_CARDS.filter(c => !getCardState(c.id).inCollection);
  const collectedCount = collected.length;
  const totalCount = ALL_CARDS.length;

  // 1. Nearest set completions
  const sets = {};
  ALL_CARDS.forEach(c => {
    if (!sets[c.set]) sets[c.set] = { total: 0, collected: 0, missing: [] };
    sets[c.set].total++;
    if (getCardState(c.id).inCollection) sets[c.set].collected++;
    else sets[c.set].missing.push(c);
  });
  const nearComplete = Object.entries(sets)
    .filter(([_, d]) => d.collected > 0 && d.missing.length > 0 && d.missing.length <= 5)
    .sort((a, b) => a[1].missing.length - b[1].missing.length)
    .slice(0, 5);

  // 2. Weakest eras (lowest collection %)
  const eraStats = ERA_ORDER.map(era => {
    const eraCards = ALL_CARDS.filter(c => c.era === era);
    const eraCollected = eraCards.filter(c => getCardState(c.id).inCollection).length;
    return { era, total: eraCards.length, collected: eraCollected, pct: eraCards.length ? Math.round((eraCollected / eraCards.length) * 100) : 0 };
  }).sort((a, b) => a.pct - b.pct);

  // 3. High-value targets (missing SIR and Rainbow cards)
  const highValue = missing
    .filter(c => c.variant === 'Special Illustration Rare' || c.variant === 'Rainbow')
    .sort((a, b) => computeRarityScore(b) - computeRarityScore(a))
    .slice(0, 6);

  // 4. Collection personality
  const variantCounts = {};
  collected.forEach(c => { variantCounts[c.variant] = (variantCounts[c.variant] || 0) + 1; });
  const topVariant = Object.entries(variantCounts).sort((a, b) => b[1] - a[1])[0];
  const eraCounts = {};
  collected.forEach(c => { eraCounts[c.era] = (eraCounts[c.era] || 0) + 1; });
  const topEra = Object.entries(eraCounts).sort((a, b) => b[1] - a[1])[0];

  let personalityText = '';
  if (collectedCount === 0) {
    personalityText = 'Your vault is empty! Start by adding cards from your favorite era. Set completions unlock achievements!';
  } else {
    const archetype = topVariant ? (
      topVariant[0] === 'Special Illustration Rare' ? '🎨 The Art Connoisseur' :
      topVariant[0] === 'Rainbow' ? '🌈 The Prismatic Hunter' :
      topVariant[0] === 'Full Art' ? '🖼️ The Classic Collector' :
      topVariant[0] === 'Secret' ? '🔒 The Secret Seeker' : '💎 The Illustrator'
    ) : '🃏 The Beginner';
    personalityText = `<strong>${archetype}</strong> — You favor <span class="highlight">${topVariant ? topVariant[0] : 'exploring'}</span> cards${topEra ? ` from the <span class="highlight">${topEra[0]}</span> era` : ''}. ` +
      `With ${collectedCount}/${totalCount} cards (${Math.round(collectedCount/totalCount*100)}%), ` +
      (collectedCount > totalCount * 0.75 ? 'you\'re approaching legendary status!' :
       collectedCount > totalCount * 0.5 ? 'you\'re well past the halfway mark — keep pushing!' :
       collectedCount > totalCount * 0.25 ? 'solid progress! Focus on set completions for achievements.' :
       'every vault starts small. Target near-complete sets for quick wins!');
  }

  // 5. Smart suggestion
  let smartTip = '';
  if (nearComplete.length > 0) {
    const best = nearComplete[0];
    smartTip = `🎯 <strong>Top Priority:</strong> You're just <span class="highlight">${best[1].missing.length} card${best[1].missing.length > 1 ? 's' : ''}</span> away from completing <span class="highlight">${best[0]}</span>! ` +
      `Missing: ${best[1].missing.map(c => c.name).join(', ')}.`;
  } else if (missing.length > 0) {
    const randomTarget = missing[Math.floor(Math.random() * Math.min(missing.length, 20))];
    smartTip = `🎯 <strong>Next Target:</strong> Consider adding <span class="highlight">${randomTarget.name}</span> from ${randomTarget.set} (${randomTarget.variant}).`;
  } else {
    smartTip = '🏆 <strong>Incredible!</strong> You\'ve collected every single card! You are a true Vault Master!';
  }

  let html = '';

  // Personality card
  html += `<div class="advisor-card">
    <div class="advisor-card-title"><span class="adv-icon">🧠</span> <span style="color:var(--gold)">Collector Profile</span></div>
    <div class="advisor-card-body">${personalityText}</div>
  </div>`;

  // Smart tip
  html += `<div class="advisor-card">
    <div class="advisor-card-title"><span class="adv-icon">💡</span> <span style="color:var(--cyan)">Smart Recommendation</span></div>
    <div class="advisor-card-body">${smartTip}</div>
  </div>`;

  // Near completions
  if (nearComplete.length > 0) {
    html += `<div class="advisor-card">
      <div class="advisor-card-title"><span class="adv-icon">🏁</span> <span style="color:var(--mint)">Nearest Set Completions</span></div>
      <div class="advisor-card-body"><ul>${nearComplete.map(([name, d]) =>
        `<li><span class="highlight">${escapeHtml(name)}</span> — ${d.collected}/${d.total} (need ${d.missing.length}: <span class="dim">${d.missing.map(c => c.name).join(', ')}</span>)</li>`
      ).join('')}</ul></div>
    </div>`;
  }

  // Weakest eras
  html += `<div class="advisor-card">
    <div class="advisor-card-title"><span class="adv-icon">📊</span> <span style="color:var(--copper)">Era Weakness Analysis</span></div>
    <div class="advisor-card-body"><ul>${eraStats.map(e =>
      `<li><span class="highlight">${escapeHtml(e.era)}</span> — ${e.collected}/${e.total} (${e.pct}%) ${e.pct < 25 ? '⚠️ Needs attention' : e.pct >= 75 ? '✅ Strong' : ''}</li>`
    ).join('')}</ul></div>
  </div>`;

  // High-value targets
  if (highValue.length > 0) {
    html += `<div class="advisor-card">
      <div class="advisor-card-title"><span class="adv-icon">💎</span> <span style="color:var(--crimson)">High-Value Targets</span></div>
      <div class="advisor-card-body"><ul>${highValue.map(c =>
        `<li><span class="highlight">${escapeHtml(c.name)}</span> — ${escapeHtml(c.set)} · ${c.variant} · Score: ${computeRarityScore(c)}/100</li>`
      ).join('')}</ul></div>
    </div>`;
  }

  content.innerHTML = html;
}

/* ============================================================
   COLLECTION HEATMAP CALENDAR
   ============================================================ */
function renderHeatmapCalendar() {
  const el = document.getElementById('heatmapCalendar');
  if (!el) return;

  // Gather date data from collection
  const dateCounts = {};
  ALL_CARDS.forEach(c => {
    const st = getCardState(c.id);
    if (st.inCollection && st.purchaseDate) {
      dateCounts[st.purchaseDate] = (dateCounts[st.purchaseDate] || 0) + 1;
    }
  });

  // Also use history data from localStorage
  let history = [];
  try { history = JSON.parse(localStorage.getItem('trainerVaultHistory') || '[]'); } catch(e) {}

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 182); // ~26 weeks

  const cellSize = 11, cellGap = 2, leftPad = 28, topPad = 16;
  const totalCells = 183;
  const weeks = Math.ceil(totalCells / 7);
  const svgW = leftPad + weeks * (cellSize + cellGap) + 4;
  const svgH = topPad + 7 * (cellSize + cellGap) + 4;

  const maxCount = Math.max(1, ...Object.values(dateCounts));

  const dayLabels = ['', 'M', '', 'W', '', 'F', ''];
  let svg = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`;

  // Day labels
  for (let d = 0; d < 7; d++) {
    if (dayLabels[d]) {
      svg += `<text x="${leftPad - 6}" y="${topPad + d * (cellSize + cellGap) + cellSize - 2}" font-size="8" text-anchor="end">${dayLabels[d]}</text>`;
    }
  }

  // Month labels
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let lastMonth = -1;

  const cursor = new Date(startDate);
  // Adjust to start on Sunday
  cursor.setDate(cursor.getDate() - cursor.getDay());

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const count = dateCounts[dateStr] || 0;

      if (cursor.getDate() <= 7 && cursor.getMonth() !== lastMonth && d === 0) {
        lastMonth = cursor.getMonth();
        svg += `<text x="${leftPad + w * (cellSize + cellGap)}" y="${topPad - 4}" font-size="7">${monthNames[cursor.getMonth()]}</text>`;
      }

      if (cursor <= today && cursor >= startDate) {
        const intensity = count > 0 ? Math.min(1, count / maxCount * 0.8 + 0.2) : 0;
        const fill = count === 0 ? 'rgba(255,255,255,0.04)' :
          `rgba(255,215,0,${(intensity * 0.7 + 0.15).toFixed(2)})`;
        const rx = leftPad + w * (cellSize + cellGap);
        const ry = topPad + d * (cellSize + cellGap);
        svg += `<rect x="${rx}" y="${ry}" width="${cellSize}" height="${cellSize}" rx="2" fill="${fill}" stroke="rgba(255,255,255,0.03)"><title>${dateStr}: ${count} card${count !== 1 ? 's' : ''}</title></rect>`;
      }

      cursor.setDate(cursor.getDate() + 1);
    }
  }

  svg += '</svg>';

  const totalDates = Object.keys(dateCounts).length;
  const totalAdded = Object.values(dateCounts).reduce((a, b) => a + b, 0);
  el.innerHTML = svg + `<div style="font-size:0.55rem;color:var(--text-dim);font-family:'DM Mono',monospace;margin-top:4px;text-align:center;">${totalAdded} cards across ${totalDates} day${totalDates !== 1 ? 's' : ''}</div>`;
}

/* ============================================================
   CONFETTI CELEBRATION
   ============================================================ */
function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#FFD700', '#FF2255', '#00FFFF', '#C45E2C', '#D4956A', '#00FF88', '#FF6B35', '#7B2FBE'];

  for (let i = 0; i < 150; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 16,
      vy: Math.random() * -18 - 4,
      size: Math.random() * 7 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.3,
      gravity: 0.25 + Math.random() * 0.15,
      life: 1,
      decay: 0.008 + Math.random() * 0.006,
      shape: Math.random() > 0.5 ? 'rect' : 'circle'
    });
  }

  let animId;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    particles.forEach(p => {
      if (p.life <= 0) return;
      alive = true;
      p.x += p.vx;
      p.vy += p.gravity;
      p.y += p.vy;
      p.vx *= 0.98;
      p.rotation += p.rotSpeed;
      p.life -= p.decay;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    if (alive) { animId = requestAnimationFrame(animate); }
    else { ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }

  animate();
  // Safety cleanup after 5 seconds
  setTimeout(() => {
    cancelAnimationFrame(animId);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, 5000);
}

/* ============================================================
   3D VERTEX MESH CANVAS BACKGROUND (Enhanced)
   ============================================================ */
function initCanvas() {
  const canvas = document.getElementById('bgCanvas');
  const ctx = canvas.getContext('2d');
  let W, H;
  let mouseX = 0, mouseY = 0;
  let vertices = [];
  let shapes = [];
  let shootingStars = [];
  let nebulaClouds = [];
  let globalTime = 0;

  const isMobile = window.innerWidth < 768;
  const VERTEX_COUNT = isMobile ? 90 : 200;
  const SHAPE_COUNT = isMobile ? 8 : 20;
  const NEBULA_COUNT = isMobile ? 3 : 6;
  const MAX_EDGE_DIST = 140;
  const DEPTH_RANGE = 600;
  const FOCAL = 400;
  const DRIFT_SPEED = 0.3;
  const MOUSE_INFLUENCE = 0.04;
  const colors = [
    [255, 215, 0],    // gold
    [196, 94, 44],    // rust
    [212, 149, 106],  // copper
    [92, 131, 116],   // patina
    [255, 34, 85],    // crimson
  ];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
  if ('ontouchstart' in window) {
    document.addEventListener('touchmove', (e) => {
      if (e.touches[0]) { mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY; }
    }, { passive: true });
  }

  // Init vertices
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const r = Math.random();
    const colorPick = r < 0.05 ? 4 : r < 0.15 ? 3 : r < 0.40 ? 1 : r < 0.55 ? 2 : 0;
    vertices.push({
      x: (Math.random() - 0.5) * W * 1.5,
      y: (Math.random() - 0.5) * H * 1.5,
      z: Math.random() * DEPTH_RANGE,
      vx: (Math.random() - 0.5) * DRIFT_SPEED,
      vy: (Math.random() - 0.5) * DRIFT_SPEED,
      vz: (Math.random() - 0.5) * DRIFT_SPEED * 0.5,
      color: colors[colorPick],
    });
  }

  // Init floating geometric shapes (triangles, hexagons, diamonds, rings)
  const shapeTypes = ['triangle', 'hexagon', 'diamond', 'ring', 'pokeball'];
  for (let i = 0; i < SHAPE_COUNT; i++) {
    const r = Math.random();
    const colorPick = r < 0.1 ? 4 : r < 0.25 ? 3 : r < 0.50 ? 1 : r < 0.70 ? 2 : 0;
    shapes.push({
      x: (Math.random() - 0.5) * W * 1.4,
      y: (Math.random() - 0.5) * H * 1.4,
      z: Math.random() * DEPTH_RANGE,
      vx: (Math.random() - 0.5) * DRIFT_SPEED * 0.4,
      vy: (Math.random() - 0.5) * DRIFT_SPEED * 0.4,
      vz: (Math.random() - 0.5) * DRIFT_SPEED * 0.3,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.008,
      size: 12 + Math.random() * 20,
      type: shapeTypes[Math.floor(Math.random() * shapeTypes.length)],
      color: colors[colorPick],
      pulse: Math.random() * Math.PI * 2,
    });
  }

  // Init nebula clouds (soft glowing blobs)
  for (let i = 0; i < NEBULA_COUNT; i++) {
    const colorPick = Math.floor(Math.random() * colors.length);
    nebulaClouds.push({
      x: Math.random() * W,
      y: Math.random() * H,
      radius: 100 + Math.random() * 200,
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      color: colors[colorPick],
      alpha: 0.015 + Math.random() * 0.02,
      pulse: Math.random() * Math.PI * 2,
    });
  }

  function project(v) {
    const scale = FOCAL / (v.z + FOCAL);
    return { sx: v.x * scale + W / 2, sy: v.y * scale + H / 2, scale };
  }

  // Draw a geometric shape outline
  function drawShape(ctx, type, sx, sy, size, rotation, color, alpha) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(rotation);
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha.toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const s = size;
    switch (type) {
      case 'triangle':
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.866, s * 0.5);
        ctx.lineTo(-s * 0.866, s * 0.5);
        ctx.closePath();
        break;
      case 'hexagon':
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          const px = Math.cos(a) * s, py = Math.sin(a) * s;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      case 'diamond':
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.6, 0);
        ctx.lineTo(0, s);
        ctx.lineTo(-s * 0.6, 0);
        ctx.closePath();
        break;
      case 'ring':
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        break;
      case 'pokeball':
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.moveTo(-s, 0);
        ctx.lineTo(s, 0);
        break;
    }
    ctx.stroke();
    // Inner glow fill
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(alpha * 0.08).toFixed(3)})`;
    ctx.fill();
    ctx.restore();
  }

  // Spawn a shooting star occasionally
  function maybeSpawnShootingStar() {
    if (Math.random() < (isMobile ? 0.003 : 0.006)) {
      const c = colors[Math.floor(Math.random() * colors.length)];
      shootingStars.push({
        x: Math.random() * W,
        y: Math.random() * H * 0.4,
        vx: 3 + Math.random() * 4,
        vy: 1.5 + Math.random() * 2,
        life: 1,
        decay: 0.015 + Math.random() * 0.01,
        color: c,
        trail: [],
      });
    }
  }

  let lastTime = 0;
  function animate(timestamp) {
    const dt = Math.min((timestamp - lastTime) / 16.67, 3);
    lastTime = timestamp;
    globalTime += dt * 0.01;

    ctx.clearRect(0, 0, W, H);

    // === Draw nebula clouds (behind everything) ===
    for (let i = 0; i < nebulaClouds.length; i++) {
      const n = nebulaClouds[i];
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.pulse += 0.003 * dt;
      if (n.x > W + n.radius) n.x = -n.radius;
      if (n.x < -n.radius) n.x = W + n.radius;
      if (n.y > H + n.radius) n.y = -n.radius;
      if (n.y < -n.radius) n.y = H + n.radius;
      const pulseAlpha = n.alpha * (0.7 + 0.3 * Math.sin(n.pulse));
      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.radius);
      grad.addColorStop(0, `rgba(${n.color[0]},${n.color[1]},${n.color[2]},${pulseAlpha.toFixed(3)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(n.x - n.radius, n.y - n.radius, n.radius * 2, n.radius * 2);
    }

    // Mouse influence (yaw/pitch rotation)
    const mxNorm = (mouseX / W - 0.5) * MOUSE_INFLUENCE;
    const myNorm = (mouseY / H - 0.5) * MOUSE_INFLUENCE;
    const cosY = Math.cos(mxNorm), sinY = Math.sin(mxNorm);
    const cosP = Math.cos(myNorm), sinP = Math.sin(myNorm);

    // === Update + project vertices ===
    const projected = [];
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.z += v.vz * dt;

      if (v.x > W) v.x = -W;
      if (v.x < -W) v.x = W;
      if (v.y > H) v.y = -H;
      if (v.y < -H) v.y = H;
      if (v.z > DEPTH_RANGE) v.z = 0;
      if (v.z < 0) v.z = DEPTH_RANGE;

      const rx = v.x * cosY - v.z * sinY;
      const rz = v.x * sinY + v.z * cosY;
      const ry = v.y * cosP - rz * sinP;
      const rz2 = v.y * sinP + rz * cosP;

      const tempV = { x: rx, y: ry, z: Math.max(rz2, 1) };
      const p = project(tempV);
      p.color = v.color;
      p.z = tempV.z;
      projected.push(p);
    }

    // === Draw edges ===
    for (let i = 0; i < projected.length; i++) {
      for (let j = i + 1; j < projected.length; j++) {
        const dx = projected[i].sx - projected[j].sx;
        const dy = projected[i].sy - projected[j].sy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_EDGE_DIST) {
          const opacity = (1 - dist / MAX_EDGE_DIST) * 0.6 * Math.min(projected[i].scale, projected[j].scale);
          const c = projected[i].color;
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${opacity.toFixed(3)})`;
          ctx.lineWidth = opacity * 1.5;
          ctx.beginPath();
          ctx.moveTo(projected[i].sx, projected[i].sy);
          ctx.lineTo(projected[j].sx, projected[j].sy);
          ctx.stroke();
        }
      }
    }

    // === Draw vertices ===
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      const r = Math.max(1, p.scale * 3);
      const c = p.color;
      const alpha = Math.min(1, p.scale * 1.2);

      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
      ctx.fill();

      // Glow
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(alpha * 0.15).toFixed(3)})`;
      ctx.fill();
    }

    // === Update + draw floating geometric shapes ===
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rotation += s.rotSpeed * dt;
      s.pulse += 0.015 * dt;

      if (s.x > W) s.x = -W;
      if (s.x < -W) s.x = W;
      if (s.y > H) s.y = -H;
      if (s.y < -H) s.y = H;
      if (s.z > DEPTH_RANGE) s.z = 0;
      if (s.z < 0) s.z = DEPTH_RANGE;

      const rx = s.x * cosY - s.z * sinY;
      const rz = s.x * sinY + s.z * cosY;
      const ry = s.y * cosP - rz * sinP;
      const rz2 = s.y * sinP + rz * cosP;
      const tempV = { x: rx, y: ry, z: Math.max(rz2, 1) };
      const p = project(tempV);
      const shapeAlpha = Math.min(0.35, p.scale * 0.5) * (0.6 + 0.4 * Math.sin(s.pulse));
      drawShape(ctx, s.type, p.sx, p.sy, s.size * p.scale, s.rotation, s.color, shapeAlpha);
    }

    // === Shooting stars ===
    maybeSpawnShootingStar();
    for (let i = shootingStars.length - 1; i >= 0; i--) {
      const ss = shootingStars[i];
      ss.trail.push({ x: ss.x, y: ss.y, life: ss.life });
      ss.x += ss.vx * dt;
      ss.y += ss.vy * dt;
      ss.life -= ss.decay * dt;

      // Draw trail
      for (let t = ss.trail.length - 1; t >= 0; t--) {
        ss.trail[t].life -= ss.decay * dt * 0.8;
        if (ss.trail[t].life <= 0) { ss.trail.splice(t, 1); continue; }
        const ta = ss.trail[t].life * 0.5;
        const tr = 1 + ss.trail[t].life * 1.5;
        ctx.beginPath();
        ctx.arc(ss.trail[t].x, ss.trail[t].y, tr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${ss.color[0]},${ss.color[1]},${ss.color[2]},${ta.toFixed(3)})`;
        ctx.fill();
      }

      // Draw head
      if (ss.life > 0) {
        const headR = 2 + ss.life * 2;
        ctx.beginPath();
        ctx.arc(ss.x, ss.y, headR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${ss.color[0]},${ss.color[1]},${ss.color[2]},${ss.life.toFixed(3)})`;
        ctx.fill();
        // Head glow
        ctx.beginPath();
        ctx.arc(ss.x, ss.y, headR * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${ss.color[0]},${ss.color[1]},${ss.color[2]},${(ss.life * 0.2).toFixed(3)})`;
        ctx.fill();
      }

      if (ss.life <= 0 && ss.trail.length === 0) {
        shootingStars.splice(i, 1);
      }
    }

    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}
