# ChatToFree — durum

## Doğrulanan (gerçek siteler, senin Chrome'un, senin hesapların)

| site | cevap | kod üretimi |
|---|---|---|
| ChatGPT | ✅ 4–9 s | ✅ `write hello.js` parse edildi |
| Claude | ✅ 16 s | ✅ |
| Gemini | ✅ 13–15 s | ✅ |
| DeepSeek | ✅ 11–15 s | ✅ |

Tam koşu: **4/4** (birden fazla kez). Testler: **170/170** (`npm test`, ~1 dk).

## Hesap askıya alındı, yön değişti (2026-11-18)

- **Olan:** DeepSeek önce oturumu her yerde kapattı (`INVALID_TOKEN`, Chrome sekmesi de çıkış yaptı), sonra hesabı geçici olarak askıya aldı.
- **Ölçülen trafik:** yeni girişten sonraki ~11 dakikada c2f testleri ~25 mesaj gönderdi, 14 yeni sohbet açtı, 4 aşırı uzun mesaj (120–400 bin karakter) denedi, aynı isteği art arda 5 kez yolladı; mesajlar 2–3 sn arayla, her yeni sohbette ~23 bin karakterlik sistem + araç tanımıyla.
- **Sebep (kanıtlanmadı):** en olası tetikleyici bu test yoğunluğu ve biçimi. Katkısı olabilecekler: kayıtlı çerezde oturum çerezinin (`ds_session_id`, HttpOnly; eklenti yalnızca sayfanın gördüğü 3 çerezi okuyor) bulunmaması, tarayıcının gönderdiği cihaz başlıklarını (`x-hif-*`) boş göndermemiz, sabit yazılmış istemci sürümü/UA. Yani istekler oturum çerezi olmadan, yalnızca Bearer token ile gidiyordu. Hangisinin belirleyici olduğu bilinmiyor.
- **Karar:** web modeli artık yalnızca konuşularak kullanılıyor (`c2f_advise`, `ctf` ajanı, `c2f sohbet`). Makine gibi süren her şey `automation` bayrağının arkasında ve varsayılan kapalı. Parmak izi taklidi gibi tespitten kaçınma amaçlı hiçbir şey eklenmedi.
- **Sayaç hatası (düzeltildi):** model ucu üzerinden giden mesajlar bütçe sayacına yazılmıyordu (sabah ~35 mesaj, sayaçta 3). Artık o yol da aynı sayaca yazıyor ve saatlik/günlük bütçeye uyuyor.
- **Canlı deneme (tek oturum, tek mesaj):** `ctf` ajanı birinci tekil kişiyle yazdı ("Tek dosyalık bir index.html yapmak istiyorum… Sence en sade haliyle nasıl yapayım…?"), DeepSeek cevapladı, ajan öneriyi uyguladı ve işi bitirdi (44 sn). Sayaçta 1 mesaj; giriş denemeden sonra hâlâ geçerli. Hesaba giden toplam trafik bundan fazlaydı: giriş kaydı sırasında 1 boş sohbet açıldı ve 1 bulmaca istendi, mesajla birlikte 1 sohbet açma + 1 bulmaca + 1 başlık isteği gitti, ayrıca 3 salt-okunur giriş kontrolü yapıldı. Giriş kaydı artık sohbet açmıyor (tek salt-okunur istek). Otomasyon bayraksız pencereli giriş yolu da gerçek DeepSeek'te çalıştı ve oturum çerezini (`ds_session_id`) aldı. Ajan modeli olarak ücretsiz bir OpenCode modeli kullanıldı.
- **Doğrulanmayan:** yeni düzenin bir hesabı koruduğu (tek mesaj bunu göstermez); yerel modelin aynı üslubu tutturduğu; birden çok danışmalı bir görev. Seyrek ve kısa mesaj gönderir; yine de resmi olmayan bir kullanım.

## İki mod (2026-11-18, canlı doğrulandı)

- **Doğrudan (DeepSeek model olarak):** `src/api.js`, OpenAI uyumlu uç (`127.0.0.1:8788`), her c2f MCP süreci sunar. `opencode run -m c2f/deepseek` ile üç gerçek görev: dosya yaz+oku 9 sn; betik yaz+çalıştır 9 sn; modül + 3 test + çalıştır 13 sn. Bir görev tek DeepSeek sohbetinde sürüyor (uç günlüğü: ilk mesaj 22.685 karakter, sonrakiler 325 / 153 / 130).
- **Araç çağrıları:** `<tool_call>` biçimi ve DeepSeek'in kendi DSML biçimi. Canlıda yakalanan eksiksiz bir DSML cevabı `test/fixtures/dsml-reply.txt` içinde ve testte ayrıştırılıyor; diğer yazım varyantları (tek çubuk, öneksiz, tam genişlik, kapanışsız) yalnızca elle yazılmış örneklerle test edildi. DSML'li bir cevabın OpenCode içinde uçtan uca çalıştığı ayrıca görülmedi.
- **Ara modelle:** `opencode run -m opencode/big-pickle --command ctf-danis`: plan DeepSeek'ten, işi diğer model yaptı, gözden geçirme aynı sohbette, öneri uygulandı (57 sn).
- **Mesaj uzunluğu (ölçüldü):** 60.000 karakter kabul, 90.000 ret ("Content is too long"). Sınır 60.000; retde yarıya kısaltıp bir kez daha denenir. OpenCode'un ilk mesajı ~23.000.
- **Giriş:** 2026-11-18'de kayıtlı giriş `INVALID_TOKEN` oldu (sebep bilinmiyor). Otomasyon kapılı giriş penceresinde DeepSeek captcha'sı doğru cevabı reddetti; `c2f giris` artık önce Chrome'daki açık oturumu (eklenti) kullanıyor (canlı: 10 sn, pencere yok), yoksa otomasyon bayraksız pencere açıp kapanınca okuyor. İkinci yol gerçek DeepSeek'e karşı denenmedi (yalnızca sahte sayfayla).

## Hız, arka plan ve dayanıklılık (v0.10.x)

- **Aynı sohbet:** görev boyunca site başına tek konuşma; sonraki turlar kısa devam mesajı. Yeni sohbet yalnızca zorunluysa.
- **Bekleme:** sabit uykular olay-güdümlüye çevrildi; sohbet öncesi bayat "stop" kontrolü yok sayılır; model düşünürken beklenir (en çok `requestTimeoutMs` = 30 dk); kota bildirimi anında yakalanır, site reset saatine kadar atlanır; gönderim öncesi sekme yoklanır. Her turun süreleri log'da.
- **Arka plan:** hiçbir pencere açılmaz/öne gelmez/odak çalınmaz (test: pencere sayısı, odak ve durum değişmiyor). Gemini için görünürlük düzeltmesi sahte "yalnız görünürken çizen" sayfada kanıtlı; gerçek sitede *tam gizli* sekmede henüz doğrulanmadı (canlı testteki Gemini sekmesi öndeydi). ChatGPT ve Claude arka planda çalışıyor (canlı: 7 tur / 39 s, aynı sohbet). **DeepSeek arka planda sohbeti çizmiyor** (canlı ölçüldü; görünürlük sahteleme dahil denenenler işe yaramadı; rAF/observer sahtelemesi kanıtsız olduğu için kaldırıldı) → varsayılan atlanır, `sites.deepseek.focusTab true` ile izin verilir.
- **Dayanıklılık:** eklenti işçisi yeniden başlasa cevap sekmeden teslim edilir (gerçek işçi durdurma testi, negatif kontrolle); köprü 3 dk bekler, aynı siteye tekrar sorar; build `.c2f/state.json` yazar, `--resume` ile kalan adımdan sürer; okunamayan cevaplar `.c2f/failed/` altına.
- **"Bitti" kararını kod verir:** planda adım başına `files` + isteğe bağlı `check`; DONE bu ikisi doğrulanmadan kabul edilmez, eksik adımlar yeniden açılır (`gapRounds`), son denetim planı görür, eksik kalırsa `finished_with_problems`. Canlı: ChatGPT planı `files`/`check` ile verdi, 3 adım 23 sn. Sebep: Minecraft build'inde adım 4-5 dosya yazmadan "done" demişti.
- **DeepSeek sekmesiz:** `c2f auth deepseek` giriş bilgisini bir kez kopyalar; sonra DeepSeek turları doğrudan HTTP ile gider (sekme/pencere/odak yok). Canlı doğrulandı: `c2f auth deepseek` giriş+PoW kabul edildi; tek mesaj 1,8 sn; küçük build 3 adım / 7 tur / 19 sn (tur başına 2-3 sn, aynı sohbette devam). Mock sunucuyla da test edilir. Özel API: değişirse kırılır, şartlara aykırı olabilir.
- **DeepSeek klasör başına sohbet:** her klasör/kullanım için ayrı web sohbeti, diskte saklanır, başlığı klasör yolu (mock ile test edildi; başlığın gerçek DeepSeek'te görünmesi ilk gerçek kullanımda doğrulanacak: boş sohbette `empty chat session` ile reddediyor, mesajdan sonra denenmedi).
- **Test hijyeni:** test tarayıcıları süreç ağacıyla kapanır, tek pencere kullanır.

## Model / reasoning / limit (2026-11-17)

Canlı ölçülen kontroller: `CONTROLS-MEASURED.md`. Durum:

| site | model | reasoning | canlı kanıt |
|---|---|---|---|
| Claude | Sonnet 5.5, Haiku 5.5 seçilebilir; Fable/Opus kilitli | Çaba: düşük → maksimum (5 seviye) | **canlı, v0.9.4:** orta→düşük, Sonnet→Haiku uygulandı ve siteden geri okundu; kilitli model gerekçesiyle reddedildi; hepsi eski haline döndü |
| Gemini | Otomatik; "Kod ve analiz" ücretli | Düşünme düzeyi: düşük / orta / yüksek | **canlı, v0.9.4:** seviye değişti + geri okundu + döndü; ücretli mod seçilince site yükseltme penceresi açıp eski seçimi koruyor, sürücü bunu "uygulanmadı" diye raporluyor, "Yükselt"e basmıyor |
| ChatGPT | ücretsiz planda seçici yok | `Düşünme` aç/kapa | **canlı, v0.9.3:** kapalı→açık→geri okundu→kapalı |
| DeepSeek | seçici yok | `Derin Düşünme` aç/kapa, `Akıllı Arama` aç/kapa | **canlı, v0.9.3:** ikisi açık→kapalı→geri okundu→açık |

Bu doğrulamalar ekran **kilitliyken** (tarayıcı pencereleri `hidden`) yapıldı: menü bekleyişleri
zamanlayıcıya değil DOM değişikliğine bağlı olduğu için çalışıyor.

**Uçtan uca canlı build (Claude, `reasoning=low`, v0.9.6):** tek adımlı plan, 4 tur, `hello.js`
yazıldı ve çalıştırınca `merhaba` basıyor; son denetim açık bir `### DONE` kararıyla bitti.
İlk koşuda (v0.9.4) iki gerçek hata çıktı ve düzeltildi:

| hata | kanıt | düzeltme |
|---|---|---|
| Claude'un her turunda 1×1 piksellik `sr-only` bir `<h3>` cevabın **tamamını** ("Claude yanıt verdi: …") tekrar ediyor; okuyucu onu cevaba katıyordu | canlı DOM ağacı (`probe` `tree` op) + 10 turun 3'ünde cevap `###` | gizli/clipped düğümler okunmuyor, `<time>` atlanıyor; `data-is-streaming` ve "Durdur" akış sinyali; yalnız `###` cevabı "bitti" sayılmıyor |
| Denetim cevabı boş/çöp olsa bile "adım tamam" deniyordu | `verify: step complete` log'u | yalnızca açık `### DONE` (veya düzeltmeler) karar sayılır; yoksa yeniden sorulur, olmazsa "inconclusive" yazılır; yarım kalan adımlar özette görünür |

Not: "yalnız `###`" koruması sahte sayfada ayrıca sınanmıyor (sr-only atlama sınanıyor ve kaldırılınca
test düşüyor); canlıdaki ikinci koşuda sorun görülmedi.

Tek komutla yeniden kanıtlanır (değiştir → geri oku → eski haline döndür; mesaj göndermez):

```bash
node src/live-settings.js     # 4 site; çalışamayan kontrol SKIPPED/FAIL olur, "geçti" denmez
```

**Hâlâ canlı kanıtı olmayan:** sert kullanım limiti (composer kapanması / limit bildirimi) gerçek
bir sitede görülmedi; ChatGPT'nin ücretsiz kotası yalnızca dosya/görseli kısıtlıyor ve bu
"limit" sayılmıyor. Davranış gerçek eklenti + sahte sayfalarla test edildi (`test/limit.test.js`).

## Herhangi bir sohbet modeline bağlanma

`chrome://extensions` → ChatToFree → **Ayrıntılar** → *Uzantı seçenekleri*:

1. Sohbet sitesini bu tarayıcıda aç
2. **Add the site in the active tab** düğmesine bas
3. Sayfada üç şeye tıkla: metin kutusu → gönder butonu → bir cevap

Kayıt `customSites` altında saklanır, kod değişikliği gerekmez. Yerleşik adaptörlerin üzerine
yazamaz, böylece hatalı bir kayıt çalışan bir siteyi bozamaz.

## Mimari

```
CLI (c2f) ──ws──► MV3 eklenti ──► content script ──► sitenin kendi arayüzü
                   │
                   └─ token + origin doğrulaması, tek istemci
```

Kod yazma protokolü: `### FILE path` + çitli gövde, `### RUN`, `### DONE`.

## Bilinen sınırlar

- **Sekme odağı**: DeepSeek ve Gemini cevabı yalnızca sekme görünürken render eder; adaptör
  `focusTab: true` ile bunu otomatik yapar (pencere öne gelir).
- **Site değişiklikleri**: seçiciler ölçülerek yazıldı; site DOM'u değişirse `node src/inspect.js`
  ile yeniden ölçülür. ChatGPT bir kez `data-message-author-role`'ü kaldırdı, artık
  `[data-dil-message-id]` kullanılıyor.
- **Giriş**: oturumlar senin Chrome profilinde; Cloudflare otomasyonu engellediği için giriş
  elle yapılır, sonrası otomatiktir.

## Komutlar

```bash
node src/cli.js build "bir snake oyunu yaz"   # planla + yaz + doğrula
node src/cli.js chat                          # serbest sohbet
node src/live-status.js                       # her sitenin durumu (salt-okunur, Chrome sekmelerine sorar)
node src/live-smoke.js                        # nonce ile 4 siteyi dene
node src/inspect.js chatgpt --any-path        # canlı DOM dökümü
node src/reload.js                            # eklentiyi uzaktan yeniden yükle
```
