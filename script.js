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
  const previewCardsContainer = document.getElementById('previewCardsContainer');

  let leads = [];
  let sales = [];
  let originalSalesRows = [];
  let originalLeadRows = [];
  let leadsPromise = null;
  let salesPromise = null;
  let currentColumnMapping = {};
  let salesHeaders = [];

  // Required fields configuration for column mapping
  const REQUIRED_FIELDS = {
    buyer_name: { 
      label: 'Buyer Name', 
      required: true,
      aliases: ['käufer', 'buyer', 'customer', 'name', 'kunde', 'client']
    },
    buyer_email: { 
      label: 'Email', 
      required: false,
      aliases: ['e-mail', 'email', 'mail', 'e_mail', 'email_address']
    },
    buyer_phone: { 
      label: 'Phone', 
      required: false,
      aliases: ['telefon', 'phone', 'tel', 'telephone', 'mobile', 'handy']
    },
    sale_date: { 
      label: 'Sale Date', 
      required: true,
      aliases: ['verkauft am', 'sale_date', 'date', 'sold_date', 'verkauft', 'datum']
    },
    car_type: { 
      label: 'Car Type/Model', 
      required: true,
      aliases: ['typ', 'type', 'model', 'car_type', 'vehicle_type', 'fahrzeug']
    },
    location: { 
      label: 'Location/Standort', 
      required: false,
      aliases: ['standort', 'location', 'place', 'ort', 'city', 'stadt']
    },
    stock_id: { 
      label: 'Stock ID/Car ID', 
      required: false,
      aliases: ['gw/nw-nummer', 'car_id', 'stock_id', 'vehicle_id', 'fahrzeug_id', 'auto_id', 'stock number', 'inventory_id']
    }
  };

  function enableMatchIfReady() {
    const filesChosen = (leadInput.files && leadInput.files.length > 0) && (salesInput.files && salesInput.files.length > 0);
    const dataReady = leads.length && sales.length && Object.keys(currentColumnMapping).length > 0;
    const shouldEnable = (filesChosen || dataReady);
    matchBtn.disabled = !shouldEnable;
    if (shouldEnable) {
      matchBtn.removeAttribute('disabled');
    }
  }

  // Fuzzy matching functions
  function levenshteinDistance(a, b) {
    const matrix = [];
    const aLen = a.length;
    const bLen = b.length;

    if (aLen === 0) return bLen;
    if (bLen === 0) return aLen;

    // Initialize matrix
    for (let i = 0; i <= bLen; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= aLen; j++) {
      matrix[0][j] = j;
    }

    // Fill matrix
    for (let i = 1; i <= bLen; i++) {
      for (let j = 1; j <= aLen; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[bLen][aLen];
  }

  function calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    // Exact match
    if (s1 === s2) return 1.0;
    
    // Check if one contains the other
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;
    
    // Calculate Levenshtein distance
    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    
    return maxLength === 0 ? 0 : (maxLength - distance) / maxLength;
  }

  function suggestColumnMapping(salesHeaders, targetField) {
    const fieldConfig = REQUIRED_FIELDS[targetField];
    let bestMatch = null;
    let bestScore = 0;

    for (const header of salesHeaders) {
      // Check against aliases first
      for (const alias of fieldConfig.aliases) {
        const score = calculateSimilarity(header, alias);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = header;
        }
      }
      
      // Special boost for phone keywords
      if (targetField === 'buyer_phone') {
        const phoneKeywords = ['phone', 'tel', 'telefon', 'mobile', 'handy', 'nummer', 'number'];
        const headerLower = header.toLowerCase();
        
        for (const keyword of phoneKeywords) {
          if (headerLower.includes(keyword)) {
            // Give high priority to phone-related keywords
            const keywordScore = 0.9;
            if (keywordScore > bestScore) {
              bestScore = keywordScore;
              bestMatch = header;
            }
          }
        }
      }
      
      // Also check direct similarity
      const directScore = calculateSimilarity(header, fieldConfig.label);
      if (directScore > bestScore) {
        bestScore = directScore;
        bestMatch = header;
      }
    }

    return {
      column: bestMatch,
      confidence: bestScore,
      level: bestScore >= 0.8 ? 'high' : bestScore >= 0.5 ? 'medium' : 'low'
    };
  }

  function generateCSVFingerprint(headers) {
    // Create a simple hash of the headers for localStorage key
    return headers.sort().join('|').toLowerCase();
  }

  // localStorage functions for column mapping persistence
  function saveColumnMapping(headers, mapping) {
    const fingerprint = generateCSVFingerprint(headers);
    const mappingData = {
      headers: headers,
      mapping: mapping,
      timestamp: Date.now()
    };
    localStorage.setItem(`columnMapping_${fingerprint}`, JSON.stringify(mappingData));
  }

  function loadColumnMapping(headers) {
    const fingerprint = generateCSVFingerprint(headers);
    const saved = localStorage.getItem(`columnMapping_${fingerprint}`);
    if (saved) {
      try {
        const mappingData = JSON.parse(saved);
        // Check if headers still match (in case of slight variations)
        const savedHeaders = mappingData.headers.sort().join('|').toLowerCase();
        const currentHeaders = headers.sort().join('|').toLowerCase();
        if (savedHeaders === currentHeaders) {
          return mappingData.mapping;
        }
      } catch (e) {
        console.warn('Failed to parse saved column mapping:', e);
      }
    }
    return null;
  }

  function clearAllSavedMappings() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('columnMapping_')) {
        localStorage.removeItem(key);
      }
    });
  }

  // Modal UI functions
  function showColumnMappingModal(headers) {
    salesHeaders = headers;
    const modal = document.getElementById('columnMappingModal');
    const mappingFields = document.getElementById('mappingFields');
    
    // Clear previous content
    mappingFields.innerHTML = '';
    
    // Try to load saved mapping
    const savedMapping = loadColumnMapping(headers);
    
    // Build mapping fields
    Object.entries(REQUIRED_FIELDS).forEach(([fieldKey, fieldConfig]) => {
      const suggestion = suggestColumnMapping(headers, fieldKey);
      const savedColumn = savedMapping ? savedMapping[fieldKey] : null;
      const selectedColumn = savedColumn || suggestion.column || '';
      
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'mapping-field';
      
      const label = document.createElement('div');
      label.className = `mapping-field-label ${fieldConfig.required ? 'required' : ''}`;
      label.textContent = fieldConfig.label;
      
      const controls = document.createElement('div');
      controls.className = 'mapping-field-controls';
      
      const select = document.createElement('select');
      select.setAttribute('data-field', fieldKey);
      
      // Add empty option
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = '-- Select Column --';
      select.appendChild(emptyOption);
      
      // Add "Don't match" option
      const dontMatchOption = document.createElement('option');
      dontMatchOption.value = '__DONT_MATCH__';
      dontMatchOption.textContent = '-- Don\'t match --';
      select.appendChild(dontMatchOption);
      
      // Add all available columns
      headers.forEach(header => {
        const option = document.createElement('option');
        option.value = header;
        option.textContent = header;
        if (header === selectedColumn) {
          option.selected = true;
        }
        select.appendChild(option);
      });
      
      // Add confidence indicator if there's a suggestion
      if (suggestion.column && suggestion.column === selectedColumn) {
        const indicator = document.createElement('span');
        indicator.className = `confidence-indicator ${suggestion.level}`;
        indicator.textContent = suggestion.level === 'high' ? '✓' : suggestion.level === 'medium' ? '~' : '?';
        indicator.title = `Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`;
        controls.appendChild(indicator);
      }
      
      controls.appendChild(select);
      fieldDiv.appendChild(label);
      fieldDiv.appendChild(controls);
      mappingFields.appendChild(fieldDiv);
    });
    
    if (modal) {
      modal.hidden = false;
      modal.style.display = 'flex';
    }
  }

  function hideColumnMappingModal() {
    const modal = document.getElementById('columnMappingModal');
    if (modal) {
      modal.hidden = true;
      modal.style.display = 'none';
    }
  }

  function getCurrentColumnMapping() {
    const mapping = {};
    const selects = document.querySelectorAll('#mappingFields select[data-field]');
    
    selects.forEach(select => {
      const fieldKey = select.getAttribute('data-field');
      const selectedValue = select.value;
      if (selectedValue && selectedValue !== '__DONT_MATCH__') {
        mapping[fieldKey] = selectedValue;
      }
    });
    
    return mapping;
  }

  function validateColumnMapping() {
    const mapping = getCurrentColumnMapping();
    const missingRequired = [];
    
    Object.entries(REQUIRED_FIELDS).forEach(([fieldKey, fieldConfig]) => {
      if (fieldConfig.required && !mapping[fieldKey]) {
        missingRequired.push(fieldConfig.label);
      }
    });
    
    return {
      isValid: missingRequired.length === 0,
      missingRequired: missingRequired
    };
  }

  // Utils
  function toLowerTrim(value) {
    return (value ?? '').toString().trim().toLowerCase();
  }

  function normalizePhone(raw) {
    const s = (raw ?? '').toString();
    let digits = s.replace(/\D+/g, '');
    
    // Handle German phone number formats
    if (digits.startsWith('49')) {
      // +49 or 49 prefix - remove it
      digits = digits.substring(2);
    } else if (digits.startsWith('0049')) {
      // 0049 prefix - remove it
      digits = digits.substring(4);
    }
    
    // If the number starts with 0 after removing country code, keep it
    // If it doesn't start with 0, add 0 (German local format)
    if (digits.length > 0 && !digits.startsWith('0')) {
      digits = '0' + digits;
    }
    
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
    normalized.stock_id = toLowerTrim(row.stock_id);
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

  function normalizeSalesRow(row, index, columnMapping) {
    // Sales CSV: headers are on the second line; we will already parse with header:true for line 2.
    const normalized = { ...row };
    normalized._index = index;
    
    // Use dynamic column mapping
    const buyerName = columnMapping.buyer_name ? row[columnMapping.buyer_name] : '';
    const buyerEmail = columnMapping.buyer_email ? row[columnMapping.buyer_email] : '';
    const buyerPhone = columnMapping.buyer_phone ? row[columnMapping.buyer_phone] : '';
    const saleDate = columnMapping.sale_date ? row[columnMapping.sale_date] : '';
    const carType = columnMapping.car_type ? row[columnMapping.car_type] : '';
    const location = columnMapping.location ? row[columnMapping.location] : '';
    const stockId = columnMapping.stock_id ? row[columnMapping.stock_id] : '';
    
    // Normalize the data
    normalized['Käufer'] = toLowerTrim(buyerName);
    normalized['E-Mail'] = toLowerTrim(buyerEmail);
    normalized['Telefon'] = toLowerTrim(buyerPhone);
    normalized._phoneNorm = normalizePhone(buyerPhone);
    normalized['Typ'] = toLowerTrim(carType);
    normalized['Standort'] = toLowerTrim(location);
    normalized._standortNorm = normalizeLocation(location);
    normalized['verkauft am_obj'] = parseDateDMDots(saleDate);
    normalized['GW/NW-Nummer'] = toLowerTrim(stockId);
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

    // Stock ID match (lead stock_id vs sale GW/NW-Nummer)
    const leadStockId = le.stock_id;
    const saleStockId = sa['GW/NW-Nummer'];
    if (leadStockId && saleStockId) {
      // Exact match
      if (leadStockId === saleStockId) {
        score += 30;
        nonDateSignalScore += 30;
        explanation.push('Stock ID exact match');
      }
      // Partial match - lead starts with sale ID (e.g., "55708841_65941" starts with "55708841")
      else if (leadStockId.startsWith(saleStockId + '_') || leadStockId.startsWith(saleStockId + '-')) {
        score += 25;
        nonDateSignalScore += 25;
        explanation.push('Stock ID partial match (lead extends sale ID)');
      }
      // Reverse partial match - sale starts with lead ID
      else if (saleStockId.startsWith(leadStockId + '_') || saleStockId.startsWith(leadStockId + '-')) {
        score += 25;
        nonDateSignalScore += 25;
        explanation.push('Stock ID partial match (sale extends lead ID)');
      }
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
      // First, let's read the file as text to inspect the structure
      const reader = new FileReader();
      reader.onload = function(e) {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        
        console.log('Raw CSV content (first 3 lines):');
        console.log('Line 1:', lines[0]);
        console.log('Line 2:', lines[1]);
        console.log('Line 3:', lines[2]);
        
        // Try to determine which line contains headers
        let headerLineIndex = 0;
        
        // Check if first line looks like a title/description
        if (lines.length > 1) {
          const firstLine = lines[0].toLowerCase();
          const commaCount = (lines[0].match(/,/g) || []).length;
          
          // More sophisticated detection:
          // - If it has many commas (like headers), it's probably headers
          // - If it has few commas AND looks like a title, it's probably a title
          // - German words like "verkauft" can be in headers, so be more careful
          const looksLikeTitle = /^sales|^data|^verkauf|^report|^export|^title|^header/.test(firstLine) && commaCount < 3;
          const hasFewCommas = commaCount < 3;
          
          // Only treat as title if it's clearly a title AND has few commas
          if (looksLikeTitle && hasFewCommas) {
            headerLineIndex = 1;
            console.log('Detected title line, using line 2 as headers');
          } else {
            console.log('First line appears to be headers (has', commaCount, 'commas)');
          }
        }
        
        // Extract headers from the determined line
        let headerLine = lines[headerLineIndex] || '';
        let headers = headerLine.split(',').map(h => h.trim().replace(/"/g, ''));
        
        console.log('Extracted headers:', headers);
        console.log('Header line index:', headerLineIndex);
        
        // Skip the automatic data detection for now - trust the initial header detection
        console.log('Using headers as detected:', headers);
        
        // Now parse with Papa Parse, skipping the title line if needed
        const csvToParse = headerLineIndex > 0 ? lines.slice(headerLineIndex + 1).join('\n') : text;
        
        Papa.parse(csvToParse, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const rows = res.data || [];
            console.log('Papa Parse headers:', res.meta.fields);
            console.log('First parsed row:', rows[0]);
            
            // Use our manually extracted headers if Papa Parse headers look wrong
            const finalHeaders = res.meta.fields && res.meta.fields.length > 0 ? res.meta.fields : headers;
            
            // Keep the original row to unparse later (preserving unknown columns)
            originalSalesRows = rows.map(r => ({ ...r }));
            
            // Show column mapping modal
            showColumnMappingModal(finalHeaders);
            
            resolve({ headers: finalHeaders, rows, original: originalSalesRows });
          },
          error: reject
        });
      };
      
      reader.readAsText(file);
    });
  }

  async function doMatch() {
    const threshold = 0.30;

    // Normalize sales data using current column mapping
    const normalizedSales = originalSalesRows.map((r, i) => normalizeSalesRow(r, i, currentColumnMapping));
    sales = normalizedSales;

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
        MatchedLeadStockId: isMatched && matchedLead ? (originalLeadRows[matchedLead._index]?.stock_id || matchedLead.stock_id || '') : '',
        SaleStockId: originalSalesRows[i][currentColumnMapping.stock_id] || '',
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
            stockId: originalSalesRows[i][currentColumnMapping.stock_id] || '',
            gwNummer: originalSalesRows[i]['GW/NW-Nummer'] || '',
            typ: sale['Typ'] || '',
            buyer: sale['Käufer'] || '',
            email: sale['E-Mail'] || '',
            phone: sale['Telefon'] || '',
            date: originalSalesRows[i]['verkauft am'] || '',
            standort: sale['Standort'] || ''
          },
          lead: matchedLead ? {
            id: matchedLead._leadId || '',
            stockId: originalLeadRows[matchedLead._index]?.stock_id || matchedLead.stock_id || '',
            name: originalLeadRows[matchedLead._index]?.buyer_name || matchedLead.buyer_name || '',
            email: originalLeadRows[matchedLead._index]?.buyer_email || matchedLead.buyer_email || '',
            phone: originalLeadRows[matchedLead._index]?.buyer_phone_number || matchedLead.buyer_phone_number || '',
            brand: originalLeadRows[matchedLead._index]?.buyer_car_brand || matchedLead.buyer_car_brand || '',
            model: originalLeadRows[matchedLead._index]?.buyer_car_car_model || matchedLead.buyer_car_car_model || '',
            date: originalLeadRows[matchedLead._index]?.verified_completed_or_created_at || '',
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
      'SaleStockId', 'MatchedLeadStockId',
      'SaleBuyer', 'MatchedLeadName',
      'SaleEmail', 'MatchedLeadEmail',
      'SalePhone', 'MatchedLeadPhone',
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

    // Render stats (histogram + bucket table)
    renderStats(outputWithProb);
    
    // Render conversion analysis
    renderConversionAnalysis(outputWithProb);
    
    // Store results for threshold updates
    window.lastMatchResults = outputWithProb;
  }

  function renderPreview(rows) {
    const previewCardsContainer = document.getElementById('previewCardsContainer');
    
    if (!rows.length) {
      preview.hidden = true;
      previewCardsContainer.innerHTML = '';
      return;
    }

    previewCardsContainer.innerHTML = '';
    
    rows.forEach((r, index) => {
      const card = document.createElement('div');
      card.className = 'preview-card';
      
      // Helper function to check if values match (more sophisticated matching)
      const isMatch = (saleValue, leadValue, fieldType = 'text') => {
        if (!saleValue || !leadValue) return false;
        
        const sale = saleValue.toLowerCase().trim();
        const lead = leadValue.toLowerCase().trim();
        
        // Exact match
        if (sale === lead) return { type: 'exact', score: 100 };
        
        // For phone numbers - check if they're similar after normalization
        if (fieldType === 'phone') {
          const salePhone = normalizePhone(saleValue);
          const leadPhone = normalizePhone(leadValue);
          if (salePhone === leadPhone) return { type: 'exact', score: 100 };
          // Check if one contains the other (partial match)
          if (salePhone.includes(leadPhone) || leadPhone.includes(salePhone)) {
            return { type: 'partial', score: 80 };
          }
        }
        
        // For stock IDs - check partial matches
        if (fieldType === 'stock') {
          if (sale.startsWith(lead) || lead.startsWith(sale)) {
            return { type: 'partial', score: 90 };
          }
        }
        
        // For names - check if one contains the other
        if (fieldType === 'name') {
          const saleWords = sale.split(/\s+/);
          const leadWords = lead.split(/\s+/);
          const commonWords = saleWords.filter(word => leadWords.includes(word));
          if (commonWords.length >= Math.min(saleWords.length, leadWords.length) * 0.7) {
            return { type: 'partial', score: 85 };
          }
        }
        
        // For locations - check if one contains the other
        if (fieldType === 'location') {
          if (sale.includes(lead) || lead.includes(sale)) {
            return { type: 'partial', score: 80 };
          }
        }
        
        // For car types - check if one contains the other
        if (fieldType === 'car') {
          if (sale.includes(lead) || lead.includes(sale)) {
            return { type: 'partial', score: 80 };
          }
        }
        
        return { type: 'none', score: 0 };
      };
      
      // Helper function to create match indicator
      const createMatchIndicator = (saleValue, leadValue, fieldType = 'text') => {
        const match = isMatch(saleValue, leadValue, fieldType);
        return {
          isMatch: match.score > 0,
          text: match.score > 0 ? `${match.score}% match` : 'No match',
          className: match.score > 0 ? 'exact' : ''
        };
      };
      
      // All field comparisons
      const stockMatch = createMatchIndicator(r.sale.stockId, r.lead?.stockId || '', 'stock');
      const nameMatch = createMatchIndicator(r.sale.buyer, r.lead?.name || '', 'name');
      const emailMatch = createMatchIndicator(r.sale.email, r.lead?.email || '', 'text');
      const phoneMatch = createMatchIndicator(r.sale.phone || '', r.lead?.phone || '', 'phone');
      const dateMatch = createMatchIndicator(r.sale.date, r.lead?.date || '', 'text');
      const locationMatch = createMatchIndicator(r.sale.standort, r.lead?.location || '', 'location');
      const carMatch = createMatchIndicator(r.sale.typ, r.lead?.viewedCar || '', 'car');
      
      card.innerHTML = `
        <div class="preview-card-header">
          <div class="preview-card-title">Match #${r.index}</div>
          <div class="preview-card-probability">${(r.probability * 100).toFixed(0)}%</div>
        </div>
        
        <div class="preview-comparison">
          <div class="preview-field">
            <div class="preview-field-label">Stock ID</div>
            <div class="preview-field-value">${r.sale.stockId}</div>
            <div class="preview-field-match ${stockMatch.className}">
              <svg class="preview-field-match-icon ${stockMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.stockId || 'N/A'}) ${stockMatch.text}
            </div>
          </div>
          
          <div class="preview-field">
            <div class="preview-field-label">Name</div>
            <div class="preview-field-value">${r.sale.buyer}</div>
            <div class="preview-field-match ${nameMatch.className}">
              <svg class="preview-field-match-icon ${nameMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.name || 'N/A'}) ${nameMatch.text}
            </div>
          </div>
          
          <div class="preview-field">
            <div class="preview-field-label">Email</div>
            <div class="preview-field-value">${r.sale.email}</div>
            <div class="preview-field-match ${emailMatch.className}">
              <svg class="preview-field-match-icon ${emailMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.email || 'N/A'}) ${emailMatch.text}
            </div>
          </div>
          
          <div class="preview-field">
            <div class="preview-field-label">Phone</div>
            <div class="preview-field-value">${r.sale.phone || 'N/A'}</div>
            <div class="preview-field-match ${phoneMatch.className}">
              <svg class="preview-field-match-icon ${phoneMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.phone || 'N/A'}) ${phoneMatch.text}
            </div>
          </div>
          
          <div class="preview-field">
            <div class="preview-field-label">Date</div>
            <div class="preview-field-value">${r.sale.date}</div>
            <div class="preview-field-match ${dateMatch.className}">
              <svg class="preview-field-match-icon ${dateMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.date || 'N/A'}) ${dateMatch.text}
            </div>
          </div>
          
          <div class="preview-field">
            <div class="preview-field-label">Location</div>
            <div class="preview-field-value">${r.sale.standort}</div>
            <div class="preview-field-match ${locationMatch.className}">
              <svg class="preview-field-match-icon ${locationMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.location || 'N/A'}) ${locationMatch.text}
            </div>
          </div>
          
          <div class="preview-field">
            <div class="preview-field-label">Car Type</div>
            <div class="preview-field-value">${r.sale.typ}</div>
            <div class="preview-field-match ${carMatch.className}">
              <svg class="preview-field-match-icon ${carMatch.className}" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
              </svg>
              (${r.lead?.viewedCar || 'N/A'}) ${carMatch.text}
            </div>
          </div>
        </div>
      `;
      
      previewCardsContainer.appendChild(card);
    });
    
    preview.hidden = false;
  }

  function renderConversionAnalysis(outputWithProb) {
    const conversionAnalysisEl = document.getElementById('conversionAnalysis');
    const conversionStatsEl = document.getElementById('conversionStats');
    
    if (!outputWithProb.length) {
      conversionAnalysisEl.hidden = true;
      return;
    }
    
    // Get threshold from input (convert percentage to decimal)
    const thresholdPercent = parseFloat(document.getElementById('thresholdInput').value) || 90;
    const threshold = thresholdPercent / 100;
    
    // Calculate conversion metrics
    const totalSales = outputWithProb.length;
    const totalLeads = originalLeadRows.length;
    
    // Count sales that came from leads (with threshold probability)
    const salesFromLeads = outputWithProb.filter(row => row.probability >= threshold).length;
    
    // Count leads that converted to sales (with threshold probability)
    const leadsConverted = outputWithProb.filter(row => row.probability >= threshold).length;
    
    // Calculate percentages
    const salesConversionRate = totalSales > 0 ? (salesFromLeads / totalSales * 100) : 0;
    const leadConversionRate = totalLeads > 0 ? (leadsConverted / totalLeads * 100) : 0;
    
    // Render conversion stats
    conversionStatsEl.innerHTML = `
      <div class="conversion-stat">
        <div class="conversion-stat-icon sales">${salesFromLeads}</div>
        <div class="conversion-stat-content">
          <div class="conversion-stat-title">${salesConversionRate.toFixed(1)}% of your sales came from AutoUncle leads</div>
          <div class="conversion-stat-description">${salesFromLeads} out of ${totalSales} sales matched with ≥${thresholdPercent}% probability</div>
        </div>
      </div>
      
      <div class="conversion-stat">
        <div class="conversion-stat-icon leads">${leadsConverted}</div>
        <div class="conversion-stat-content">
          <div class="conversion-stat-title">${leadConversionRate.toFixed(1)}% of your AutoUncle leads converted to sales</div>
          <div class="conversion-stat-description">${leadsConverted} out of ${totalLeads} leads matched with ≥${thresholdPercent}% probability</div>
        </div>
      </div>
    `;
    
    conversionAnalysisEl.hidden = false;
  }

  function renderStats(outputWithProb) {
    const statsEl = document.getElementById('stats');
    const histogramEl = document.getElementById('histogram');
    const tableContainer = document.getElementById('bucketTableContainer');
    if (!statsEl || !histogramEl || !tableContainer) return;

    // Build buckets
    const buckets = [
      { label: '100%', min: 1.0, max: 1.0, count: 0 },
      { label: '99-90%', min: 0.90, max: 0.99, count: 0 },
      { label: '89-80%', min: 0.80, max: 0.89, count: 0 },
      { label: '79-70%', min: 0.70, max: 0.79, count: 0 },
      { label: '69-60%', min: 0.60, max: 0.69, count: 0 },
      { label: '59-50%', min: 0.50, max: 0.59, count: 0 },
      { label: '49-40%', min: 0.40, max: 0.49, count: 0 },
      { label: '39-30%', min: 0.30, max: 0.39, count: 0 },
      { label: '29-20%', min: 0.20, max: 0.29, count: 0 },
      { label: '< 20%', min: 0.00, max: 0.19, count: 0 }
    ];

    // Count probabilities
    outputWithProb.forEach(item => {
      const p = item.probability;
      for (const b of buckets) {
        if (p >= b.min && p <= b.max) { b.count++; break; }
      }
    });

    // Render histogram bars (10 bars)
    histogramEl.innerHTML = '';
    const maxCount = Math.max(...buckets.map(b => b.count), 1);
    buckets.forEach(b => {
      const bar = document.createElement('div');
      bar.className = 'hist-bar';
      const heightPct = Math.round((b.count / maxCount) * 100);
      bar.style.height = Math.max(4, heightPct) + '%';
      bar.setAttribute('data-label', b.label);
      bar.title = `${b.label}: ${b.count}`;
      histogramEl.appendChild(bar);
    });

    // Render table
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    ['Range', 'Count'].forEach(h => {
      const th = document.createElement('th'); th.textContent = h; thr.appendChild(th);
    });
    thead.appendChild(thr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    buckets.forEach(b => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = b.label; tr.appendChild(td1);
      const td2 = document.createElement('td'); td2.textContent = String(b.count); tr.appendChild(td2);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableContainer.innerHTML = '';
    tableContainer.appendChild(table);
    statsEl.hidden = false;
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
      originalSalesRows = parsed.original;
      // Don't normalize yet - wait for column mapping
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

  // Threshold input listener
  document.getElementById('thresholdInput').addEventListener('input', function() {
    if (window.lastMatchResults) {
      renderConversionAnalysis(window.lastMatchResults);
    }
  });

  // Modal event handlers - attach after DOM is loaded
  function attachModalEventHandlers() {
    const closeBtn = document.getElementById('closeModal');
    const modal = document.getElementById('columnMappingModal');
    const confirmBtn = document.getElementById('confirmMapping');
    const saveBtn = document.getElementById('saveMappingTemplate');
    const clearBtn = document.getElementById('clearSavedMappings');
    
    if (closeBtn) {
      closeBtn.addEventListener('click', hideColumnMappingModal);
    }
    
    if (modal) {
      // Close modal when clicking outside of it
      modal.addEventListener('click', (e) => {
        if (e.target.id === 'columnMappingModal') {
          hideColumnMappingModal();
        }
      });
    }
    
    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('columnMappingModal');
        if (modal && !modal.hidden) {
          hideColumnMappingModal();
        }
      }
    });
    
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        const validation = validateColumnMapping();
        if (!validation.isValid) {
          alert(`Please map the required fields: ${validation.missingRequired.join(', ')}`);
          return;
        }
        
        currentColumnMapping = getCurrentColumnMapping();
        hideColumnMappingModal();
        enableMatchIfReady();
      });
    }
    
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const mapping = getCurrentColumnMapping();
        if (Object.keys(mapping).length === 0) {
          alert('Please map at least one field before saving.');
          return;
        }
        
        saveColumnMapping(salesHeaders, mapping);
        alert('Mapping template saved! It will be automatically loaded for similar CSV files.');
      });
    }
    
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all saved column mappings?')) {
          clearAllSavedMappings();
          alert('All saved mappings have been cleared.');
        }
      });
    }
  }

  // Ensure initial state is correct once DOM is fully loaded
  window.addEventListener('load', () => {
    enableMatchIfReady();
    attachModalEventHandlers();
    // Ensure modal is hidden on page load
    hideColumnMappingModal();
  });
})();


