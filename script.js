/*
  Lead ↔ Sales Matcher (client-only)
*/

(function () {
  const leadInput = document.getElementById('leadCsv');
  const salesInput = document.getElementById('salesCsv');
  const matchBtn = document.getElementById('matchBtn');
  const summaryEl = document.getElementById('summary');
  const downloadLink = document.getElementById('downloadLink');
  const preview = document.getElementById('preview');
  const previewTableContainer = document.getElementById('previewTableContainer');

  let leads = [];
  let sales = [];
  let originalSalesRows = [];
  let originalLeadRows = [];
  let leadsPromise = null;
  let salesPromise = null;

  function enableMatchIfReady() {
    const filesChosen = (leadInput.files && leadInput.files.length > 0) && (salesInput.files && salesInput.files.length > 0);
    const dataReady = leads.length && sales.length;
    const shouldEnable = (filesChosen || dataReady);
    matchBtn.disabled = !shouldEnable;
    if (shouldEnable) {
      matchBtn.removeAttribute('disabled');
    }
  }

  // Utils
  function toLowerTrim(value) {
    return (value ?? '').toString().trim().toLowerCase();
  }

  function normalizePhone(raw) {
    const s = (raw ?? '').toString();
    const digits = s.replace(/\D+/g, '');
    return digits;
  }

  function normalizeLocation(raw) {
    let s = (raw ?? '').toString().trim().toLowerCase();
    if (!s) return '';
    // German umlaut/ß normalization
    s = s
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss');
    // Remove common company words
    const companyWords = [
      'gmbh', 'ag', 'kg', 'mbh', 'co', 'kg', 'kga', 'se', 'ug', 'ohg', 'autohaus', 'autos', 'group', 'gruppe', 'holding', 'handel', 'vertrieb'
    ];
    // Replace punctuation with spaces
    s = s.replace(/[^a-z0-9]+/g, ' ');
    // Remove company words as standalone tokens
    const tokens = s.split(/\s+/).filter(Boolean).filter(t => !companyWords.includes(t));
    s = tokens.join(' ');
    return s.trim();
  }

  function parseDateDMY(value) {
    // DD-MM-YYYY
    const s = (value ?? '').toString().trim();
    if (!s) return null;
    const [dd, mm, yyyy] = s.split('-').map(Number);
    if (!dd || !mm || !yyyy) return null;
    return new Date(yyyy, mm - 1, dd);
  }

  function parseDateDMDots(value) {
    // DD.MM.YYYY
    const s = (value ?? '').toString().trim();
    if (!s) return null;
    const [dd, mm, yyyy] = s.split('.').map(Number);
    if (!dd || !mm || !yyyy) return null;
    return new Date(yyyy, mm - 1, dd);
  }

  function daysBetween(a, b) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const diff = b - a;
    return Math.floor(diff / msPerDay);
  }

  function isAnonymized(str) {
    return (str ?? '').includes('*');
  }

  function countAlnum(segment) {
    const m = (segment ?? '').match(/[a-z0-9]/gi);
    return m ? m.length : 0;
  }

  // Name patterns
  function tokenizeName(name) {
    const s = toLowerTrim(name);
    if (!s) return [];
    return s.split(/\s+/g).filter(Boolean);
  }

  function namePattern(name) {
    // For anonymized: count stars per segment
    // For normal: count alnum per segment
    const tokens = tokenizeName(name);
    if (isAnonymized(name)) {
      return tokens.map(t => (t.match(/\*/g) || []).length);
    }
    return tokens.map(t => countAlnum(t));
  }

  function compareNameExact(a, b) {
    // exact non-anonymized comparison (set/subset, order-insensitive)
    const ta = tokenizeName(a).filter(x => !isAnonymized(x));
    const tb = tokenizeName(b).filter(x => !isAnonymized(x));
    if (!ta.length || !tb.length) return false;
    const setA = new Set(ta);
    const setB = new Set(tb);
    let aInB = true;
    for (const x of setA) if (!setB.has(x)) { aInB = false; break; }
    let bInA = true;
    for (const x of setB) if (!setA.has(x)) { bInA = false; break; }
    return aInB || bInA || (setA.size === setB.size && aInB && bInA);
  }

  function patternDiff(arrA, arrB) {
    const len = Math.max(arrA.length, arrB.length);
    let diff = 0;
    for (let i = 0; i < len; i++) {
      const a = arrA[i] ?? 0;
      const b = arrB[i] ?? 0;
      diff += Math.abs(a - b);
    }
    return diff;
  }

  // Email patterns
  function normalizeEmail(email) {
    return toLowerTrim(email);
  }

  function emailPattern(email) {
    const e = normalizeEmail(email);
    if (!e) return { local: [], domain: [] };
    const [local, domain] = e.split('@');
    const localParts = (local ?? '').split(/[\.-]/g).filter(Boolean);
    const domainParts = (domain ?? '').split(/[\.-]/g).filter(Boolean);
    if (isAnonymized(email)) {
      return {
        local: localParts.map(p => (p.match(/\*/g) || []).length),
        domain: domainParts.map(p => (p.match(/\*/g) || []).length)
      };
    }
    return {
      local: localParts.map(countAlnum),
      domain: domainParts.map(countAlnum)
    };
  }

  function emailExactMatch(a, b) {
    const na = normalizeEmail(a);
    const nb = normalizeEmail(b);
    if (!na || !nb) return false;
    if (isAnonymized(na) || isAnonymized(nb)) return false;
    return na === nb;
  }

  // Car match
  function stringIncludes(haystack, needle) {
    const h = toLowerTrim(haystack);
    const n = toLowerTrim(needle);
    if (!h || !n) return false;
    return h.includes(n);
  }

  function parseViewedCarFromUrl(url) {
    const u = (url ?? '').toString().trim();
    if (!u) return { brand: '', model: '', slug: '' };
    try {
      const withoutAt = u.replace(/^@/, '');
      const parsed = new URL(withoutAt);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const carIdx = parts.findIndex(p => p.toLowerCase() === 'car');
      const slug = carIdx >= 0 && parts[carIdx + 1] ? parts[carIdx + 1] : parts[parts.length - 1] || '';
      const beforeTilde = slug.split('~')[0];
      const tokens = beforeTilde.split('-').filter(Boolean);
      const brand = tokens[0] || '';
      const model = tokens.slice(1).join(' ').replace(/\s+/g, ' ').trim();
      return { brand: toLowerTrim(brand), model: toLowerTrim(model), slug: beforeTilde };
    } catch (_) {
      // Fallback simple parse if URL constructor fails
      const s = u.split('/').filter(Boolean);
      const last = s[s.length - 1] || '';
      const beforeTilde = last.split('~')[0];
      const tokens = beforeTilde.split('-').filter(Boolean);
      const brand = tokens[0] || '';
      const model = tokens.slice(1).join(' ').replace(/\s+/g, ' ').trim();
      return { brand: toLowerTrim(brand), model: toLowerTrim(model), slug: beforeTilde };
    }
  }

  function getLeadIdFromRow(row, fallbackIndex) {
    // Try common ID fields; fallback to index if none
    const candidates = [
      'lead_id', 'id', 'leadId', 'LeadId', 'Lead ID', 'AutoUncleLeadId', 'autouncle_lead_id'
    ];
    for (const key of candidates) {
      if (row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
    }
    return String(fallbackIndex);
  }

  function normalizeLeadRow(row, index) {
    const normalized = { ...row };
    normalized._index = index;
    normalized._leadId = getLeadIdFromRow(row, index);
    normalized.buyer_name = toLowerTrim(row.buyer_name);
    normalized.buyer_email = toLowerTrim(row.buyer_email);
    normalized.buyer_phone_number = toLowerTrim(row.buyer_phone_number);
    normalized.buyer_car_brand = toLowerTrim(row.buyer_car_brand);
    normalized.buyer_car_car_model = toLowerTrim(row.buyer_car_car_model);
    normalized.verified_completed_or_created_at_obj = parseDateDMY(row.verified_completed_or_created_at);
    normalized.vin_lpn = toLowerTrim(row.vin_lpn);
    // Viewed car from seller_car_url
    const viewed = parseViewedCarFromUrl(row.seller_car_url || row['seller_car_url'] || row['Seller Car Url'] || '');
    normalized._viewBrand = viewed.brand;
    normalized._viewModel = viewed.model;
    normalized._viewSlug = viewed.slug;
    // Lead location should prefer owner_name semantics
    const ownerLike = row.owner_name || row['Owner Name'] || row['Owner'] || '';
    let leadLocation = ownerLike;
    if (!leadLocation) {
      const locationCandidates = [
        'buyer_city', 'buyer_country', 'buyer_location', 'buyer_zip', 'buyer_postcode', 'buyer_region', 'buyer_state'
      ];
      for (const key of locationCandidates) {
        if (row[key] && String(row[key]).trim() !== '') { leadLocation = row[key]; break; }
      }
    }
    normalized._leadLocation = normalizeLocation(leadLocation);
    normalized._namePattern = namePattern(normalized.buyer_name);
    const ep = emailPattern(normalized.buyer_email);
    normalized._emailPatternLocal = ep.local;
    normalized._emailPatternDomain = ep.domain;
    return normalized;
  }

  function normalizeSalesRow(row, index) {
    // Sales CSV: headers are on the second line; we will already parse with header:true for line 2.
    const normalized = { ...row };
    normalized._index = index;
    normalized['Käufer'] = toLowerTrim(row['Käufer']);
    normalized['E-Mail'] = toLowerTrim(row['E-Mail']);
    normalized['Telefon'] = toLowerTrim(row['Telefon'] || row['Phone'] || row['phone'] || '');
    normalized._phoneNorm = normalizePhone(row['Telefon'] || row['Phone'] || row['phone'] || '');
    normalized['Typ'] = toLowerTrim(row['Typ']);
    normalized['Fahrgestell Nr.'] = toLowerTrim(row['Fahrgestell Nr.']);
    normalized['Standort'] = toLowerTrim(row['Standort']);
    normalized._standortNorm = normalizeLocation(row['Standort']);
    normalized['verkauft am_obj'] = parseDateDMDots(row['verkauft am']);
    normalized._namePattern = namePattern(normalized['Käufer']);
    const ep = emailPattern(normalized['E-Mail']);
    normalized._emailPatternLocal = ep.local;
    normalized._emailPatternDomain = ep.domain;
    return normalized;
  }

  function computeMatch(le, sa) {
    let score = 0;
    let nonDateSignalScore = 0;
    const explanation = [];
    let forceHundred = false;

    // VIN match
    const leadVin = le.vin_lpn;
    const saleVin = sa['Fahrgestell Nr.'];
    if (leadVin && saleVin && leadVin === saleVin) {
      score += 100;
      nonDateSignalScore += 100;
      explanation.push('VIN match');
    }

    // Email exact (non-anonymized)
    if (emailExactMatch(le.buyer_email, sa['E-Mail'])) {
      score += 50;
      nonDateSignalScore += 50;
      explanation.push('Exact email');
      forceHundred = true;
    } else {
      // Email pattern
      const isLeadEmailAnon = isAnonymized(le.buyer_email);
      const isSaleEmailAnon = isAnonymized(sa['E-Mail']);
      if (isLeadEmailAnon || isSaleEmailAnon) {
        const diffLocal = patternDiff(le._emailPatternLocal, sa._emailPatternLocal);
        const diffDomain = patternDiff(le._emailPatternDomain, sa._emailPatternDomain);
        const diff = diffLocal + diffDomain;
        const emailScore = Math.max(20 - 2 * diff, 0);
        if (emailScore > 0) {
          score += emailScore;
          nonDateSignalScore += emailScore;
          explanation.push(`Email pattern (score ${emailScore.toFixed(0)})`);
        }
      }
    }

    // Exact name match (non-anonymized) can force 100%
    if (le.buyer_name && sa['Käufer'] && !isAnonymized(le.buyer_name) && !isAnonymized(sa['Käufer'])) {
      if (compareNameExact(le.buyer_name, sa['Käufer'])) {
        explanation.push('Exact name');
        forceHundred = true;
      }
    }

    // Exact phone match (if sales phone exists)
    const leadPhoneNorm = normalizePhone(le.buyer_phone_number);
    if (leadPhoneNorm && sa._phoneNorm && leadPhoneNorm === sa._phoneNorm) {
      explanation.push('Exact phone');
      forceHundred = true;
    }

    // Car match: use viewed car brand/model from lead URL vs sale Typ
    let carScore = 0;
    const brandMatch = stringIncludes(sa['Typ'], le._viewBrand);
    const modelMatch = stringIncludes(sa['Typ'], le._viewModel);
    if (brandMatch && modelMatch) {
      carScore = 30;
    } else if (brandMatch || modelMatch) {
      carScore = 20;
    }
    if (carScore > 0) {
      score += carScore;
      nonDateSignalScore += carScore;
      explanation.push(carScore === 30 ? 'Viewed brand and model match' : 'Viewed brand/model match');
    }

    // Standort (location) supporting match: compare sale Standort with lead owner_name-based location
    const saleLocation = sa._standortNorm;
    if (saleLocation && le._leadLocation) {
      let locScore = 0;
      if (saleLocation === le._leadLocation) locScore = 10;
      else if (saleLocation.includes(le._leadLocation) || le._leadLocation.includes(saleLocation)) locScore = 6;
      if (nonDateSignalScore > 0 && locScore > 0) {
        score += locScore;
        explanation.push('Location match (Standort)');
      }
    }

    // Date difference
    const leadDate = le.verified_completed_or_created_at_obj;
    const saleDate = sa['verkauft am_obj'];
    if (leadDate && saleDate) {
      const diffDays = daysBetween(leadDate, saleDate);
      if (diffDays < 0) {
        // Sale before lead → invalid
        return { score: 0, probability: 0, explanation: ['Sale before lead date'] };
      }
      // Date is only a supporting factor: only add if we already have other signals
      const dateScore = Math.max(10 - (diffDays / 7), 0);
      if (nonDateSignalScore > 0 && dateScore > 0) {
        score += dateScore;
        explanation.push(`Sale ${diffDays} days after lead`);
      }
    }

    let probability = Math.min(score / 100, 1);
    if (forceHundred) {
      probability = 1;
      if (!explanation.some(e => e.includes('100%'))) {
        explanation.push('Forcing 100% due to exact identifier');
      }
    }
    return { score, probability, explanation };
  }

  function parseLeadCsv(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          const rows = res.data || [];
          originalLeadRows = rows.map(r => ({ ...r }));
          const normalized = rows.map((r, i) => normalizeLeadRow(r, i));
          resolve(normalized);
        },
        error: reject
      });
    });
  }

  function parseSalesCsv(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        beforeFirstChunk: function (chunk) {
          // Remove first line if it is a title like "Sales data"
          const lines = chunk.split(/\r?\n/);
          if (lines.length > 1) {
            const firstLine = lines[0].toLowerCase();
            // Heuristic: if first line does not contain delimiter-like commas for all fields or includes a title keyword
            const looksLikeTitle = /sales|data|verkauf|report|export/.test(firstLine);
            if (looksLikeTitle) {
              return lines.slice(1).join('\n');
            }
          }
          return chunk;
        },
        complete: (res) => {
          const rows = res.data || [];
          // Keep the original row to unparse later (preserving unknown columns)
          originalSalesRows = rows.map(r => ({ ...r }));
          const normalized = rows.map((r, i) => normalizeSalesRow(r, i));
          resolve({ normalized, original: originalSalesRows });
        },
        error: reject
      });
    });
  }

  async function doMatch() {
    const threshold = 0.30;

    // Compute all pairwise matches
    const candidates = [];
    for (let i = 0; i < sales.length; i++) {
      const sale = sales[i];
      for (let j = 0; j < leads.length; j++) {
        const lead = leads[j];
        const res = computeMatch(lead, sale);
        const probabilityRounded = Math.round(res.probability * 100) / 100;
        if (probabilityRounded >= threshold) {
          candidates.push({
            saleIndex: i,
            leadIndex: lead._index,
            probability: probabilityRounded,
            explanation: res.explanation,
            score: res.score
          });
        }
      }
    }

    // Sort candidates by probability desc, then score desc
    candidates.sort((a, b) => b.probability - a.probability || b.score - a.score);

    // Greedy assignment: each lead can be used once, each sale takes best available
    const assignedSaleToLead = new Map();
    const usedLead = new Set();
    for (const c of candidates) {
      if (assignedSaleToLead.has(c.saleIndex)) continue;
      if (usedLead.has(c.leadIndex)) continue;
      assignedSaleToLead.set(c.saleIndex, c);
      usedLead.add(c.leadIndex);
    }

    // Build preview and prepare output collection
    const previewRows = [];
    let matched = 0;
    let unmatched = 0;

    // Collect rows with their probabilities for sorting output
    const outputWithProb = [];

    for (let i = 0; i < sales.length; i++) {
      const sale = sales[i];
      const assignment = assignedSaleToLead.get(i) || null;
      const isMatched = Boolean(assignment);
      const probabilityRounded = assignment ? assignment.probability : 0;
      const explanationText = assignment ? assignment.explanation.join('; ') : '';

      if (isMatched) matched++; else unmatched++;

      const matchedLead = isMatched ? leads.find(l => l._index === assignment.leadIndex) : null;

      const outputRow = {
        ...originalSalesRows[i],
        LeadMatch: isMatched ? 'true' : 'false',
        MatchProbability: probabilityRounded.toFixed(2),
        MatchExplanation: explanationText,
        MatchedLeadIndex: isMatched ? assignment.leadIndex : '',
        MatchedLeadId: isMatched && matchedLead ? matchedLead._leadId : '',
        MatchedLeadName: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.buyer_name || matchedLead.buyer_name || '') : '',
        MatchedLeadEmail: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.buyer_email || matchedLead.buyer_email || '') : '',
        MatchedLeadPhone: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.buyer_phone_number || matchedLead.buyer_phone_number || '') : '',
        MatchedLeadBrand: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.buyer_car_brand || matchedLead.buyer_car_brand || '') : '',
        MatchedLeadModel: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.buyer_car_car_model || matchedLead.buyer_car_car_model || '') : '',
        MatchedLeadDate: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.verified_completed_or_created_at || '') : '',
        MatchedLeadVIN: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.vin_lpn || matchedLead.vin_lpn || '') : '',
        SaleOwnerName: originalSalesRows[i]['owner_name'] || originalSalesRows[i]['Owner Name'] || originalSalesRows[i]['Owner'] || '',
        SaleStandort: originalSalesRows[i]['Standort'] || '',
        MatchedLeadLocation: matchedLead ? (matchedLead._leadLocation || '') : '',
        SaleCar: originalSalesRows[i]['Typ'] || '',
        ViewedCar: matchedLead ? (matchedLead._viewBrand || '') + (matchedLead._viewModel ? ' ' + matchedLead._viewModel : '') : '',
        // Paired, explicit sale fields for ordering
        SaleBuyer: originalSalesRows[i]['Käufer'] || '',
        SaleEmail: originalSalesRows[i]['E-Mail'] || '',
        SalePhone: originalSalesRows[i]['Telefon'] || originalSalesRows[i]['Phone'] || '',
        SaleVIN: originalSalesRows[i]['Fahrgestell Nr.'] || '',
        SaleDate: originalSalesRows[i]['verkauft am'] || ''
      };

      outputWithProb.push({ row: outputRow, probability: probabilityRounded });

      if (isMatched) {
        previewRows.push({
          index: i,
          sale: {
            gwNummer: originalSalesRows[i]['GW/NW-Nummer'] || '',
            typ: sale['Typ'] || '',
            buyer: sale['Käufer'] || '',
            email: sale['E-Mail'] || '',
            vin: sale['Fahrgestell Nr.'] || '',
            date: originalSalesRows[i]['verkauft am'] || '',
            standort: sale['Standort'] || ''
          },
          lead: matchedLead ? {
            id: matchedLead._leadId || '',
            name: originalLeadRows[matchedLead._index]?.buyer_name || matchedLead.buyer_name || '',
            email: originalLeadRows[matchedLead._index]?.buyer_email || matchedLead.buyer_email || '',
            phone: originalLeadRows[matchedLead._index]?.buyer_phone_number || matchedLead.buyer_phone_number || '',
            brand: originalLeadRows[matchedLead._index]?.buyer_car_brand || matchedLead.buyer_car_brand || '',
            model: originalLeadRows[matchedLead._index]?.buyer_car_car_model || matchedLead.buyer_car_car_model || '',
            date: originalLeadRows[matchedLead._index]?.verified_completed_or_created_at || '',
            vin: originalLeadRows[matchedLead._index]?.vin_lpn || matchedLead.vin_lpn || '',
            location: matchedLead._leadLocation || '',
            viewedCar: (matchedLead._viewBrand || '') + (matchedLead._viewModel ? ' ' + matchedLead._viewModel : '')
          } : null,
          probability: probabilityRounded,
          explanation: explanationText
        });
      }
    }

    // Sort output and preview by probability desc
    outputWithProb.sort((a, b) => b.probability - a.probability);
    previewRows.sort((a, b) => b.probability - a.probability);

    const augmentedRows = outputWithProb.map(x => x.row);

    // Create CSV with paired column ordering for easy scanning
    const fields = [
      'GW/NW-Nummer',
      'SaleBuyer', 'MatchedLeadName',
      'SaleEmail', 'MatchedLeadEmail',
      'SalePhone', 'MatchedLeadPhone',
      'SaleVIN', 'MatchedLeadVIN',
      'SaleDate', 'MatchedLeadDate',
      'SaleStandort', 'MatchedLeadLocation',
      'SaleCar', 'ViewedCar',
      'LeadMatch', 'MatchProbability', 'MatchExplanation',
      'MatchedLeadId', 'MatchedLeadIndex'
    ];
    const csv = Papa.unparse({ fields, data: augmentedRows });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.hidden = false;

    // Summary
    summaryEl.innerHTML = `Matched: <strong>${matched}</strong> • Unmatched: <strong>${unmatched}</strong>`;
    summaryEl.hidden = false;

    // Preview
    renderPreview(previewRows);
  }

  function renderPreview(rows) {
    if (!rows.length) {
      preview.hidden = true;
      previewTableContainer.innerHTML = '';
      return;
    }
    const headers = [
      'Row',
      'Sale: Buyer', 'Lead: Name',
      'Sale: Email', 'Lead: Email',
      'Sale: Phone', 'Lead: Phone',
      'Sale: VIN', 'Lead: VIN',
      'Sale: Date', 'Lead: Date',
      'Sale: Standort', 'Lead: Location',
      'Sale: Typ', 'Lead: Viewed Car',
      'Probability', 'Explanation'
    ];
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    headers.forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      thr.appendChild(th);
    });
    thead.appendChild(thr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(r => {
      const tr = document.createElement('tr');
      const cells = [
        r.index,
        r.sale.buyer, r.lead?.name || '',
        r.sale.email, r.lead?.email || '',
        r.sale.phone || '', r.lead?.phone || '',
        r.sale.vin, r.lead?.vin || '',
        r.sale.date, r.lead?.date || '',
        r.sale.standort, r.lead?.location || '',
        r.sale.typ, r.lead?.viewedCar || '',
        (r.probability * 100).toFixed(0) + '%', r.explanation
      ];
      cells.forEach(c => {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    previewTableContainer.innerHTML = '';
    previewTableContainer.appendChild(table);
    preview.hidden = false;
  }

  // Wire up inputs
  leadInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    enableMatchIfReady();
    leadsPromise = parseLeadCsv(file).then(parsed => { leads = parsed; });
    await leadsPromise;
    enableMatchIfReady();
  });
  leadInput.addEventListener('input', enableMatchIfReady);

  salesInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    enableMatchIfReady();
    salesPromise = parseSalesCsv(file).then(parsed => {
      sales = parsed.normalized;
      originalSalesRows = parsed.original;
    });
    await salesPromise;
    enableMatchIfReady();
  });
  salesInput.addEventListener('input', enableMatchIfReady);

  matchBtn.addEventListener('click', async () => {
    matchBtn.disabled = true;
    try {
      if (leadsPromise) await leadsPromise;
      if (salesPromise) await salesPromise;
      await doMatch();
    } finally {
      matchBtn.disabled = false;
    }
  });

  // Ensure initial state is correct once DOM is fully loaded
  window.addEventListener('load', enableMatchIfReady);
})();


