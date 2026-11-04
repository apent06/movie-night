const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert/strict');

(async () => {
  const project = path.resolve(__dirname, '..');
  const url = pathToFileURL(path.join(project, 'web/index.html')).href;
  const golden = JSON.parse(fs.readFileSync(path.join(project, 'results/browser_parity.json'), 'utf8'));
  const browser = await chromium.launch({ headless:true,
    ...(process.env.MOVIE_NIGHT_BROWSER ? {executablePath:process.env.MOVIE_NIGHT_BROWSER} : {}) });
  const errors = [];
  const captureDir = process.env.MOVIE_NIGHT_SCREENSHOTS;
  if (captureDir) fs.mkdirSync(captureDir, {recursive:true});
  async function open(context) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(url);
    await page.waitForFunction(() => !!window.MovieNight);
    return page;
  }
  async function screenshot(page, name) {
    if (captureDir) {
      await page.evaluate(() => document.activeElement?.blur());
      await page.screenshot({path:path.join(captureDir, name+'.png'), fullPage:true});
    }
  }
  async function noOverflow(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow');
  }
  async function addFromCatalog(page, query, id) {
    await page.locator('#watched-add-search').fill(query);
    await page.locator(`#watched-add-results [data-search-pick="${id}"]`).click();
  }
  async function manual(page, title, year, rating='0', genre='') {
    await page.locator('#manual-add').click();
    await page.locator('#manual-title').fill(title);
    await page.locator('#manual-year').fill(year);
    await page.locator('#manual-rating').selectOption(rating);
    await page.locator('#manual-genre').selectOption(genre);
    await page.locator('#manual-form button[type=submit]').click();
  }
  try {
    const context = await browser.newContext({viewport:{width:1280,height:950}, acceptDownloads:true});
    const page = await open(context);
    for (const [name, profile] of Object.entries(golden)) {
      const actual = await page.evaluate(profile => MovieNight.rank(new Map(profile.ratings.map(row => [row.id,row.rating])), '', 10).map(row => row.id), profile);
      assert.deepEqual(actual, profile.top10, `${name}: browser/Python mismatch`);
    }
    assert.equal(await page.locator('#watched-nav-count').textContent(), '0');
    await page.locator('[data-example="0"]').click();
    assert.equal(await page.locator('#genre').inputValue(), 'Sci-Fi');
    assert.equal(await page.locator('[data-recommendation]').count(), 5);
    assert.equal(await page.evaluate(() => MovieNight.getState().watched.length), 0, 'Samples must not become watched history');
    assert(await page.evaluate(() => [...document.querySelectorAll('[data-recommendation]')].every(row => {
      const movie = MovieNight.data.movies.find(movie => movie.id === Number(row.dataset.recommendation));
      return movie.genres.includes('Sci-Fi') && !MovieNight.getState().ratings.some(([id]) => id === movie.id);
    })));
    await noOverflow(page);
    await screenshot(page, 'finder-desktop');

    const first = await page.locator('[data-recommendation]').first().getAttribute('data-recommendation');
    await page.locator(`[data-seen="${first}"]`).click();
    assert.equal(await page.locator(`[data-recommendation="${first}"]`).count(), 0);
    assert.equal(await page.locator('#watched-nav-count').textContent(), '1');
    await page.locator('#toast-undo').click();
    assert.equal(await page.locator(`[data-recommendation="${first}"]`).count(), 1);
    assert.equal(await page.locator('#watched-nav-count').textContent(), '0');
    await page.locator(`[data-seen="${first}"]`).click();
    await page.reload();
    await page.waitForFunction(() => !!window.MovieNight);
    assert.equal(await page.locator(`[data-recommendation="${first}"]`).count(), 0);
    await page.locator('#watched-tab').click();
    assert.equal(await page.locator('[data-watched]').count(), 1);
    assert.match(await page.locator('.added-date').textContent(), /^Added /);
    await page.locator(`[data-watch-id="${first}"][data-watch-rating="4"]`).click();
    assert.equal(await page.evaluate(id => MovieNight.getState().watched.find(movie => movie.id===Number(id)).rating, first), 4);
    await page.locator(`[data-unwatch="${first}"]`).click();
    assert.equal(await page.locator('[data-watched]').count(), 0);
    await page.locator('#toast-undo').click();
    assert.equal(await page.locator('[data-watched]').count(), 1);

    await addFromCatalog(page, 'The Matrix', 2571);
    const twoFilms = await page.locator('[data-watched]').count();
    await addFromCatalog(page, 'The Matrix', 2571);
    assert.equal(await page.locator('[data-watched]').count(), twoFilms, 'No duplicate catalog entries');
    await manual(page, 'Past Lives', '2023', '4', 'Drama');
    const customId = await page.evaluate(() => MovieNight.getState().watched.find(movie => movie.title==='Past Lives (2023)').id);
    assert(customId.startsWith('custom-'));
    await page.reload();
    await page.waitForFunction(() => !!window.MovieNight);
    assert(await page.locator('#watched-panel').isVisible(), 'Restore the last view');
    assert.equal(await page.locator(`[data-watched="${customId}"]`).count(), 1);
    await manual(page, 'Past Lives', '2023');
    assert.equal(await page.locator(`[data-watched="${customId}"]`).count(), 1, 'No duplicate manual entries');
    await page.locator('#watched-filter').fill('Past Lives');
    assert.equal(await page.locator('[data-watched]').count(), 1);
    await page.locator('#watched-genre').selectOption('Comedy');
    assert.equal(await page.locator('[data-watched]').count(), 0);
    await page.locator('#watched-filter').fill('');
    await page.locator('#watched-genre').selectOption('');
    await page.locator('#watched-sort').selectOption('title');
    const titles = await page.locator('[data-watched] h3').allTextContents();
    assert.deepEqual(titles, [...titles].sort((a,b) => a.localeCompare(b)));
    await page.locator('#watched-sort').selectOption('rating');
    assert(await page.evaluate(() => {
      const ratings = [...document.querySelectorAll('[data-watched]')].map(row => MovieNight.getState().watched.find(movie => String(movie.id)===row.dataset.watched).rating);
      return ratings.every((rating,index) => index===0 || ratings[index-1]>=rating);
    }));

    await page.locator('#find-tab').click();
    await page.locator('#genre').selectOption('Comedy');
    await page.locator('#result-count').selectOption('10');
    assert.equal(await page.locator('[data-recommendation]').count(), 10);
    assert(await page.evaluate(() => [...document.querySelectorAll('[data-recommendation]')].every(row => MovieNight.data.movies.find(movie => movie.id===Number(row.dataset.recommendation)).genres.includes('Comedy'))));
    const countBeforeReset = await page.evaluate(() => MovieNight.getState().watched.length);
    await page.locator('#reset').click();
    assert(await page.locator('#recommend').isDisabled());
    assert.equal(await page.locator('[data-recommendation]').count(), 0);
    assert.equal(await page.evaluate(() => MovieNight.getState().watched.length), countBeforeReset, 'Clearing ratings preserves the log');
    await page.locator('#watched-tab').click();
    await page.locator('[data-use="2571"]').click();
    assert(await page.locator('#finder-panel').isVisible());
    assert.equal((await page.evaluate(() => MovieNight.getState().ratings)).find(([id]) => id===2571)[1], 5);
    await page.locator('#watched-tab').click();
    await page.locator('[data-watch-id="2571"][data-watch-rating="2"]').click();
    assert.equal((await page.evaluate(() => MovieNight.getState().ratings)).find(([id]) => id===2571)[1], 2);
    await page.locator('#find-tab').click();
    await page.locator('#reset').click();
    for (const item of [{query:'The Matrix',id:2571},{query:'Inception',id:79132},{query:'Interstellar',id:109487}]) {
      await page.locator('#movie-search').fill(item.query);
      await page.locator('#movie-search').press('ArrowDown');
      await page.locator('#movie-search').press('Enter');
      await page.locator(`[data-movie="${item.id}"][data-rating="3"]`).click();
    }
    assert(await page.locator('#recommend').isDisabled());
    await page.locator('[data-movie="2571"][data-rating="5"]').click();
    assert(await page.locator('#recommend').isEnabled());
    await page.locator('#recommend').click();
    assert.equal(await page.locator('[data-recommendation]').count(), 5);
    assert.equal(await page.evaluate(() => MovieNight.getState().watched.filter(movie => [2571,79132,109487].includes(movie.id)).length), 3, 'Ratings are logged');
    await page.locator('[data-movie="79132"][data-rating="1"]').click();
    await page.reload();
    await page.waitForFunction(() => !!window.MovieNight);
    assert.equal((await page.evaluate(() => MovieNight.getState().ratings)).find(([id]) => id===79132)[1], 1);
    assert.equal((await page.evaluate(() => MovieNight.getState().watched)).find(movie => movie.id===79132).rating, 1);
    await page.locator('#movie-search').fill('zzzz-no-such-film');
    assert(await page.locator('#search-results .no-search-results').isVisible());
    await page.locator('#movie-search').press('Escape');
    assert(await page.locator('#search-results').isHidden());
    await page.locator('#movie-search').fill('');
    await page.locator('#find-tab').focus();
    await page.locator('#find-tab').press('ArrowRight');
    assert(await page.locator('#watched-panel').isVisible());
    await page.locator('#watched-sort').selectOption('recent');
    await noOverflow(page);
    await screenshot(page, 'watched-desktop');
    await page.setViewportSize({width:390,height:844});
    await noOverflow(page);
    await screenshot(page, 'watched-mobile');
    await page.locator('#find-tab').click();
    await noOverflow(page);
    await screenshot(page, 'finder-mobile');
    await page.setViewportSize({width:320,height:740});
    await noOverflow(page);
    await page.locator('#watched-tab').click();
    await noOverflow(page);
    await page.setViewportSize({width:1280,height:950});
    await page.locator('#manual-add').click();
    await page.locator('#manual-title').press('Escape');
    assert(await page.locator('#manual-dialog').isHidden());
    await manual(page, '=A "film", <img src=x onerror=alert(1)>', '2025', '5');
    assert.equal(await page.locator('#watched-list img').count(), 0, 'Treat titles as text');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-watched').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'movie-night-watched.csv');
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert(csv.includes('"title","year","genres","rating","added_at"'));
    assert(csv.includes('"Past Lives","2023","Drama","4"'));
    assert(csv.includes('"\'=A ""film"", <img src=x onerror=alert(1)>"'), 'Escape CSV cells and formula prefixes');
    await page.reload();
    await page.waitForFunction(() => !!window.MovieNight);
    assert(await page.locator('#watched-list').textContent().then(text => text.includes('<img src=x onerror=alert(1)>')));
    assert.equal(await page.locator('#watched-list img').count(), 0);
    await context.close();

    const migrated = await browser.newContext();
    await migrated.addInitScript(() => {
      localStorage.setItem('movie-night-profile-v1', JSON.stringify({ratings:[[2571,5],[79132,4],[109487,3]],seen:[1,6377],genre:'Animation',count:10,hasResults:true}));
    });
    const legacyPage = await open(migrated);
    const legacyState = await legacyPage.evaluate(() => MovieNight.getState());
    assert.deepEqual(legacyState.ratings, [[2571,5],[79132,4],[109487,3]]);
    assert.deepEqual(legacyState.seen, [1,6377]);
    assert(legacyState.watched.every(movie => movie.addedAt===null), 'Do not invent dates for old entries');
    assert.equal(await legacyPage.evaluate(() => JSON.parse(localStorage.getItem('movie-night-profile-v1')).version), 2);
    await legacyPage.locator('#watched-tab').click();
    assert.equal(await legacyPage.locator('.added-date').first().textContent(), 'From your saved list');
    await migrated.close();

    const blocked = await browser.newContext();
    await blocked.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Blocked','SecurityError'); }; });
    const blockedPage = await open(blocked);
    assert(await blockedPage.locator('#storage-warning').isVisible());
    await blockedPage.locator('[data-example="0"]').click();
    await blockedPage.locator('[data-seen]').first().click();
    assert.equal(await blockedPage.evaluate(() => MovieNight.getState().watched.length), 1, 'Stay usable when storage fails');
    await blocked.close();
    assert.deepEqual(errors, []);
    const report = {parity_profiles:Object.keys(golden).length, checks:[
      'keyboard search and tabs','star ratings and watched sync','minimum profile validation','sample profiles do not log films',
      'genre filtering and 5/10 picks','rated and watched exclusions','mark watched and undo','remove and undo',
      'watched search, genre and sorting','duplicate prevention','manual entries and persistence','CSV export and escaping',
      'clear ratings preserves watched history','use watched films for picks','legacy storage migration without invented dates',
      'storage failure warning','dialog Escape','title escaping','desktop and mobile overflow at 1280/390/320'
    ],page_errors:errors,status:'passed'};
    fs.writeFileSync(path.join(project,'results/browser_checks.json'), JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
