# ChatToFree — kullanım

1. Chrome'da DeepSeek'e giriş yap, sonra `Kur.bat`.
2. OpenCode'u kapatıp yeniden aç.
3. OpenCode'da istediğin modeli seç (yerel modelin, big-pickle, hangisi olursa) ve `/ctf_ask istek` yaz.
   Aynı şey: `ctf` ajanını seçip isteği doğrudan yazmak.

İşi kendi modelin yapar; ilerledikçe DeepSeek'e insan gibi danışır: ne yaptığını, ne olduğunu anlatır ve
tek bir soru sorar. Konuşmayı DeepSeek hesabında okuyabilirsin; adını DeepSeek kendisi verir. Aynı OpenCode oturumunda
yazdığın her `/ctf_ask` aynı DeepSeek sohbetinde devam eder; yeni bir OpenCode oturumu yeni sohbet açar.
Bunu OpenCode'a kurulan küçük bir eklenti sağlar (`~/.config/opencode/plugins/c2f-session.js`): her
danışmanın hangi OpenCode oturumundan geldiğini c2f'ye bildirir, model konuşma kimliğini unutsa bile.
Aynı mesaj kısa süre içinde ikinci kez gelirse (modeller bazen aynı çağrıyı tekrarlar) DeepSeek'e tekrar
gönderilmez, önceki cevap kullanılır.

Hesabı korumak için: mesaj başına en çok 30.000 karakter (bir dosya ya da sınıf; DeepSeek'in sınırı yaklaşık 40.000); iki mesaj arasında en az 15 sn, iki yeni sohbet
arasında en az 2 dk (beklenir, reddedilmez). Toplam mesaj sınırı yok: DeepSeek'in kotası belirler. Kota
dolunca o saate kadar mesaj gitmez ve ajan seni bilgilendirir.

Terminal: `c2f sohbet`, `c2f durum`, `c2f giris`.

**Kapalı olanlar:** `c2f yap`, `/ctf`, `c2f_build`, `c2f_chat` ve DeepSeek'i doğrudan model olarak seçmek.
Bunlar hesabı makine gibi kullanıyor ve 2026-11-18'de bir hesabın askıya alınmasına yol açtı. Açmak
istersen (kaybetmeyi göze aldığın bir hesapla): `c2f config set automation true`, sonra `c2f kur`.

Aşağısı ayrıntıdır.

# Başka oturumdan ChatToFree kullanma

ChatToFree makinede **tek bir servis** gibi çalışır: eklenti senin Chrome'unda yaşar, CLI ise
yalnızca 8787 numaralı yerel köprüye bağlanır. Yani herhangi bir terminal, script veya ajan
oturumu onu aynı şekilde sürebilir — proje dizininde olmak zorunda değilsin.

## Tek seferlik kurulum (her bilgisayarda)

1. Node.js 20+ ve OpenCode kurulu olsun.
2. Depoyu indir (`git clone https://github.com/yilmazhalilibr/ChatToFree` ya da GitHub'dan ZIP), istediğin
   klasöre koy. Klasör adında boşluk ya da Türkçe harf olabilir. Depo şu an gizli: indirmek için GitHub'da erişimin olmalı.
3. `Kur.bat`'a çift tıkla. Açılan pencerede **kendi** DeepSeek hesabına giriş yap ve pencereyi kapat.
   c2f kendini PATH'e ve OpenCode'a ekler, OpenCode masaüstünü yeniler.

Her bilgisayar kendi girişini alır. Giriş dosyası başka bir bilgisayara kopyalanırsa çalışmaz;
`c2f durum` "başka bir bilgisayarda alınmış" der, o bilgisayarda `c2f giris` yapılır. Mesaj aralıkları
ve bekleme süreleri her bilgisayarda ayrı tutulur; aynı hesabı aynı anda iki bilgisayarda kullanma.

Klasörü taşıdıysan ya da adını değiştirdiysen: yeni yerinde `Kur.bat`'ı bir kez daha çalıştır.
`c2f durum` eski yeri görünce bunu söyler. `Kur.bat` PATH'teki eski c2f klasörünü de kaldırır; eski bir
sürümün PATH'te ikiye katladığı ters eğik çizgileri düzeltir ve değiştirmeden önce eskisini
`%LOCALAPPDATA%\ChatToFree\path-backup-*.txt` olarak saklar.

## Kullanım

```bash
c2f build "bir snake oyunu yaz"      # planla → yaz → doğrula (onay ister)
c2f build --yes "..."                # onay sormadan
c2f chat                             # serbest sohbet
c2f doctor                           # bağlantı kontrolü
```

Çıktılar **komutu çalıştırdığın dizinin `out/` klasörüne** yazılır — başka bir projede
çalıştırırsan o projenin içine, ChatToFree deposuna değil. Sabit bir yer istersen:

```bash
c2f build --workspace D:\projeler\oyun "bir snake oyunu yaz"
```

veya çalıştığın dizine `c2f.config.json` koy:

```json
{ "workspace": "D:\\projeler\\oyun" }
```

## Model, reasoning ve limit ayarları

Her site ayrı ayarlanır; ayarlar bir kez kaydedilir ve **her terminalde/oturumda** geçerlidir
(`%LOCALAPPDATA%\ChatToFree\config.json`). Proje bazlı geçersiz kılmak için `--local`.

```bash
c2f models                                         # her sitenin şu an sunduğu modeller/seviyeler (● seçili)
c2f use claude --model "Haiku 5.5" --reasoning low --per-hour 20 --per-day 100
c2f use gemini --reasoning high                    # Gemini "Düşünme düzeyi"
c2f use chatgpt --reasoning on                     # ChatGPT'de yalnızca aç/kapa var
c2f use deepseek --reasoning off --search off
c2f use chatgpt --disable                          # siteyi kullanma
c2f config set phases.design.reasoning high        # sadece tasarım aşamasında daha çok düşünsün
c2f config set phases.design.sites claude,gemini   # tasarımı yalnızca bu sitelere sor
c2f config                                         # hepsini göster
c2f apply                                          # ayarları şimdi uygula, mesaj göndermeden
c2f usage                                          # harcanan istek, bekleme süreleri (--reset claude)
c2f build "..." --site claude --model "Sonnet 5.5" --reasoning high   # yalnızca bu çalıştırma
```

- Bir model hesapta yoksa / ücretli plan istiyorsa reddedilir ve mevcut olanlar listelenir; istenen
  reasoning seviyesi yoksa **bir alt** seviye kullanılır (asla üstü değil). Hepsi `! site: …` diye yazılır.
- Site "kullanım limitine ulaştım" derse (composer kapanır ya da limit bildirimi çıkar) o site
  söylediği saate kadar (ya da `cooldownMinutes`) beklemeye alınır, sıradaki site cevaplar.
  Yalnızca dosya/görsel kısıtını bildiren bir uyarı siteyi beklemeye **almaz**: metin sohbeti sürer.
- Menüleri sürmek için sekme birkaç saniye öne gelir (küçültülmüş pencere geri açılır). Ekran
  kilitliyken de çalışır (bekleyişler DOM değişikliğine bağlı). Bir ayar adımı takılırsa 25 sn
  sonra sebebiyle birlikte vazgeçilir ve sohbet çalışmaya devam eder.
- Doğrulamak için: `node src/live-settings.js` (değiştirir, geri okur, eski haline döndürür).

## Hız, oturum ve dayanıklılık

- **Aynı sohbet, aynı model:** bir görev boyunca her site için tek konuşma açılır; sonraki turlar
  kısa devam mesajıdır. Yeni sohbet / başka site ancak zorunluysa (limit, giriş, bağlam kaybı,
  `sessionMaxChars` doluluğu).
- **Bekleme sadece modelin düşünmesi için:** kota bitince saniyeler içinde anlaşılır, site reset
  saatine kadar atlanır; gönderimden önce sekme yoklanır (`preflight`). Her turun süreleri log'da.
- **Bilgisayarını kullanmaz:** hiçbir pencere açılmaz, öne gelmez, odak çalınmaz. ChatGPT, Claude ve
  Gemini arka plan sekmesinde çalışır. **DeepSeek arka planda sohbeti hiç çizmiyor** (canlı ölçüldü),
  bu yüzden varsayılan olarak atlanır; sekmesinin öne gelmesine izin vermek istersen:
  `c2f config set sites.deepseek.focusTab true`. Modellerin gönderdiği ekranda pencere açacak komutlar
  (`start index.html`, `explorer`, `open`, tarayıcı, `--open`) çalıştırılmaz, atlanır.
- **Bağlantı kopsa da kaybolmaz:** eklenti işçisi yeniden başlasa cevap sekmeden teslim edilir;
  köprü 3 dk bekler, aynı siteye tekrar sorar. Hiçbir model yoksa biten adımlar kalır:
  `c2f build "<aynı istek>" --resume` (OpenCode'da `c2f_build` + `resume: true`) kaldığı adımdan devam eder.
  Okunamayan cevaplar `out/.c2f/failed/` altına kaydedilir.
- **OpenCode'da ilerleme:** `c2f_build` 120 sn'de bir faz bilgisiyle döner; ajan her dönüşte kullanıcıya
  hangi fazda olduğunu söyler (`/ctf` komutu bunu ister).

## Danışman modu (`ctf` ajanı, `/ctf_ask`)

`c2f kur`'dan sonra OpenCode'daki yeni oturumlar `ctf` ajanıyla açılır: istediğin modeli seç ve
isteğini yaz. Model işi kendi yapar; başlamadan önce ve gerçek iş parçalarından sonra DeepSeek'e danışır.
Kısa bir soru ya da küçük bir düzeltme için danışmaz. Başka bir ajandayken `/ctf_ask istek` tek seferlik
aynı şeyi yapar; komut yalnızca senin yazdığını iletir, kurallar ajanın gizli talimatındadır.
Varsayılanı kapatmak için: `c2f config set ctfDefault false`, sonra `c2f kur`.

Model işin sahibi gibi, birinci tekil kişiyle yazar ("Şöyle bir şey yapmak istiyorum, sence nasıl
yapabilirim?"); "Kullanıcı … istiyor" diye yazılmış bir mesaj gönderilmeden reddedilir. Aynı OpenCode
oturumundaki bütün danışmalar DeepSeek'te tek sohbette ilerler; yeni oturum yeni sohbet açar.
OpenCode dışındaki araçlar için README'deki "Başka bir harness ya da model" bölümüne bak
(`c2f danis`, `c2f kurallar`).

Model ayrıca:
- İlk çalışan sürümden sonra ve yapı değiştikçe sistemi DeepSeek'e anlatır: klasörler, kodun nasıl
  bölündüğü, kullanılan teknoloji ve nedeni. Düzeltilmesi gereken bir şey varsa düzeltir.
- Yazdığı her programa tek anahtarla açılıp kapanan bir hata ayıklama katmanı koyar (ör. `APP_DEBUG=1`).
  Kapalıyken iş yapmaz; açıkken her satır hangi kod bloğundan geldiğini söyler (`[storage.save] ...`).
  Bir hata çıktığında anahtarı açar, hatanın hangi blokta olduğunu bulur; çözemezse DeepSeek'e o bloğun
  adı, ilgili birkaç satır ve hata mesajıyla danışır.

## "Bitti" kararını kod verir

Model `### DONE` yazması yetmez: planda adımın `files` (üreteceği dosyalar) ve isteğe bağlı `check`
komutu vardır; dosyalar yoksa ya da `check` geçmiyorsa DONE reddedilir ve model neyin eksik olduğunu
duyar. Adımlar bittikten sonra hâlâ eksik dosyası olan adımlar yeniden açılır (`gapRounds`, varsayılan 2),
son denetim planı görür, eksik kalırsa sonuç `finished_with_problems` olur ve eksikler listelenir.

## OpenCode'dan kullanma (yalnızca bu proje)

`opencode.jsonc` bu depoda `src/mcp.js`'i `c2f` MCP sunucusu olarak tanımlar; global ayara dokunulmaz.
OpenCode'un **ücretsiz modeli** yönetir, ChatGPT/Claude/Gemini/DeepSeek senin tarayıcında çalışır.

```bash
cd <ChatToFree klasörü>
opencode mcp list                                  # c2f connected
opencode run -m opencode/big-pickle "c2f_status çağır"
opencode                                           # içinde:  /ctf basit bir snake oyunu yap
```

**Her klasörden:** aynı tanım kullanıcı düzeyinde de var (`~/.config/opencode/opencode.jsonc`:
`mcp.c2f` mutlak yolla, `permission` ve 30 dk `timeout`; komut `~/.config/opencode/command/ctf.md`).
OpenCode'u hangi klasörde açarsan sunucu orada başlar ve `c2f_build` çıktısını o klasörün `out/` altına yazar.
OpenCode güncellenince bu iki dosyayı kontrol et; yedek: `opencode.jsonc.bak-before-c2f`.

Araçlar: `c2f_status`, `c2f_models`, `c2f_use`, `c2f_config`, `c2f_usage` (hepsi bedava),
`c2f_chat`, `c2f_build`, `c2f_job` (**hesap kotası harcar; OpenCode her seferinde onay ister**).
Köprü portu (8787) yalnızca iş yaparken tutulur, 90 sn boşta kalınca bırakılır; terminaldeki
`c2f` ile aynı anda çalıştırma, ikisi aynı portu isteyemez.

## Aynı anda birden fazla oturum

- Köprü **tek istemci** kabul eder; ikinci bir `c2f build` çalışırken birincisi bekler.
- Uzun süre açık tutmak için `c2f serve` kullan: köprü ayakta kalır, sonraki komutlar anında bağlanır.
- Eklenti uykuya dalmışsa `c2f doctor` 35 saniyeye kadar bekler (worker uyanma penceresi).

## Başka bir ajan oturumuna talimat

Ajan oturumunun başına şunu koy:

> Bu makinede `c2f` kurulu. Web sohbet modellerine (ChatGPT/Claude/Gemini/DeepSeek veya
> kaydedilmiş herhangi bir site) kod yazdırmak için `c2f build "<istek>"` çalıştır; çıktı
> **çalıştırdığın dizinin `out/` klasörüne** yazılır. Sabit bir hedef için
> `--workspace <dizin>` ver. Bağlantı sorununda `c2f doctor`, DOM değiştiyse
> `node <ChatToFree klasörü>\src\inspect.js <site> --any-path`.

## Eklenti tarafı (tek seferlik, tarayıcıda)

`chrome://extensions` → Developer mode → **Load unpacked** → `<ChatToFree klasörü>\extension`.
Token gerekmez: `extension/bridge-token.json` içinde. Yeni bir site eklemek için options
sayfasındaki **Add the site in the active tab** düğmesi (metin kutusu → gönder → bir cevap).

Kod değişikliğinden sonra eklentiyi elle yenilemek gerekmez:

```bash
node src/reload.js
```
