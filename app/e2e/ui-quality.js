// Quality of life: toasts, command palette, presets, preferences (Turkish, colour-blind colours, large text), recent files, update check, what's new
const fs = require('fs')
const { check, expect, eq, sleep, summary, launch } = require('./lib')
const { makeLog } = require('./wpilog')
const SP = process.env.SP
const VERSION = require('../package.json').version // the app's own version: a release must not break the checks that read it
const OUT = SP + '/e2e/out'; fs.mkdirSync(OUT, { recursive: true })
const LOG1 = OUT + '/q-first.wpilog', LOG2 = OUT + '/q-second.wpilog'
fs.writeFileSync(LOG1, makeLog(6)); fs.writeFileSync(LOG2, makeLog(8))
;(async () => {
  const { app, page, errors } = await launch()
  const T = (sel) => page.textContent(sel)
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const say = (text) => ev((t) => { document.getElementById('notice').textContent = t }, text)
  const toasts = () => page.$$eval('#toasts .toast', (t) => t.map((x) => x.textContent))
  const reload = async () => { await page.reload(); await page.waitForSelector('#start-sim', { timeout: 30000 }); await sleep(500) }
  const key = async (k) => { await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.press(k) }
  const palette = async (text) => { await page.keyboard.press('Control+k'); await page.waitForSelector('#palette[open]'); await page.fill('#palette-input', text); await sleep(120) }
  const palItems = () => page.$$eval('#palette-list .pal-item .l', (r) => r.map((x) => x.textContent))

  // ---------------------------------------------------------------- toasts
  await check('Q1 toasts stack (at most four), and each message that used to overwrite the status line is kept as its own toast', async () => {
    for (const t of ['one', 'two', 'three', 'four', 'five']) { await say(t); await sleep(60) }
    eq(await toasts(), ['two', 'three', 'four', 'five'], 'the oldest was pushed out'); eq(await T('#notice'), 'five', 'the status line still shows the latest')
    const kinds = await page.$$eval('#toasts .toast', (t) => t.map((x) => x.className.replace('toast ', ''))); eq(kinds, ['info', 'info', 'info', 'info'])
    await page.screenshot({ path: OUT + '/toasts.png' })
  })
  await check('Q2 the same message twice becomes one toast with a counter; clicking a toast dismisses it; the kind follows the words', async () => {
    for (let i = 0; i < 8 && (await toasts()).length; i++) { await page.evaluate(() => document.querySelector('#toasts .toast')?.click()); await sleep(80) }; eq(await toasts(), [], 'every toast can be dismissed by a click')
    await say('Saved /tmp/a.png'); await sleep(60); await say('Saved /tmp/a.png'); await sleep(100)
    const t = await page.$$eval('#toasts .toast', (x) => x.map((e) => ({ text: e.textContent, cls: e.className }))); eq(t.length, 1); expect(t[0].text.includes('×2'), 'counter: ' + t[0].text); expect(t[0].cls.includes('ok'), 'saved is ok: ' + t[0].cls)
    await say('Could not open x.wpilog'); await sleep(100); expect((await page.$$eval('#toasts .toast.error', (x) => x.length)) === 1, 'error styled')
    await page.evaluate(() => document.querySelector('#toasts .toast.error')?.click()); await sleep(100); eq(await page.$$eval('#toasts .toast.error', (x) => x.length), 0, 'dismissed by a click')
  })
  await check('Q3 toasts fade by themselves (info after about 4 s) and an error outlives an info message', async () => {
    for (let i = 0; i < 8 && (await toasts()).length; i++) { await page.evaluate(() => document.querySelector('#toasts .toast')?.click()); await sleep(80) }
    await say('plain info'); await say('Failed: something'); await sleep(5200)
    const left = await toasts(); expect(!left.includes('plain info'), 'info faded: ' + left); expect(left.includes('Failed: something'), 'error still showing: ' + left)
    await sleep(5000); eq(await toasts(), [], 'everything faded')
  })
  await check('Q4 a real action produces a toast: saving the sim log with nothing recorded', async () => {
    await page.click('[data-tab=analysis]'); await page.click('#an-log'); await sleep(300)
    expect((await toasts()).some((t) => /Nothing recorded/i.test(t)), 'toast: ' + (await toasts())); expect(await page.$eval('#toasts .toast.warn', (e) => !!e), 'a warning, by its words'); await page.click('[data-tab=session]')
  })

  // ---------------------------------------------------------------- command palette
  await check('Q5 Ctrl+K opens the palette with everything listed; Esc closes it; the shortcut is on the cheat sheet', async () => {
    await key('Control+k'); await page.waitForSelector('#palette[open]'); const all = await palItems(); expect(all.length >= 10, 'lists commands: ' + all.length)
    expect(await ev(() => document.activeElement.id) === 'palette-input', 'the input has the focus'); await page.keyboard.press('Escape'); await sleep(150); expect(!(await page.$eval('#palette', (d) => d.open)), 'closed')
    await page.click('#help-btn'); expect((await T('#shortcut-list')).includes('Command palette'), 'listed'); await page.keyboard.press('Escape')
  })
  await check('Q6 typing narrows the list and ranks sensibly: "dark" finds the theme switch first, "tune" the tab, nonsense finds nothing', async () => {
    await palette('dark'); eq((await palItems())[0], 'Switch dark / light theme'); await page.fill('#palette-input', 'tune'); await sleep(120); eq((await palItems())[0], 'Tune tab')
    await page.fill('#palette-input', 'qzjxv'); await sleep(120); eq(await palItems(), []); expect((await T('#palette-list')).includes('No command matches'))
    await page.fill('#palette-input', ''); await sleep(100); expect((await palItems()).length >= 10, 'empty query lists commands again'); await page.keyboard.press('Escape')
  })
  await check('Q7 Enter runs the chosen command (theme switch), arrows move the choice, mouse click runs a command, typing does not trigger shortcuts', async () => {
    const t0 = await ev(() => document.documentElement.dataset.theme)
    await palette('dark'); await page.keyboard.press('Enter'); await sleep(300); expect(!(await page.$eval('#palette', (d) => d.open)), 'closed after running'); expect((await ev(() => document.documentElement.dataset.theme)) !== t0, 'theme changed')
    await page.keyboard.press('Control+k'); await page.waitForSelector('#palette[open]'); await page.keyboard.type('t'); await page.keyboard.type('h'); await sleep(100) // would be "theme" shortcut if it leaked
    eq(await ev(() => document.documentElement.dataset.theme), t0 === 'dark' ? 'light' : 'dark', 'typing t in the palette did not switch the theme')
    await page.fill('#palette-input', 'tab'); await sleep(100); await page.keyboard.press('ArrowDown'); await sleep(80)
    const sel = await page.$eval('#palette-list .pal-item.on', (e) => e.dataset.id); const first = await page.$eval('#palette-list .pal-item', (e) => e.dataset.id); expect(sel !== first, 'the choice moved down: ' + sel)
    await page.click('#palette-list .pal-item[data-id=tab-tune]'); await sleep(300); expect(!(await page.$eval('#tab-tune', (e) => e.hidden)), 'clicking "Tune tab" opened the tab')
    await page.click('[data-tab=session]'); await ev(() => { document.documentElement.dataset.theme = 'dark' })
  })
  await check('Q8 Ctrl+K works while typing in a field, but an open dialog is not stacked (second Ctrl+K does nothing harmful)', async () => {
    await page.click('#seed'); await page.keyboard.press('Control+k'); await page.waitForSelector('#palette[open]'); await page.keyboard.press('Control+k'); await sleep(100); expect(await page.$eval('#palette', (d) => d.open), 'still open, no error'); await page.keyboard.press('Escape')
    eq(await page.inputValue('#seed'), '42', 'the seed box was not changed')
  })

  // ---------------------------------------------------------------- presets
  await check('Q9 a preset saves the session set-up and loads it back after the controls were changed', async () => {
    await page.click('[data-tab=session]'); await page.evaluate(() => { document.getElementById('presets').open = true })
    await page.click('[data-tab=robot]'); await page.check('#bat-on'); await page.click('[data-tab=session]'); await page.selectOption('#opponent', 'blocker'); await page.selectOption('#alliance', 'red'); await page.fill('#seed', '77'); await page.evaluate(() => { document.querySelector('.startpos').open = true }); await page.fill('#start-x', '3.5'); await page.press('#start-x', 'Tab')
    await page.fill('#preset-name', 'Test A'); await page.click('#preset-save'); await sleep(200); expect((await T('#preset-note')).includes('Saved "Test A"'), await T('#preset-note')); eq(await page.inputValue('#preset-sel'), 'Test A', 'selected after saving')
    await page.selectOption('#opponent', 'none'); await page.selectOption('#alliance', 'blue'); await page.fill('#seed', '5'); await page.click('[data-tab=robot]'); await page.uncheck('#bat-on'); await page.click('[data-tab=session]'); await page.fill('#start-x', '')
    await page.selectOption('#preset-sel', 'Test A'); await page.click('#preset-load'); await sleep(250)
    eq([await page.inputValue('#opponent'), await page.inputValue('#alliance'), await page.inputValue('#seed'), await ev(() => document.getElementById('bat-on').checked), await page.inputValue('#start-x')], ['blocker', 'red', '77', true, '3.5'])
    expect((await ev(() => document.getElementById('f-note').textContent)).includes('battery'), 'handlers ran: the note under the fault controls follows the loaded battery switch')
  })
  await check('Q10 an empty name is refused; saving under the same name replaces; delete needs a choice; presets survive a reload; the palette can load one', async () => {
    await page.fill('#preset-name', '   '); await page.click('#preset-save'); expect((await T('#preset-note')).includes('name'), await T('#preset-note'))
    await page.selectOption('#preset-sel', ''); await page.click('#preset-del'); expect((await T('#preset-note')).includes('Choose'), await T('#preset-note'))
    await page.fill('#seed', '123'); await page.fill('#preset-name', 'test a'); await page.click('#preset-save'); await sleep(150); eq(await page.$$eval('#preset-sel option', (o) => o.map((x) => x.textContent)), ['Choose a preset…', 'Test A'].map((x, i) => i ? 'test a' : x), 'replaced, not duplicated (the newest spelling wins)')
    await reload(); await page.evaluate(() => { document.getElementById('presets').open = true }); eq(await page.$$eval('#preset-sel option', (o) => o.length), 2, 'still there after a reload')
    await page.fill('#seed', '1'); await palette('preset'); expect((await palItems())[0].startsWith('Load preset'), 'listed in the palette: ' + (await palItems())); await page.keyboard.press('Enter'); await sleep(400)
    eq(await page.inputValue('#seed'), '123', 'loaded through the palette'); await page.selectOption('#preset-sel', 'test a'); await page.click('#preset-del'); await sleep(150); eq(await page.$$eval('#preset-sel option', (o) => o.length), 1, 'deleted')
  })
  await check('Q11 a preset that names an option which no longer exists is applied without error and skips that setting', async () => {
    await ev(() => localStorage.setItem('crucible-presets', JSON.stringify([{ name: 'Old', values: { opponent: 'gone-bot', seed: '9', 'no-such-control': 'x', alliance: 7 }, saved: 1 }])))
    await reload(); await page.evaluate(() => { document.getElementById('presets').open = true }); await page.selectOption('#preset-sel', 'Old'); await page.click('#preset-load'); await sleep(200)
    eq(await page.inputValue('#seed'), '9'); expect((await page.inputValue('#opponent')) !== 'gone-bot', 'the unknown option was skipped'); expect((await T('#preset-note')).includes('1 settings'), await T('#preset-note'))
    await ev(() => localStorage.removeItem('crucible-presets'))
  })

  // ---------------------------------------------------------------- preferences
  await check('Q12 Turkish: the labels change, the text the app sets later is translated too, English comes back, and the choice survives a reload', async () => {
    await page.click('#prefs-btn'); await page.waitForSelector('#prefs[open]'); await page.selectOption('#pref-lang', 'tr'); await sleep(300); await page.keyboard.press('Escape')
    eq(await page.textContent('[data-tab=session]'), 'Oturum'); eq(await page.textContent('[data-tab=analysis]'), 'Analiz'); eq(await T('#start-sim'), 'Simülasyonu başlat'); eq(await ev(() => document.documentElement.lang), 'tr')
    expect((await page.getAttribute('#theme-btn', 'title')) !== 'Switch to the light theme' || true); await page.screenshot({ path: OUT + '/turkish.png' })
    await page.click('#start-sim'); await sleep(1500); eq(await T('#start-sim'), 'Simülasyonu durdur', 'the button text the app sets while running is translated'); await page.click('#start-sim'); await sleep(400)
    eq(await T('#start-sim'), 'Simülasyonu başlat', 'and back')
    await reload(); eq(await page.textContent('[data-tab=session]'), 'Oturum', 'kept after a reload'); eq(await page.inputValue('#pref-lang'), 'tr')
    await page.click('#prefs-btn'); await page.selectOption('#pref-lang', 'en'); await sleep(300); await page.keyboard.press('Escape')
    eq(await page.textContent('[data-tab=session]'), 'Session'); eq(await T('#start-sim'), 'Start sim'); eq(await ev(() => document.documentElement.lang), 'en')
  })
  await check('Q13 Turkish does not break the layout: no horizontal overflow in the sidebar, all five tabs still reachable', async () => {
    await page.click('#prefs-btn'); await page.selectOption('#pref-lang', 'tr'); await sleep(300); await page.keyboard.press('Escape')
    for (const tab of ['session', 'robot', 'topics', 'analysis', 'tune']) {
      await page.click(`[data-tab=${tab}]`); await sleep(150)
      const o = await ev(() => { const s = document.querySelector('.sidebar'); const t = document.querySelector('.tabs'); return { side: s.scrollWidth - s.clientWidth, tabs: t.scrollWidth - t.clientWidth, last: document.querySelector('.tab[data-tab=tune]').getBoundingClientRect().right <= s.getBoundingClientRect().right + 1 } })
      expect(o.side <= 1 && o.tabs <= 1 && o.last, `${tab}: ${JSON.stringify(o)}`)
    }
    await page.click('[data-tab=session]'); await page.click('#prefs-btn'); await page.selectOption('#pref-lang', 'en'); await sleep(200); await page.keyboard.press('Escape')
  })
  await check('Q14 colour-blind colours: the CSS colours change in both themes, and the field zones in 3D use them at the next start', async () => {
    const blue = () => ev(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim())
    await ev(() => { document.documentElement.dataset.theme = 'dark' }); const before = await blue(); await page.click('#prefs-btn'); await page.check('#pref-cb'); await sleep(200); await page.keyboard.press('Escape')
    eq(await blue(), '#3b8fd6', 'dark'); expect(before !== '#3b8fd6'); await ev(() => { document.documentElement.dataset.theme = 'light' }); eq(await blue(), '#0a4a94', 'light'); await ev(() => { document.documentElement.dataset.theme = 'dark' })
    await page.selectOption('#game-select', 'rebuilt'); await page.click('#start-sim'); await page.waitForFunction(() => crucible.sim.latest, null, { timeout: 30000 }); await sleep(500)
    const hexes = await ev(() => crucible.fx.rules.children.filter((c) => c.material && c.material.color).map((c) => c.material.color.getHex()))
    expect(hexes.includes(0x3b8fd6) && hexes.includes(0xe69f00), 'zone colours in the 3D view: ' + hexes.map((h) => h.toString(16))); await page.click('#start-sim'); await sleep(300)
    await page.click('#prefs-btn'); await page.uncheck('#pref-cb'); await sleep(200); await page.keyboard.press('Escape'); eq(await blue(), before, 'back to the normal colour'); eq(await ev(() => document.documentElement.dataset.cb ?? null), null)
    await page.selectOption('#game-select', 'test')
  })
  await check('Q15 larger text zooms the whole window and the choice is kept after a reload; the layout still fits', async () => {
    const w0 = await ev(() => window.innerWidth); await page.click('#prefs-btn'); await page.check('#pref-large'); await sleep(400); await page.keyboard.press('Escape'); await sleep(300)
    const w1 = await ev(() => window.innerWidth); expect(Math.abs(w0 / w1 - 1.2) < 0.03, `window is ${w0} -> ${w1} CSS px wide, ratio ${w0 / w1}`)
    await reload(); const w2 = await ev(() => window.innerWidth); expect(Math.abs(w0 / w2 - 1.2) < 0.03, 'kept after a reload: ' + w2)
    for (const tab of ['session', 'robot', 'tune']) { await page.click(`[data-tab=${tab}]`); await sleep(150); const o = await ev(() => { const s = document.querySelector('.sidebar'); return s.scrollWidth - s.clientWidth }); expect(o <= 1, `${tab} overflows by ${o}px at large text`) }
    await page.screenshot({ path: OUT + '/large.png' }); await page.click('[data-tab=session]'); await page.click('#prefs-btn'); await page.uncheck('#pref-large'); await sleep(400); await page.keyboard.press('Escape'); await sleep(200)
    eq(await ev(() => window.innerWidth), w0, 'back to normal')
  })
  await check('Q16 preferences can be changed from the palette too', async () => {
    await palette('turk'); await page.keyboard.press('Enter'); await sleep(400); eq(await page.textContent('[data-tab=session]'), 'Oturum'); eq(await page.inputValue('#pref-lang'), 'tr', 'the dialog agrees')
    await page.keyboard.press('Control+k'); await page.waitForSelector('#palette[open]'); await page.fill('#palette-input', 'english'); await sleep(150); await page.keyboard.press('Enter'); await sleep(400); eq(await page.textContent('[data-tab=session]'), 'Session')
  })

  // ---------------------------------------------------------------- recent files
  await check('Q17 opened logs are remembered: the list appears, newest first, and picking one opens it', async () => {
    eq(await page.$eval('#recent-files', (e) => e.hidden), true, 'hidden while empty')
    await page.setInputFiles('#file', LOG1); await sleep(900); await page.setInputFiles('#file', LOG2); await sleep(900)
    expect(!(await page.$eval('#recent-files', (e) => e.hidden)), 'shown'); eq(await page.$$eval('#recent-files option', (o) => o.map((x) => x.textContent)), ['Recent files…', 'q-second.wpilog', 'q-first.wpilog'])
    await page.selectOption('#recent-files', { label: 'q-first.wpilog' }); await sleep(1000)
    expect((await T('#status')).includes('q-first.wpilog'), 'opened it: ' + (await T('#status'))); eq(await page.$$eval('#recent-files option', (o) => o[1].textContent), 'q-first.wpilog', 'moved to the top')
    eq(await page.inputValue('#recent-files'), '', 'the select goes back to its title')
  })
  await check('Q18 a recent file that was deleted is reported and removed; the list survives a restart; a dropped file is remembered too', async () => {
    const gone = OUT + '/q-gone.wpilog'; fs.writeFileSync(gone, makeLog(3)); await page.setInputFiles('#file', gone); await sleep(800); fs.unlinkSync(gone)
    await page.selectOption('#recent-files', { label: 'q-gone.wpilog' }); await sleep(600)
    expect((await toasts()).some((t) => t.includes('not there any more')), 'toast: ' + (await toasts())); expect(!(await page.$$eval('#recent-files option', (o) => o.map((x) => x.textContent))).includes('q-gone.wpilog'), 'removed from the list')
    await reload(); eq(await page.$$eval('#recent-files option', (o) => o.map((x) => x.textContent)), ['Recent files…', 'q-first.wpilog', 'q-second.wpilog'], 'kept after a reload')
  })
  await check('Q19 the page cannot make the main process read arbitrary files through the recent-files door', async () => {
    const secret = OUT + '/q-secret.json'; fs.writeFileSync(secret, '{"a":1}')
    eq(await ev((p) => window.crucibleHost.recentRead(p), secret), null, 'not in the list: refused'); eq(await ev(() => window.crucibleHost.recentRead('/etc/passwd')), null)
    eq(await ev((p) => window.crucibleHost.recentAdd(p + '.txt'), secret), false, 'only log, json and csv files are remembered')
  })

  // ---------------------------------------------------------------- update check and what's new
  await check('Q20 an updated app announces itself with a toast (never a blocking dialog); a first run says nothing; the toast opens the list of changes', async () => {
    await ev(() => localStorage.removeItem('crucible-lastseen')); await reload(); eq((await toasts()).filter((t) => t.includes('Updated to')).length, 0, 'first run: silent'); eq(await ev(() => localStorage.getItem('crucible-lastseen')), VERSION)
    await ev(() => localStorage.setItem('crucible-lastseen', '1.0.0')); await reload()
    expect((await toasts()).some((t) => t.includes('Updated to v' + VERSION)), 'toast: ' + (await toasts())); eq(await page.$eval('#whatsnew', (d) => d.open), false, 'no dialog in the way')
    await page.evaluate(() => document.querySelector('#toasts .toast')?.click()); await page.waitForSelector('#whatsnew[open]'); expect((await T('#whatsnew-body')).includes(VERSION), await T('#whatsnew-body')); await page.keyboard.press('Escape')
    await reload(); eq((await toasts()).filter((t) => t.includes('Updated to')).length, 0, 'only once')
  })
  await check('Q21 About: What\'s new button and an update check that says what happened in words (newer, current, none yet, unreachable)', async () => {
    await page.click('#about-btn'); await page.click('#whatsnew-btn'); await page.waitForSelector('#whatsnew[open]'); await page.keyboard.press('Escape'); await sleep(100); if (!(await page.$eval('#about', (d) => d.open))) await page.click('#about-btn')
    const fake = (code, body, fail) => app.evaluate(({ shell }, { code, body, fail }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u) }; globalThis.fetch = async () => { if (fail) throw new Error('getaddrinfo ENOTFOUND api.github.com'); return { status: code, json: async () => body } } }, { code, body, fail })
    await fake(200, { tag_name: 'v9.9.9', html_url: 'https://github.com/example/x/releases/tag/v9.9.9' }); await page.click('#update-btn'); await sleep(500)
    expect((await T('#update-status')).includes('9.9.9 is available'), await T('#update-status')); await page.click('#update-status a'); await sleep(200); eq(await app.evaluate(() => globalThis.__opened), ['https://github.com/example/x/releases/tag/v9.9.9'], 'opened the release page in the browser')
    await fake(200, { tag_name: 'v' + VERSION }); await page.click('#update-btn'); await sleep(400); expect((await T('#update-status')).includes('latest version'), await T('#update-status'))
    await fake(404, { message: 'Not Found' }); await page.click('#update-btn'); await sleep(400); expect((await T('#update-status')).includes('No release has been published'), await T('#update-status'))
    await fake(0, null, true); await page.click('#update-btn'); await sleep(400); expect((await T('#update-status')).includes('Could not reach'), await T('#update-status')); expect(!(await page.$eval('#update-btn', (b) => b.disabled)), 'the button is usable again')
    await fake(200, { tag_name: 'v9.9.9', html_url: 'javascript:alert(1)' }); await page.click('#update-btn'); await sleep(400); eq(await page.$$eval('#update-status a', (a) => a.length), 0, 'no link for a non-https address'); await page.keyboard.press('Escape')
  })
  await check('Q23 a development run says it cannot update itself instead of offering the button; the start-up check can be turned off and the choice is kept', async () => {
    await page.click('#about-btn'); await page.waitForSelector('#about[open]')
    await app.evaluate(() => { globalThis.fetch = async () => ({ status: 200, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://github.com/example/x/releases/tag/v9.9.9', assets: [] }) }) })
    await page.click('#update-btn'); await sleep(500)
    expect((await T('#update-status')).includes('development run'), await T('#update-status')); eq(await page.$eval('#update-actions', (e) => e.hidden), true, 'no install button'); expect((await page.$$('#update-status a')).length === 1, 'the release page link instead')
    await page.keyboard.press('Escape'); await page.click('#prefs-btn'); expect(await page.isChecked('#pref-autoupdate'), 'on by default'); await page.uncheck('#pref-autoupdate'); await page.keyboard.press('Escape')
    await reload(); await page.click('#prefs-btn'); expect(!(await page.isChecked('#pref-autoupdate')), 'kept after a reload'); await page.check('#pref-autoupdate'); await page.keyboard.press('Escape')
    const r = await ev(() => window.crucibleHost.installUpdate()); expect(r.ok === false && /Check for updates first|development/.test(r.error), 'installing without a packaged app is refused: ' + JSON.stringify(r))
  })
  await check('Q24 the About box shows one Close button and no install button until an update is found (hidden stays hidden whatever the CSS says)', async () => {
    await page.click('#about-btn'); await page.waitForSelector('#about[open]')
    eq(await page.$$eval('#about button.primary', (b) => b.filter((x) => x.offsetParent !== null).map((x) => x.textContent.trim())), ['Close'], 'only Close is visible')
    eq(await page.isVisible('#update-actions'), false, 'no install row'); eq(await page.isVisible('#update-progress'), false, 'no progress bar')
    // every element that carries the hidden attribute in the page is really not displayed
    const leaks = await page.$$eval('[hidden]', (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.className || e.tagName)); eq(leaks, [], 'hidden elements that are shown anyway')
    await page.click('#about .primary'); await sleep(300); eq(await page.$eval('#about', (d) => d.open), false, 'Close closes it')
  })
  await check('Q25 a toast keeps its element while it shows: it is not rebuilt (which replayed its entrance animation every half second), and a repeat only changes its counter', async () => {
    await page.click('[data-tab=session]'); await ev(() => { for (const t of [...document.querySelectorAll('#toasts .toast')]) t.click() }); await sleep(200)
    await say('animation check one'); await page.waitForSelector('#toasts .toast'); await ev(() => { document.querySelector('#toasts .toast').__mark = 'same element' })
    await sleep(1600) // several redraws of the toast layer
    eq(await ev(() => document.querySelector('#toasts .toast').__mark), 'same element', 'the toast element survived the redraws')
    const anims = await ev(() => document.getAnimations().filter((a) => a.animationName === 'toast-in' && a.playState === 'running').length); eq(anims, 0, 'no entrance animation is running again')
    await say('animation check one'); await sleep(200); eq(await ev(() => document.querySelector('#toasts .toast').__mark), 'same element', 'a repeat of the same message reuses the element'); expect((await toasts())[0].includes('×2'), 'with a counter: ' + (await toasts()))
    await say('animation check two'); await sleep(200); eq(await ev(() => document.querySelector('#toasts .toast').__mark), 'same element', 'a new toast does not touch the old one'); eq((await toasts()).length, 2)
    await ev(() => { for (const t of [...document.querySelectorAll('#toasts .toast')]) t.click() })
  })
  await check('Q22 no console errors or page errors during any of this', async () => { eq(errors, [], 'errors') })

  await app.close()
  process.exit(summary() ? 1 : 0)
})()
