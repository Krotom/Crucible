// Turkish interface. The dictionary is keyed by the English text exactly as it appears in index.html, and translation walks the page's text
// nodes and title/placeholder attributes. Messages the app builds while running (toasts, panel rows, log lines) stay English: the coverage is
// the fixed interface, not every sentence. A test checks that every key still occurs in index.html, so renaming a label cannot silently drop its translation.
export type Lang = 'en' | 'tr'

export const TR: Record<string, string> = {
  'No data': 'Veri yok', 'Session': 'Oturum', 'Robot': 'Robot', 'Topics': 'Konular', 'Analysis': 'Analiz', 'Tune': 'Ayar',
  'Simulation': 'Simülasyon', 'Game': 'Oyun', 'Test game': 'Test oyunu', 'Opponent': 'Rakip', 'None': 'Yok', 'Blocker': 'Engelleyici', 'Red cycler': 'Kırmızı döngücü',
  'Blue ally (cycler)': 'Mavi müttefik (döngücü)', 'Ally + red cycler': 'Müttefik + kırmızı döngücü', 'Alliance': 'İttifak', 'Blue': 'Mavi', 'Red': 'Kırmızı',
  'Start position': 'Başlangıç konumu', 'Step': 'Adım', 'Seed': 'Tohum', 'Start sim': 'Simülasyonu başlat', 'Stop sim': 'Simülasyonu durdur', 'Data': 'Veri',
  'Open log…': 'Kayıt aç…', 'or drop a .wpilog anywhere in the window': 'veya bir .wpilog dosyasını pencereye bırakın', 'NT host': 'NT ana makinesi', 'Connect': 'Bağlan',
  'Reference log…': 'Karşılaştırma kaydı…', 'Robot code': 'Robot kodu', 'Mode': 'Mod', 'Scripted robot': 'Senaryolu robot', 'Robot code (real time)': 'Robot kodu (gerçek zaman)',
  'Robot code (lockstep, Mode B)': 'Robot kodu (adım adım, Mod B)', 'not set': 'ayarlanmadı', 'Choose…': 'Seç…', 'Check project': 'Projeyi denetle', 'Extra environment': 'Ek ortam değişkenleri',
  'Launch robot': 'Robotu başlat', 'Relaunch': 'Yeniden başlat', 'Not running': 'Çalışmıyor', 'Also start the sim when launching': 'Başlatırken simülasyonu da başlat',
  'Robot testing': 'Robot testi', 'Controls…': 'Kumandalar…', 'Battery model': 'Akü modeli', 'mΩ': 'mΩ', 'Things that go wrong': 'Ters giden şeyler', 'Brownout at': 'Voltaj düşmesi:',
  'Latency': 'Gecikme', 'Noise': 'Gürültü', 'Drop CAN': 'CAN kopar', 'Vision camera': 'Görüntü kamerası', 'Simulate a tag camera': 'Etiket kamerasını simüle et', 'Error': 'Hata',
  'Test scenarios': 'Test senaryoları', 'Run all': 'Hepsini çalıştır', 'Stop': 'Durdur', 'Mechanism inspector': 'Mekanizma denetçisi', 'Gradle output': 'Gradle çıktısı',
  'All': 'Hepsi', 'Build': 'Derleme', 'Errors': 'Hatalar', 'Warnings': 'Uyarılar', 'Info': 'Bilgi', 'Past runs…': 'Önceki çalıştırmalar…', 'Follow': 'Takip et', 'Copy': 'Kopyala',
  'Save': 'Kaydet', 'Clear': 'Temizle', 'Match summary': 'Maç özeti', 'Save report…': 'Rapor kaydet…', 'Events CSV…': 'Olaylar CSV…', 'Save run (.json)…': 'Çalıştırmayı kaydet (.json)…',
  'Save .wpilog…': '.wpilog kaydet…', 'Show the summary when a match ends': 'Maç bitince özeti göster', 'Compare runs': 'Çalıştırmaları karşılaştır', 'A: load…': 'A: yükle…',
  'A = this run': 'A = bu çalıştırma', 'B: load…': 'B: yükle…', 'B = this run': 'B = bu çalıştırma', 'Pause when…': 'Şu durumda duraklat…', 'a shot is launched': 'atış yapıldığında',
  'FUEL is picked up': 'FUEL alındığında', 'points are scored': 'sayı atıldığında', 'a foul is called': 'faul verildiğinde', 'the phase changes': 'evre değiştiğinde', 'impact over': 'çarpma üstü',
  'sim time': 'sim süresi', 'No pause yet.': 'Henüz duraklama yok.', 'Seed sweep': 'Tohum taraması', 'Runs': 'Çalıştırma', 'Secs': 'Sn', 'Run sweep': 'Taramayı çalıştır',
  'Pickup to launch': 'Almadan atışa', 'Shots and path': 'Atışlar ve yol', 'Events': 'Olaylar', 'Scores': 'Sayılar', 'Fouls': 'Fauller', 'Shots': 'Atışlar', 'Pickups': 'Almalar',
  'Impacts': 'Çarpmalar', 'Phases': 'Evreler', 'Physics': 'Fizik', 'Floor': 'Zemin', 'Reset all to the robot definition': 'Hepsini robot tanımına döndür', 'Calibration': 'Kalibrasyon',
  'Fit the sim to measured data from the real robot.': 'Simülasyonu gerçek robottan ölçülen verilere uydurun.', 'Open CSV…': 'CSV aç…', 'Example': 'Örnek', 'Volts': 'Volt',
  'also fit mass': 'kütleyi de uydur', 'Fit': 'Uydur', 'What is measured': 'Ne ölçüldü', 'Show': 'Göster', 'Guesses only': 'Yalnızca tahminler', 'Everything annotated': 'Not düşülen her şey',
  'Robot pose': 'Robot konumu', 'Components': 'Bileşenler', 'Focus robot': 'Robota odaklan', 'Camera': 'Kamera', 'Ruler': 'Cetvel', 'View ▾': 'Görünüm ▾',
  'Robot collision box': 'Robot çarpışma kutusu', 'Intake volume': 'Alım hacmi', 'Scoring volumes': 'Sayı hacimleri', 'Rules zones and center line': 'Kural bölgeleri ve orta çizgi',
  'Robot trail': 'Robot izi', 'Shot arcs and landing spots': 'Atış yayları ve düşüş noktaları', 'Scoreboard (B)': 'Skor tablosu (B)', 'Robot camera': 'Robot kamerası',
  'front (intake)': 'ön (alım)', 'top-down': 'yukarıdan', 'BLUE': 'MAVİ', 'RED': 'KIRMIZI', 'Drop a .wpilog': 'Bir .wpilog bırakın', 'to open it in BALTA Crucible': 'BALTA Crucible’da açmak için',
  'Play': 'Oynat', 'Pause': 'Duraklat', 'max (lockstep)': 'azami (adım adım)', 'Start match': 'Maçı başlat', 'End match': 'Maçı bitir', 'Enable': 'Etkinleştir', 'Disable': 'Devre dışı bırak',
  'Teleop': 'Teleop', 'Auto': 'Otonom', 'Test': 'Test', 'Reset': 'Sıfırla', 'Slot 1': 'Yuva 1', 'Slot 2': 'Yuva 2', 'Slot 3': 'Yuva 3', 'Save state': 'Durumu kaydet', 'Load state': 'Durumu yükle',
  'CSV': 'CSV', 'PNG': 'PNG', 'Clear plot': 'Grafiği temizle', 'Controls': 'Kumandalar', 'Gamepad': 'Oyun kolu', 'Dead zone': 'Ölü bölge', 'Standard layout': 'Standart yerleşim',
  'Keyboard driving': 'Klavyeyle sürüş', 'Default keys': 'Varsayılan tuşlar', 'Close': 'Kapat', 'Match over': 'Maç bitti', 'Keyboard shortcuts': 'Klavye kısayolları',
  'Physics simulation and analysis for FRC robot code. Version': 'FRC robot kodu için fizik simülasyonu ve analiz. Sürüm',
}

/** The Turkish text for an English one (or the English text itself when there is none or the language is English). */
export function translate(text: string, lang: Lang): string {
  if (lang === 'en') return text
  return TR[text] ?? text
}

const originals = new WeakMap<Node, string>()
const origAttrs = new WeakMap<Element, Record<string, string>>()
const ATTRS = ['title', 'placeholder', 'aria-label']

/** Translates the text nodes and title/placeholder attributes under `root`, or puts the English back. Safe to call again after the page changes. */
export function applyLanguage(root: ParentNode, lang: Lang): void {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement
    if (!parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue
    const orig = originals.get(n) ?? (n as Text).data
    const trimmed = orig.trim()
    if (!trimmed) continue
    const out = translate(trimmed, lang)
    if (out === trimmed && !originals.has(n)) continue // nothing to translate, nothing to remember
    originals.set(n, orig)
    const next = orig.replace(trimmed, out)
    if ((n as Text).data !== next) (n as Text).data = next
  }
  for (const el of Array.from((root as Element).querySelectorAll?.('[title],[placeholder],[aria-label]') ?? [])) {
    const saved = origAttrs.get(el) ?? {}
    for (const a of ATTRS) {
      const cur = el.getAttribute(a)
      if (cur === null) continue
      const orig = saved[a] ?? cur
      const out = translate(orig, lang)
      if (out === orig && !(a in saved)) continue
      saved[a] = orig; if (cur !== out) el.setAttribute(a, out)
    }
    origAttrs.set(el, saved)
  }
}
