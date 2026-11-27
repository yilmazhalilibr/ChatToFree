# Ölçülen site kontrolleri (canlı, 2026-11-17)

Hesap: kullanıcının kendi Chrome'u. Arayüz Türkçe; **isimler yerelleşiyor**, bu yüzden her
eşleştirme TR+EN tablosu ve rol/yapı ile yapılıyor. Menüler açılışta `pointerdown` bekliyor
(Radix / Angular Material): düz `.click()` Claude/ChatGPT/Gemini menülerini açmıyor.

| site | model | reasoning | diğer |
|---|---|---|---|
| ChatGPT | **seçici yok** (ücretsiz plan; başlıkta model düğmesi görünmüyor) | `Düşünme` düğmesi, `aria-pressed` ile aç/kapa. Seviye yok. `+` menüsünde `Düşün` satırı da var | `+` menüsü: Web araması, Derin araştırma, Görsel oluştur… |
| Claude | `data-testid=model-selector-dropdown` → `menuitemradio` satırları: Sonnet 5.5 (seçili), Haiku 5.5. Kilitli modeller `menuitem` + "Yükselt" (Fable 5.2, Opus 5.5). `Daha fazla model` alt menüsü | Aynı menüde **`Çaba`** alt menüsü: Düşük / Orta / Yüksek / Ekstra yüksek / Maksimum (`menuitemradio`) | — |
| Gemini | `Mod seçiciyi aç…` düğmesi → `menuitemradio`: Otomatik (seçili), Kod ve analiz | Aynı menüde **`Düşünme düzeyi`** alt menüsü: Düşük / Orta / Yüksek | — |
| DeepSeek | seçici yok | `Derin Düşünme` (`div`, `aria-pressed`) aç/kapa | `Akıllı Arama` (`aria-pressed`) aç/kapa |

Sonuçlar:
- Menü satırı = `menuitemradio` (seçilebilir) veya `menuitem` (kilitli / alt menü). Satır adı
  açıklamayı da içerir ("Sonnet 5.5 Daha basit görevler için…"), model eşleştirmesi bu yüzden
  ilk satıra ve alt dize eşleşmesine bakar.
- Alt menü, ebeveyninden sonra belgede açılır; en son açılan menü grubu doğru olandır.
- Plan değişince listeler değişir (Plus: model seçici, daha çok seviye). Sürücüler bulamadığı
  kontrolü "desteklenmiyor" diye raporlar, tahmin yürütmez.
