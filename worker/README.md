# FilmFlix on Cloudflare (D1 + Workers)

এই ফোল্ডারে পুরো ব্যাকএন্ডের **Cloudflare ভার্সন** — Convex-এর বিকল্প।
ফ্রন্টএন্ড এখনো Convex-এই চলছে; সুইচ করতে নিচের ধাপ ৪ দেখুন।

## আর্কিটেকচার

```
React অ্যাপ (film.freebuff.app)
      │  REST + Bearer session token
      ▼
filmflix-api Worker (এই ফোল্ডার) ── D1 (SQL) ── সব টেবিল
      │                              └─ R2 (dub ফাইল)
      └─ Cron (প্রতি ৬ ঘণ্টা): লিংক-হেলথ চেক
```

কভার করা সবকিছু: ইমেইল-OTP লগইন + গেস্ট সেশন, অ্যাডমিন কোড/রোল, মুভি CRUD,
ক্যাটাগরি, কমেন্ট, স্ক্রিনিং, অর্ডার, ওয়াচলিস্ট, টিভি চ্যানেল, অ্যানালিটিক্স,
শর্টলিংক রিরাইট, লিংক-হেলথ (ম্যানুয়াল + ক্রন), ElevenLabs ডাবিং (R2-তে ফাইল)।

## ধাপ ০ — একবার লগইন

```bash
npx wrangler login
```

## ধাপ ১ — D1 ডেটাবেস + R2 বাকেট

```bash
npx wrangler d1 create filmflix-hub
# → যে database_id আসবে সেটা worker/wrangler.jsonc-এ বসান

npx wrangler r2 bucket create filmflix-dubs

npx wrangler d1 execute filmflix-hub --remote --file=./schema.sql
```

## ধাপ ২ — সিক্রেট

```bash
npx wrangler secret put ADMIN_ACCESS_CODE     # অ্যাডমিন আনলক কোড
npx wrangler secret put ELEVENLABS_API_KEY    # AI ডাবিং (ঐচ্ছিক)
```

ইমেইল OTP আগের মতোই ফ্রিবাফ সার্ভিস দিয়ে যায় — নতুন কিছু লাগে না।

## ধাপ ৩ — ডিপ্লয় (অটো, Workers Builds) — ✅ সংযুক্ত

`main`-এ push করলেই Cloudflare নিজে থেকে deploy করে। Dashboard:
Workers & Pages → **filmflix-hub** → Settings → Builds

| সেটিং | মান |
| --- | --- |
| Git repository | `nlnazmulchowdhury-blip/filmflix-hub` |
| Production branch | `main` |
| Build command | `npm ci` (worker `hono`/`hono/cors` import করে; root `package.json`-এ আছে) |
| Deploy command | `npx wrangler@4 deploy` |
| **Root directory** | **খালি (repo root)** — নিচের নোট দেখুন |
| Build watch paths | `worker/**`, `wrangler.jsonc` |

**Root directory কেন খালি:** root-এর `wrangler.jsonc` name `filmflix-hub` দেয় — ওটাই লাইভ সার্ভিস।
`worker/` দিলে wrangler `worker/wrangler.jsonc` ব্যবহার করবে, যার name `filmflix-api` — অর্থাৎ
ভিন্ন Worker-এ deploy হয়ে যাবে।

হাতে দরকার হলে (repo root থেকেই, যেন root config পড়া হয়):

```bash
npx wrangler deploy          # → https://filmflix-hub.<আপনার-সাবডোমেইন>.workers.dev
npx wrangler deploy --dry-run --outdir /tmp/wf-dry   # build যাচাই, কিছু publish না করে
```

Secrets (`ADMIN_ACCESS_CODE`, `ELEVENLABS_API_KEY`, `RESEND_API_KEY`), D1 binding আর
cron triggers Cloudflare-এ থাকে — build সেগুলো স্পর্শ করে না।

> তিনটি deploy আলাদা চলে: **frontend** = Pages project `filmbd` (Git-connected, push-এ অটো),
> **এই Worker** = Workers Builds (push-এ অটো), **backend functions** = Convex
> (`.github/workflows/deploy-convex.yml`, `CONVEX_DEPLOY_KEY` secret দিয়ে)।

## ধাপ ৪ — ফ্রন্টএন্ড সুইচ (ফিরে আসার পথ খোলা)

`.env.local`-এ (বা হোস্টিং ভ্যারিয়েবলে) যোগ করুন:

```
VITE_API_BASE=https://filmflix-api.<আপনার-সাবডোমেইন>.workers.dev
```

- **ভ্যারিয়েবল না দিলে** অ্যাপ আগের মতো Convex-এই চলবে — কিছুই ভাঙবে না
- ভ্যারিয়েবল দিলে অ্যাপ Worker API-তে চলবে (এখনো ইমপ্লিমেন্ট হচ্ছে — `use-auth-cf`
  আর `src/lib/api.ts` প্রস্তুত; পেজগুলোর সুইচিং পরের ধাপে)

## ধাপ ৫ — ডেটা মাইগ্রেশন (Convex → D1) — ✅ সম্পন্ন

```bash
npx convex export --path scripts/data-export.zip
cd scripts && unzip -o data-export.zip -d export && cd ..
node scripts/import-d1.mjs            # ড্রাই-রান (SQL জেনারেট)
node scripts/import-d1.mjs --apply    # রিমোট D1-তে পুশ
```

রি-রান নিরাপদ (INSERT OR REPLACE)। এক্সপোর্ট ফাইলগুলো gitignore-এ — কমিট হয় না।

## নোট

- **OTP ইমেইল:** আগের সার্ভিস (`auth.freebuff.app/send_otp`) Worker থেকেও ডাকা হয় — ব্যবহারকারী কিছু বুঝবে না
- **সেশন:** লম্বা-জীবনী Bearer টোকেন (sha256 হ্যাশ করে D1-এ), ৩০ দিন মেয়াদ
- **রিয়েল-টাইম:** D1-এ লাইভ সাবস্ক্রিপশন নেই — অ্যাডমিন ডেটা ৩০–৬০ সেকেন্ড পোলিংয়ে রিফ্রেশ হবে
- **ফিরে আসা:** `VITE_API_BASE` সরিয়ে দিলেই অ্যাপ আবার Convex-এ
