# ASIN Redirect Checker

Syncrosale envanterindeki ASIN'lerin Amazon'da farklı bir varyasyona (farklı ASIN'e) yönlendirilip yönlendirilmediğini kontrol eden araç.

## Kurulum

```bash
cd asin-redirect-checker
npm install
```

## Kullanım

```bash
# Environment variable ile
STORE_ID=123 TOKEN=eyJhbG... node index.js

# Argüman ile
node index.js <storeId> <token>
```

### Token Nasıl Alınır?

1. Syncrosale'e giriş yap
2. Browser DevTools → Network tab
3. Herhangi bir API isteğinin `Authorization` header'ından `Bearer ...` kısmını kopyala

## Konfigürasyon

`index.js` dosyasının başındaki `CONFIG` objesinden ayarlar yapılabilir:

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `AMAZON_DOMAIN` | `amazon.com` | Amazon domain (com, ca, co.uk, vs.) |
| `REDIRECT_WAIT_MS` | `3000` | Yönlendirme bekleme süresi (ms) |
| `DELAY_BETWEEN_MS` | `1500` | İstekler arası bekleme (rate limit) |
| `PAGE_SIZE` | `100` | API'den sayfa başına çekilecek ürün |
| `MAX_PRODUCTS` | `null` | Kontrol edilecek max ürün (null = hepsi) |

## Çıktı

- Terminal'de özet rapor
- `results_<timestamp>.json` dosyasına detaylı kayıt

### Durum kodları

- **OK**: ASIN aynı kaldı
- **REDIRECTED**: Farklı ASIN'e yönlendirildi
- **CAPTCHA**: Amazon captcha gösterdi
- **ERROR**: Sayfa yüklenemedi

## Notlar

- Amazon bot algılama yapabilir, çok fazla istek atılırsa captcha çıkabilir
- Captcha çıkarsa `headless: false` yaparak browser'da manuel captcha çözülebilir
- `DELAY_BETWEEN_MS` artırılarak rate limit riski azaltılabilir
