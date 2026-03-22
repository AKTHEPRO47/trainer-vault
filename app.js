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
  applyFiltersAndRender();
});

/* ============================================================
   LOAD CARDS (static JSON file — works on any host)
   ============================================================ */
async function loadCards() {
  try {
    const resp = await fetch('/trainer_vault_cards.json');
    if (resp.ok) {
      const raw = await resp.json();
      ALL_CARDS = raw.map(c => ({
        id: c.id,
        name: c.name,
        cardNumber: c.card_number,
        set: c.set_name,
        era: c.era,
        variant: c.variant,
      }));
    }
  } catch(e) {
    console.warn('Could not fetch cards.', e);
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
  filteredCards.forEach(card => {
    const st = getCardState(card.id);
    const tile = document.createElement('div');
    tile.className = 'card-tile glass ' + (st.inCollection ? 'collected' : 'uncollected');
    tile.dataset.id = card.id;

    const eraKey = ERA_KEYS[card.era] || 'bw';
    const condClass = st.condition ? ('cond-' + st.condition.replace('+','P')) : '';
    const condBadge = st.condition ? `<span class="badge badge-condition ${condClass}">${st.condition}</span>` : '';
    const wantBadge = st.wantList ? '<span class="badge badge-want">WANT</span>' : '';

    tile.innerHTML = `
      <div class="collected-check">${st.inCollection ? '✓' : ''}</div>
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

    tile.addEventListener('click', (e) => {
      if (e.detail === 1) {
        // Single click: toggle collection
        setTimeout(() => {
          if (!tile._dblclick) {
            toggleCollection(card.id);
          }
          tile._dblclick = false;
        }, 250);
      }
    });
    tile.addEventListener('dblclick', () => {
      tile._dblclick = true;
      openModal(card.id);
    });
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
      <div class="set-body">
        ${info.cards.map(c => {
          const st = getCardState(c.id);
          return `<span class="timeline-chip ${st.inCollection ? 'collected' : ''}" onclick="openModal(${c.id})">${escapeHtml(c.name)} (${escapeHtml(c.cardNumber)})</span>`;
        }).join('')}
      </div>
    `;
    container.appendChild(section);
  });
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
  ALL_CARDS.forEach(c => {
    const st = getCardState(c.id);
    if (st.purchasePrice) totalVal += parseFloat(st.purchasePrice) || 0;
  });
  document.getElementById('totalValue').textContent = '$' + totalVal.toFixed(2);
  document.getElementById('statValueVal').textContent = '$' + (totalVal >= 1000 ? (totalVal/1000).toFixed(1)+'k' : totalVal.toFixed(0));
  document.getElementById('valueSub').textContent = collected + ' cards priced';

  // Update recently added
  renderRecentlyAdded();

  // Want count
  const wantCount = ALL_CARDS.filter(c => getCardState(c.id).wantList).length;
  document.getElementById('wantCount').textContent = wantCount;
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
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  currentModalCard = null;
  applyFiltersAndRender();
}

/* ============================================================
   CARD IMAGE LOADING (Pokémon TCG API)
   ============================================================ */
function loadCardImage(card) {
  const wrap = document.getElementById('modalImageWrap');
  const placeholder = document.getElementById('modalImagePlaceholder');

  // If already cached, show immediately
  if (imageCache[card.id]) {
    showCardImage(imageCache[card.id]);
    return;
  }
  if (imageCache[card.id] === null) {
    showImagePlaceholder('No image available');
    return;
  }

  // Show loading state
  showImagePlaceholder('Loading card image...');

  // Build query: search by card number and set name
  const num = card.cardNumber.split('/')[0].trim();
  const setName = card.set;
  const query = encodeURIComponent(`number:"${num}" set.name:"${setName}"`);

  fetch(`https://api.pokemontcg.io/v2/cards?q=${query}&pageSize=5&select=id,name,number,images`)
    .then(r => r.json())
    .then(data => {
      if (data.data && data.data.length > 0) {
        // Try to find exact match by name
        let match = data.data.find(c => c.name.toLowerCase() === card.name.toLowerCase());
        if (!match) match = data.data[0];
        const imgUrl = match.images.large || match.images.small;
        imageCache[card.id] = imgUrl;
        // Only update if this card is still the one displayed
        if (currentModalCard && currentModalCard.id === card.id) {
          showCardImage(imgUrl);
        }
      } else {
        // Fallback: search by name only
        fetchImageByName(card);
      }
    })
    .catch(() => {
      imageCache[card.id] = null;
      if (currentModalCard && currentModalCard.id === card.id) {
        showImagePlaceholder('Could not load image');
      }
    });
}

function fetchImageByName(card) {
  const query = encodeURIComponent(`name:"${card.name}"`);
  fetch(`https://api.pokemontcg.io/v2/cards?q=${query}&pageSize=15&select=id,name,number,set,images`)
    .then(r => r.json())
    .then(data => {
      if (data.data && data.data.length > 0) {
        // Try matching set name
        let match = data.data.find(c => c.set && c.set.name === card.set);
        if (!match) match = data.data[0];
        const imgUrl = match.images.large || match.images.small;
        imageCache[card.id] = imgUrl;
        if (currentModalCard && currentModalCard.id === card.id) {
          showCardImage(imgUrl);
        }
      } else {
        imageCache[card.id] = null;
        if (currentModalCard && currentModalCard.id === card.id) {
          showImagePlaceholder('No image found for this card');
        }
      }
    })
    .catch(() => {
      imageCache[card.id] = null;
      if (currentModalCard && currentModalCard.id === card.id) {
        showImagePlaceholder('Could not load image');
      }
    });
}

function showCardImage(url) {
  const wrap = document.getElementById('modalImageWrap');
  wrap.innerHTML = `<img class="modal-card-image" src="${escapeHtml(url)}" alt="Card Image" onerror="this.outerHTML='<div class=\\'modal-card-image-placeholder\\'>Image failed to load</div>'">`;
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
  const panel = document.getElementById('chatbotPanel');
  if (!panel.classList.contains('open')) toggleChatbot();
  document.getElementById('chatInput').value = `Price check: ${currentModalCard.name} (${currentModalCard.cardNumber}) from ${currentModalCard.set}`;
  sendChat();
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  chatHistory.push({ role: 'user', content: msg });
  appendChatMsg('user', msg);
  appendChatMsg('assistant loading', '');

  try {
    const resp = await fetch('/api/price-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory })
    });
    const data = await resp.json();
    removeChatLoading();
    chatHistory.push({ role: 'assistant', content: data.reply });
    appendChatMsg('assistant', data.reply);
  } catch(e) {
    removeChatLoading();
    appendChatMsg('system', 'Error connecting to Price Oracle. Is the server running?');
  }
}

function appendChatMsg(cls, text) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + cls;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeChatLoading() {
  const loading = document.querySelector('.chat-msg.loading');
  if (loading) loading.remove();
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
   DIM MODE
   ============================================================ */
function toggleDimMode() {
  document.body.classList.toggle('dim-mode');
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
    case 'escape':
      if (document.getElementById('modalOverlay').classList.contains('open')) closeModal();
      else if (document.getElementById('chatbotPanel').classList.contains('open')) toggleChatbot();
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
   3D VERTEX MESH CANVAS BACKGROUND
   ============================================================ */
function initCanvas() {
  const canvas = document.getElementById('bgCanvas');
  const ctx = canvas.getContext('2d');
  let W, H;
  let mouseX = 0, mouseY = 0;
  let vertices = [];

  const isMobile = window.innerWidth < 768;
  const VERTEX_COUNT = isMobile ? 80 : 180;
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
    [255, 34, 85],    // crimson (rare spark)
  ];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });

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

  function project(v) {
    const scale = FOCAL / (v.z + FOCAL);
    return {
      sx: v.x * scale + W / 2,
      sy: v.y * scale + H / 2,
      scale: scale
    };
  }

  let lastTime = 0;
  function animate(timestamp) {
    const dt = Math.min((timestamp - lastTime) / 16.67, 3);
    lastTime = timestamp;

    ctx.clearRect(0, 0, W, H);

    // Mouse influence (yaw/pitch rotation)
    const mxNorm = (mouseX / W - 0.5) * MOUSE_INFLUENCE;
    const myNorm = (mouseY / H - 0.5) * MOUSE_INFLUENCE;
    const cosY = Math.cos(mxNorm), sinY = Math.sin(mxNorm);
    const cosP = Math.cos(myNorm), sinP = Math.sin(myNorm);

    // Update + project
    const projected = [];
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.z += v.vz * dt;

      // Wrap
      if (v.x > W) v.x = -W;
      if (v.x < -W) v.x = W;
      if (v.y > H) v.y = -H;
      if (v.y < -H) v.y = H;
      if (v.z > DEPTH_RANGE) v.z = 0;
      if (v.z < 0) v.z = DEPTH_RANGE;

      // Apply mouse rotation
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

    // Draw edges
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

    // Draw vertices
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

    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}
