const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const COOKIE_FILE = path.join(__dirname, '.chrono_cookie');
const PLAYWRIGHT_PROFILE_DIR = path.join(__dirname, '.chrono_profile');

function loadCookieString() {
  if (fs.existsSync(COOKIE_FILE)) {
    return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  }
  return process.env.CHRONO_COOKIE ? process.env.CHRONO_COOKIE.trim() : '';
}

function saveCookieString(cookieString) {
  const normalized = cookieString.trim();
  fs.writeFileSync(COOKIE_FILE, normalized, 'utf8');
  return normalized;
}

let chronoCookie = loadCookieString();

// Example mapping of employee names -> ID numbers (edit to your real IDs)
const employeeIds = {
  "Fortunato": 902497,
  "Glocell": 140980,
  "Ashton Mark": 2015730,
  "Ramil Miguel": 2015678,
  "John Derick": 133421,
  "Michael Angelo": 2014423,
  "Gian Jee": 2013007,
  "Lloyd Bryan": 141434,
  "Diosecoro": 145105,
  "Candelaria": 2013038,
};

// ChronoTrack search page base URL
const CHRONO_SEARCH_URL = 'http://lighthouse2.maxim-ic.com/chrono/?q=full/chrotrack/search/logs/mpoc/index';

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

app.get('/cookie', (req, res) => {
  res.json({ hasCookie: !!chronoCookie, cookieSource: fs.existsSync(COOKIE_FILE) ? 'file' : 'env' });
});

app.post('/cookie', (req, res) => {
  const { cookie } = req.body;
  if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
    return res.status(400).json({ error: 'cookie is required in request body' });
  }
  chronoCookie = saveCookieString(cookie);
  return res.json({ saved: true, hasCookie: true });
});

app.get('/employees', (req, res) => {
  res.json(employeeIds);
});

app.get('/auth-status', (req, res) => {
  res.json({
    hasProfile: hasPersistentProfile(),
    hasCookie: !!chronoCookie,
    authSource: hasPersistentProfile() ? 'profile' : chronoCookie ? 'cookie' : null,
  });
});

app.post('/login', async (req, res) => {
  try {
    const context = await chromium.launchPersistentContext(PLAYWRIGHT_PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });
    const page = await context.newPage();
    await page.goto(CHRONO_SEARCH_URL, { waitUntil: 'networkidle' });
    res.json({ started: true, message: 'Browser opened. Please log in and close the browser when finished.' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Debug endpoint: return browser page state and scraped rows for troubleshooting
app.get('/debug-check', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });

  try {
    const result = await debugCheckEmployee(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Endpoint to check if an employee ID appears in ChronoTrack results
app.get('/check', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });

  try {
    const result = await checkEmployee(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/find-id', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'missing name' });

  try {
    const result = await findEmployeeIdByName(name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Basic check function: tries a browser-based scrape of ChronoTrack using Playwright.
// Note: ChronoTrack requires authentication. Set CHRONO_COOKIE env var with a valid session cookie
// (e.g. "SESS...=...; other=...") so the server can access protected results.
async function setSearchOption(page, selectors, value) {
  for (const selector of selectors) {
    const element = await page.$(selector).catch(() => null);
    if (!element) continue;
    const options = await element.$$eval('option', opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() })));
    const match = options.find(opt => opt.value.toUpperCase() === value.toUpperCase() || opt.text.toUpperCase() === value.toUpperCase());
    if (match) {
      await element.selectOption(match.value).catch(() => null);
      return true;
    }
  }
  return false;
}

function hasPersistentProfile() {
  return fs.existsSync(PLAYWRIGHT_PROFILE_DIR);
}

async function createChronoContext({ headless = true } = {}) {
  if (hasPersistentProfile()) {
    const context = await chromium.launchPersistentContext(PLAYWRIGHT_PROFILE_DIR, {
      headless,
      viewport: null,
      args: ['--start-maximized'],
    });
    return { context, source: 'profile' };
  }

  const cookieString = chronoCookie;
  if (!cookieString) {
    return { context: null, source: null };
  }

  const cookies = cookieString.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return {
      name,
      value: rest.join('='),
      domain: 'lighthouse2.maxim-ic.com',
      path: '/',
      httpOnly: false,
      secure: false,
    };
  });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  return { browser, context, source: 'cookie' };
}

async function checkEmployee(id) {
  const { browser, context, source } = await createChronoContext({ headless: true });
  if (!context) {
    return { found: false, method: 'playwright', note: 'No auth available. Use the login flow or set CHRONO_COOKIE.' };
  }
  const page = await context.newPage();

  const today = new Date().toISOString().slice(0, 10);
  await page.goto(CHRONO_SEARCH_URL, { waitUntil: 'networkidle' });

  await page.fill('input[name="frdate"]', today).catch(() => null);
  await page.fill('input[name="todate"]', today).catch(() => null);

  await setSearchOption(page, ['select[name="transType"]', 'select[name="Trans Type"]', 'select[name="trans_type"]', 'select[name="type"]'], 'TIME INOUT');

  const searchButton = await page.$('button:has-text("Search"), input[type="submit"], button[type="submit"]');
  if (searchButton) {
    await Promise.all([
      page.waitForLoadState('networkidle'),
      searchButton.click(),
    ]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
  }

  const tableResult = await parseResultTable(page);
  if (browser) {
    await browser.close();
  } else {
    await context.close();
  }

  const idHeader = tableResult.headers.find(h => h.toLowerCase().includes('id'));
  const matchedRows = tableResult.rows.filter(row => {
    if (idHeader) {
      return (row.row[idHeader] || '').trim() === String(id);
    }
    return Object.values(row.row).some(value => value === String(id));
  });

  if (!matchedRows.length) {
    return { found: false, method: 'playwright', note: 'No rows matched the requested employee ID', rows: tableResult.rows };
  }

  const found = matchedRows.some(row => Object.values(row.row).some(value => /logged in|log in/i.test(value) && value.toLowerCase() !== 'no'));
  return {
    found,
    method: 'playwright',
    rowCount: matchedRows.length,
    rows: matchedRows,
    note: found ? undefined : 'Matching row(s) found but no Log IN value was present',
  };
}

async function parseResultTable(page) {
  return await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const pick = tables.find(table => {
      const headerText = Array.from(table.querySelectorAll('th')).map(th => th.innerText.toLowerCase()).join(' ');
      return headerText.includes('id number') || headerText.includes('log in') || headerText.includes('trans type');
    }) || tables[0];

    if (!pick) return { headers: [], rows: [] };

    const headerEls = Array.from(pick.querySelectorAll('th'));
    const headers = headerEls.length
      ? headerEls.map(th => th.innerText.trim())
      : Array.from(pick.querySelectorAll('tr:first-child td')).map(td => td.innerText.trim());

    const rows = Array.from(pick.querySelectorAll('tr')).slice(1).map(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
      const row = {};
      headers.forEach((header, index) => {
        row[header || `col${index + 1}`] = cells[index] || '';
      });
      return { cells, row };
    });

    return { headers, rows };
  });
}

async function findEmployeeIdByName(name) {
  const { browser, context } = await createChronoContext({ headless: true });
  if (!context) {
    return { id: null, note: 'No auth available. Use login flow or set CHRONO_COOKIE.' };
  }

  const page = await context.newPage();
  const today = new Date().toISOString().slice(0, 10);
  await page.goto(CHRONO_SEARCH_URL, { waitUntil: 'networkidle' });

  await page.fill('input[name="frdate"]', today).catch(() => null);
  await page.fill('input[name="todate"]', today).catch(() => null);
  await setSearchOption(page, ['select[name="transType"]', 'select[name="Trans Type"]', 'select[name="trans_type"]', 'select[name="type"]'], 'TIME INOUT');

  const searchButton = await page.$('button:has-text("Search"), input[type="submit"], button[type="submit"]');
  if (searchButton) {
    await Promise.all([
      page.waitForLoadState('networkidle'),
      searchButton.click(),
    ]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
  }

  const tableResult = await parseResultTable(page);
  if (browser) {
    await browser.close();
  } else {
    await context.close();
  }

  const normalizedName = String(name || '').trim().toLowerCase();
  const matched = tableResult.rows.filter(row =>
    Object.values(row.row).some(value => String(value || '').trim().toLowerCase().includes(normalizedName))
  );

  if (!matched.length) {
    return { id: null, note: `No table row matched name '${name}'`, rows: tableResult.rows };
  }

  const idHeader = tableResult.headers.find(h => h.toLowerCase().includes('id'));
  let foundId = null;
  if (idHeader) {
    foundId = String(matched[0].row[idHeader] || '').trim();
  }
  if (!foundId) {
    for (const cell of Object.values(matched[0].row)) {
      const candidate = String(cell || '').trim();
      if (/^\d+$/.test(candidate)) {
        foundId = candidate;
        break;
      }
    }
  }

  return {
    id: foundId || null,
    name,
    note: foundId ? undefined : 'Row matched by name but no ID could be extracted',
    row: matched[0],
    rows: matched,
  };
}

async function debugCheckEmployee(id) {
  const { browser, context, source } = await createChronoContext({ headless: true });
  if (!context) {
    return { found: false, method: 'debug-playwright', note: 'No auth available. Use the login flow or set CHRONO_COOKIE.', cookieSet: false, loginSuccess: false };
  }
  const page = await context.newPage();

  const today = new Date().toISOString().slice(0, 10);
  const response = await page.goto(CHRONO_SEARCH_URL, { waitUntil: 'networkidle' });
  const initialPageUrl = page.url();
  const initialPageTitle = await page.title();
  const initialHtml = await page.content();

  await page.fill('input[name="frdate"]', today).catch(() => null);
  await page.fill('input[name="todate"]', today).catch(() => null);

  await setSearchOption(page, ['select[name="transType"]', 'select[name="Trans Type"]', 'select[name="trans_type"]', 'select[name="type"]'], 'TIME INOUT');

  const loginFailure = /access denied|authorization required|login/i.test(initialPageTitle + ' ' + initialHtml);
  const cookieLoginSuccess = !loginFailure;

  const idFieldExists = await page.$('input[name="idnum"]') !== null;
  const idFieldValueBefore = idFieldExists ? await page.$eval('input[name="idnum"]', el => el.value || '') : null;
  const idFieldType = idFieldExists ? await page.$eval('input[name="idnum"]', el => el.type || 'text') : null;

  const formFields = await page.$$eval('form input[name], form select[name], form textarea[name]', els =>
    els.map(el => ({ name: el.name, type: el.type || el.tagName.toLowerCase(), value: el.value || '' }))
  );

  if (idFieldExists) {
    await page.fill('input[name="idnum"]', String(id));
  }
  await page.fill('input[name="frdate"]', today).catch(() => null);
  await page.fill('input[name="todate"]', today).catch(() => null);

  const idFieldValueAfter = idFieldExists ? await page.$eval('input[name="idnum"]', el => el.value || '') : null;
  const frdateValue = await page.$eval('input[name="frdate"]', el => el.value || '').catch(() => null);
  const todateValue = await page.$eval('input[name="todate"]', el => el.value || '').catch(() => null);

  const searchButton = await page.$('button:has-text("Search"), input[type="submit"], button[type="submit"]');
  let clickResult = 'none';
  if (searchButton) {
    await Promise.all([
      page.waitForLoadState('networkidle'),
      searchButton.click(),
    ]);
    clickResult = 'clicked';
  } else {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
    clickResult = 'enter-pressed';
  }

  const finalPageUrl = page.url();
  const finalPageTitle = await page.title();
  const finalHtml = await page.content();
  // const screenshotPath = path.resolve(__dirname, `debug-${id}-${Date.now()}.png`);
  console.log(`DEBUG: page loaded for id=${id}, url=${finalPageUrl}`);
  console.log(`DEBUG: loginSuccess=${cookieLoginSuccess}, idFieldExists=${idFieldExists}, searchButtonFound=${!!searchButton}`);
  // await page.screenshot({ path: screenshotPath, fullPage: true }).catch((err) => {
  //   console.log('DEBUG: screenshot failed', err.message);
  // });

  const tableResult = await parseResultTable(page);

  if (browser) {
    await browser.close();
  } else {
    await context.close();
  }
  const rows = tableResult.rows;
  const headers = tableResult.headers;
  const idHeader = headers.find(h => h.toLowerCase().includes('id'));
  const matched = rows.filter(row => {
    if (idHeader) {
      return (row.row[idHeader] || '').trim() === String(id);
    }
    return Object.values(row.row).some(value => value === String(id));
  });
  const loggedInMatch = matched.some(r => Object.values(r.row).some(value => /logged in|log in/i.test(value) && value.toLowerCase() !== 'no'));

  return {
    method: 'debug-playwright',
    id,
    cookieSet: true,
    authSource: source,
    loginSuccess: cookieLoginSuccess,
    loginFailure,
    initialPageUrl,
    initialPageTitle,
    finalPageUrl,
    finalPageTitle,
    // screenshotPath,
    idFieldExists,
    idFieldType,
    idFieldValueBefore,
    idFieldValueAfter,
    frdateValue,
    todateValue,
    formFields,
    searchButtonFound: !!searchButton,
    searchButtonAction: clickResult,
    headers,
    tableFound: rows.length > 0,
    rowCount: rows.length,
    matchedCount: matched.length,
    matchedRows: matched,
    found: loggedInMatch,
    note: loggedInMatch ? undefined : 'Use matchedRows and loginSuccess to diagnose the result',
    htmlSnippet: finalHtml.slice(0, 2000),
  };
}

function parseChronoTrackTable(html, id, date) {
  const $ = cheerio.load(html);
  const normalizedId = String(id).trim();
  let targetTable = null;

  $('table').each((i, table) => {
    const headers = $(table).find('th').map((j, th) => $(th).text().trim().toLowerCase()).get();
    if (headers.some(h => h.includes('id number')) && headers.some(h => h.includes('log in'))) {
      targetTable = table;
      return false;
    }
    const firstRowText = $(table).find('tr').first().text().toLowerCase();
    if (firstRowText.includes('id number') && firstRowText.includes('log in')) {
      targetTable = table;
      return false;
    }
  });

  if (!targetTable) return null;

  const headerCells = $(targetTable).find('th');
  const headers = headerCells.length
    ? headerCells.map((i, th) => $(th).text().trim().toLowerCase()).get()
    : $(targetTable).find('tr').first().find('td').map((i, td) => $(td).text().trim().toLowerCase()).get();

  const indexOf = (name) => {
    const normalized = name.toLowerCase();
    return headers.findIndex(h => h.includes(normalized));
  };

  const idIndex = indexOf('id number');
  const dateIndex = indexOf('trans date');
  const logInIndex = indexOf('log in');

  if (idIndex === -1 || logInIndex === -1) return null;

  const rows = [];
  $(targetTable).find('tr').slice(1).each((i, tr) => {
    const cells = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
    if (!cells.length) return;

    const rowId = cells[idIndex] || '';
    if (rowId.trim() !== normalizedId) return;

    const transDate = (cells[dateIndex] || '').trim();
    const logIn = (cells[logInIndex] || '').trim();
    rows.push({ rowId, transDate, logIn, cells });
  });

  if (!rows.length) return { found: false, method: 'parsed table', note: 'No rows matched the requested employee ID' };

  const rowsForDate = rows.filter(r => !date || normalizeChronoDate(r.transDate) === normalizeChronoDate(date));
  const matchedRows = rowsForDate.length ? rowsForDate : rows;

  const successful = matchedRows.some(r => r.logIn && r.logIn.toLowerCase() !== 'no');
  return {
    found: successful,
    method: 'parsed table',
    date: date,
    rowCount: matchedRows.length,
    rows: matchedRows.map(r => ({ transDate: r.transDate, logIn: r.logIn, cells: r.cells })),
    note: successful ? undefined : 'Matching row(s) found but no Log IN value was present',
  };
}

function normalizeChronoDate(value) {
  if (!value) return '';
  const iso = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const m = iso.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy.padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return iso;
}

function summarize(html, id) {
  const idx = html.indexOf(String(id));
  if (idx === -1) return '';
  const start = Math.max(0, idx - 80);
  const end = Math.min(html.length, idx + 80);
  return html.slice(start, end).replace(/\s+/g, ' ').trim();
}

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
