# FilmFlix Relay — পাবলিক স্ট্রিমিং প্রক্সি (HLS রি-স্ট্রিমার)

লোকাল/প্রাইভেট IP-র HLS স্ট্রিম (যেমন `http://10.200.13.14/live/ch1/index.m3u8`) প্রক্সির নিজের
পাবলিক HTTPS ঠিকানায় রূপান্তর করে দেয় — ফলে **মোবাইল ডাটা বা যেকোনো নেটওয়ার্ক** থেকে ভিডিও চলে।
প্রাইভেট IP বা FTP ব্লক করা নেটওয়ার্কেও সমস্যা হয় না, কারণ দর্শক সরাসরি আর লোকাল IP-তে যায় না।

- কোনো `npm install` লাগে না — শুধু Node.js 18+ চাই (সবকিছু Node-এর বিল্ট-ইন মডিউলে লেখা)
- প্লেলিস্ট রিরাইট (master → variant → segment সব স্তরে), সেগমেন্ট ইন-মেমরি ক্যাশ
- N জন দর্শক = আপস্ট্রিমে ~১ বার ডাউনলোড
- **প্রগ্রেসিভ ভিডিও স্ট্রিমিং:** `/api/stream/<চ্যানেল>` — HTTP Range (206 Partial Content),
  `Accept-Ranges: bytes`, seek/resume সমর্থিত; আপস্ট্রিম টাইমআউট শুধু হেডার পর্যন্ত —
  বডি idle-watchdog দিয়ে চলে, তাই লম্বা সিনেমাও ১০ সেকেন্ডে কাটে না
- HTTPS হয় Nginx + Let's Encrypt দিয়ে (ফ্রি)

## আর্কিটেকচার

```
দর্শক (মোবাইল ডাটা / যেকোনো Wi-Fi)
      │  https://tv.example.com/c/news24?k=TOKEN     ← HLS চ্যানেল
      │  https://tv.example.com/api/stream/movie?k=TOKEN ← প্রগ্রেসিভ ভিডিও (seek/resume)
      ▼
Nginx (TLS) — এই VPS-এ
      │  http://127.0.0.1:8077
      ▼
relay.mjs (এই ফোল্ডার) — প্লেলিস্ট রিরাইট + সেগমেন্ট ক্যাশ
      │  http://10.200.13.14/live/...  ← শুধু ISP নেটওয়ার্কের ভেতর থেকেই পৌঁছানো যায়
      ▼
ISP-এর স্ট্রিম সোর্স
```

> জরুরি: এই VPS অবশ্যই সেই **লোকাল ISP-এর নেটওয়ার্কের ভেতরে** হতে হবে — নাহলে রিলে
> `10.200.13.14`-এ পৌঁছাতেই পারবে না। (VPS বাছাই নিয়ে আলোচনা নিচে "VPS বাছাই" অংশে।)

---

## ধাপ ০ — ভিডিও প্লেব্যাক টেস্ট (VPS-এর শেল থেকেই আগে দেখে নিন)

```bash
# আপস্ট্রিম প্লেলিস্ট পাওয়া যায় কি না:
curl -sS -H "Range: bytes=0-1023" http://10.200.13.14/live/news24/index.m3u8 | head
```

প্লেলিস্ট টেক্সট (`#EXTM3U` দিয়ে শুরু) দেখালে আপস্ট্রিম ঠিক আছে; না দেখালে রিলে বসালেও কাজ হবে না —
আগে সেটাই ঠিক করতে হবে (URL ভুল? পোর্ট ব্লকড? আলাদা User-Agent লাগে?)।

## ধাপ ১ — VPS প্রস্তুত ও ফাইল বসানো

```bash
sudo apt update && sudo apt install -y nodejs nginx certbot python3-certbot-nginx

# Node 20 দরকার হলে (উবুন্টুর ডিফল্ট পুরনো হলে):
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

sudo mkdir -p /opt/filmflix-relay
sudo cp relay.mjs channels.json relay.env relay.service /opt/filmflix-relay/
sudo chown -R www-data:www-data /opt/filmflix-relay
```

## ধাপ ২ — channels.json কনফিগার

`/opt/filmflix-relay/channels.json` এডিট করুন — এক লাইনে চ্যানেল-নাম → লোকাল URL:

```json
{
  "news24": "http://10.200.13.14/live/news24/index.m3u8",
  "sports1": "http://10.200.13.14/live/sports1/index.m3u8"
}
```

কিছু সোর্স আলাদা `User-Agent`/হেডার চাইলে অবজেক্ট ফরম্যাট:

```json
"movies-hd": {
  "url": "http://10.200.13.14/live/movies/index.m3u8",
  "headers": { "User-Agent": "SomePlayer/1.0" }
}
```

**চ্যানেল যোগ/বাদ দিলে রিস্টার্ট লাগে না** — রিলে ফাইল সেভ হলেই নতুন করে পড়ে নেয়।

## ধাপ ৩ — রিলে সেটআপ ও লোকাল টেস্ট

```bash
sudo cp .env.example /opt/filmflix-relay/relay.env
sudo nano /opt/filmflix-relay/relay.env   # RELAY_TOKEN সেট করুন (দীর্ঘ র‍্যান্ডম স্ট্রিং)

# অফলাইন সেলফ-টেস্ট (রুট হিসেবে, শুধু ভেরিফিকেশনের জন্য):
node /opt/filmflix-relay/selftest.mjs      # "SELFTEST PASSED" আসা চাই

# আসল টেস্ট (সাময়িকভাবে চালিয়ে দেখুন):
cd /opt/filmflix-relay && node relay.mjs
# অন্য টার্মিনালে:
curl -sS "http://127.0.0.1:8077/c/news24?k=YOUR-TOKEN" | head -5
```

প্লেলিস্ট এসে দেখলেন যেখানে প্রতিটি লাইন `http://127.0.0.1:8077/r/...` এ রূপান্তরিত — কাজ হচ্ছে।

## ধাপ ৪ — systemd দিয়ে সবসময় চালু

```bash
sudo cp relay.service /etc/systemd/system/filmflix-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now filmflix-relay
systemctl status filmflix-relay --no-pager
journalctl -u filmflix-relay -f          # লগ দেখতে
```

## ধাপ ৫ — Nginx + HTTPS

আগে ডোমেইনের একটা সাবডোমেইন (যেমন `tv.example.com`) দিয়ে **A রেকর্ড** → এই VPS-এর পাবলিক IP।
তারপর:

```bash
sudo cp nginx-relay.conf /etc/nginx/sites-available/relay
sudo nano /etc/nginx/sites-available/relay        # server_name বদলান
sudo ln -s /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/relay
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d tv.example.com            # ফ্রি HTTPS + অটো রিনিউ
```

## ধাপ ৬ — FilmFlix Admin-এ যুক্ত করা

চ্যানেলের **primary URL = পাবলিক প্রক্সি URL**, আর **backup URL = আগের লোকাল URL**:

| ফিল্ড | মান |
|---|---|
| Stream URL (primary) | `https://tv.example.com/c/news24?k=YOUR-TOKEN` |
| Backup URL ১ | `http://10.200.13.14/live/news24/index.m3u8` (লোকাল ISP-এর দর্শকদের জন্য) |

**প্রগ্রেসিভ ভিডিও (MP4/MKV ফাইল) হলে** primary হিসেবে `/api/stream/<চ্যানেল>` দিন —
তখন প্লেয়ার seek করলে Range রিকোয়েস্ট (206) ব্যবহার করবে আর resume-ও কাজ করবে:

```json
{
  "movie-hd": "http://10.16.100.213/files/movie.mp4"
}
```

→ অ্যাডমিনে primary: `https://tv.example.com/api/stream/movie-hd?k=YOUR-TOKEN`

(চ্যানেল কনফিগ যে URL-ই হোক, `.mp4`/`.mkv`-জাতীয় এক্সটেনশন দেখলে রিলে নিজে থেকেই
স্ট্রিম-মোডে চলে যায় — `/api/stream` স্পষ্ট বোঝানোর জন্য।)

ফেইলওভার আগে থেকেই বানানো — পাবলিক URL না চললে প্লেয়ার নিজেই ব্যাকআপে চলে যায়।

## Docker দিয়ে চালানো (এক কমান্ড)

systemd-এর বদলে Docker পছন্দ হলে — `Dockerfile` আর `docker-compose.yml` এই ফোল্ডারেই আছে:

```bash
# এই relay/ ফোল্ডারে থেকে (channels.json আগে এডিট করে নিন):
sudo docker compose up -d --build

# যাচাই:
curl -s http://127.0.0.1:8077/healthz          # -> ok
sudo docker compose logs -f relay
```

- কন্টেইনার ভেতরে `0.0.0.0:8077`-এ বাঁধে, কিন্তু হোস্টে খোলে শুধু `127.0.0.1:8077` — অর্থাৎ
  পাবলিক দিক থেকে ঢোকার রাস্তা শুধু Nginx-ই (ধাপ ৫), সরাসরি পোর্ট খোলা থাকে না
- `channels.json` ভলিউম হিসেবে মাউন্ট হয় — হোস্টে এডিট করলেই হট-রিলোড, রিবিল্ড/রিস্টার্ট লাগে না
- টোকেন ইত্যাদি সেট করতে: `cp .env.example relay.env`, এডিট করুন, তারপর compose ফাইলে
  `env_file` দুই লাইন কমেন্ট থেকে খুলে দিন এবং `sudo docker compose up -d` আবার চালান
- Nginx কনফিগ একই থাকে — `proxy_pass http://127.0.0.1:8077;` আগের মতোই কাজ করে

আপডেট নেওয়ার সময়: `git pull && sudo docker compose up -d --build`

## সমস্যা নির্ণয়

| লক্ষণ | কারণ | সমাধান |
|---|---|---|
| রিলে থেকেও 502 | VPS থেকে লোকাল IP পৌঁছায় না | VPS আসলেই ISP নেটের ভেতরে আছে কি না দেখুন; ধাপ ০-এর `curl` চালান |
| প্লেলিস্ট আসে, সেগমেন্টে 403/404 | সোর্স আলাদা হেডার/রেঞ্জ চায় | channels.json-এ `headers` ব্যবহার করুন |
| 403 Missing token | URL-এ `?k=` নেই | Admin-এ primary URL-এ টোকেনটা সহ রাখুন |
| ভিডিও লোড হয় কিন্তু লাগাতার লাগ | আপস্ট্রিম ধীর / ক্যাশ ছোট | `RELAY_CACHE_MAX_MB` বাড়ান, VPS-এর আপস্ট্রিম স্পিড দেখুন |
| দর্শক বাড়ার সাথে আপলোড চাপে | সবাই আলাদা সেগমেন্ট চাইছে | এটা স্বাভাবিক নয় — ক্যাশ হিট হলে আপলোড ~১× বিটরেটেই থাকে; বিটরেট বাড়লে সেটা মানে একসেট সেগমেন্ট শেয়ার হচ্ছে না, লগ দেখুন |

## VPS বাছাই

রিলে চলবে **যেকোনো লিনাক্স সার্ভারে**, যতক্ষণ সে সেই ISP-এর নেটওয়ার্কের ভেতরে `10.200.13.14` পিং করতে পারে:

- **লোকাল ISP-এর VPS/ক্লাউড প্যাকেজ** — এটাই সবচেয়ে ভালো পথ
- রাউটারে থাকা Raspberry Pi / ছোট মিনি-পিসি + সেখান থেকে বাইরের VPS-এ WireGuard টানেল
  (তখন relay.mjs + nginx দুটোই বাইরের VPS-এ, টানেল হয়ে লোকাল স্ট্রিমে পৌঁছায়)
- দানি একদিকে: এক VPS-এ relay + nginx + certbot — সব একসাথেই চলে

ব্যান্ডউইথ মোটামুটি হিসাব: ক্যাশের কল্যাণে VPS-এর **আপলোড** ≈ (এক সেট সেগমেন্ট বিটরেট × সক্রিয়
চ্যানেল) + প্রতি দর্শকের ডাউনলোড দরকার মতো হিসাব করে সেই সার্ভিস দিলেই চলে।

## ফাইল তালিকা

| ফাইল | কাজ |
|---|---|
| `relay.mjs` | রিলে সার্ভার (জিরো-ডিপেন্ডেন্সি, Node 18+) |
| `channels.json` | চ্যানেল কনফিগ (হট-রিলোড) |
| `.env.example` | কনফিগ নমুনা |
| `relay.service` | systemd ইউনিট |
| `nginx-relay.conf` | HTTPS সাইট কনফিগ |
| `selftest.mjs` | অফলাইন সেলফ-টেস্ট (HLS) |
| `streamtest.mjs` | অফলাইন রেঞ্জ-স্ট্রিমিং টেস্ট (206/seek/416/HEAD) |
| `demo-player.html` | লোকাল পরীক্ষার ডেমো প্লেয়ার |
| `Dockerfile` + `docker-compose.yml` | এক কমান্ডে Docker ডিপ্লয় |
