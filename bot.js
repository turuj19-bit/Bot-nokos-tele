/**
 * ============================================================
 *  PEDIA OTP — Bot Telegram Nokos / OTP (versi user)
 *  Stack : Node.js 22 + grammy + Supabase + API dibanana.id + Paymenku (QRIS)
 * ============================================================
 *
 *  TOKEN / API KEY: dibaca dari file .env di VPS (dibuat otomatis oleh script install VPS).
 *    BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BANANA_API_KEY, PAYMENKU_API_KEY
 *    opsional: PAYMENKU_BASE_URL, ADMIN_IDS, QRIS_FEE_PERSEN
 *    JANGAN tulis key asli di file ini / di GitHub.
 *
 *  TABEL SUPABASE TAMBAHAN (buat dulu sebelum menu Deposit dipakai):
 *    create table otp_deposits (
 *      id bigint generated always as identity primary key,
 *      user_id bigint not null,
 *      invoice_id text not null,
 *      nominal bigint not null,
 *      fee bigint not null default 0,
 *      total bigint not null,
 *      status text not null default 'pending',   -- pending | paid | expired | cancelled | failed
 *      -- invoice_id = trx_id transaksi Paymenku (IDPxxxx)
 *      chat_id bigint not null,
 *      message_id bigint,
 *      expired_at timestamptz,
 *      created_at timestamptz not null default now(),
 *      updated_at timestamptz not null default now()
 *    );
 *
 *  INSTALL :  npm i grammy @supabase/supabase-js dotenv
 *  JALANKAN:  pm2 start bot.js --name pedia-otp
 * ============================================================
 */
'use strict';
require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

/* ============================ KONFIGURASI ============================ */
// Token & API key TIDAK ditulis di file ini (supaya aman di GitHub). Semuanya dibaca dari file .env di VPS,
// yang dibuat otomatis oleh script install VPS (bagian "ISI DI SINI").
const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BANANA_API_KEY, PAYMENKU_API_KEY } = process.env;
const PAYMENKU_BASE_URL = process.env.PAYMENKU_BASE_URL || 'https://paymenku.com/api/v1';
const ADMIN_ALERT_ID = 7607446655; // notifikasi saldo pusat HANYA ke admin ini
const ADMIN_IDS = [...new Set([...(process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean), ADMIN_ALERT_ID])];
const QRIS_FEE_PERSEN = Number(process.env.QRIS_FEE_PERSEN ?? 0.7);   // biaya QRIS dibebankan ke user (%)

for (const [k, v] of Object.entries({ BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BANANA_API_KEY, PAYMENKU_API_KEY })) {
  if (!v) { console.error(`❌ .env belum lengkap: ${k} kosong`); process.exit(1); }
}

const BRAND = 'PEDIA OTP';
const TAGLINE = 'Layanan Nomor OTP Instan &amp; Terpercaya';
const CHANNEL_URL = 'https://t.me/pediaotp';
const CS_URL = 'https://t.me/farishost1';   // chat admin / CS

// Menu Monitor (siaran real-time OTP & deposit) & menu Cek Nomor
const MONITOR_CHANNEL_URL = 'https://t.me/monitornokos';
const MONITOR_CHANNEL_ID = ('@' + MONITOR_CHANNEL_URL.replace(/^https?:\/\/t\.me\//, ''));   // bot wajib admin di channel ini
const CEKNOMOR_URL = 'https://t.me/Ceknomerdisini_bot';

const BN_BASE = 'https://dibanana.id/api/v1';
const CANCEL_WAIT_S = 122;  // aturan pusat: batal baru bisa 120 detik setelah order (+2 dtk cadangan)
const POLL_MS = 5000;      // jeda cek OTP ke dibanana.id
const PER_PAGE = 12;       // tombol per halaman (layanan / harga)
const HIST_PER_PAGE = 8;   // riwayat per halaman
const LINE = '━━━━━━━━━━━━━━━━━━';

// Server yang dijual (kode = parameter "server" di API dibanana.id)
const SERVERS = {
  ekonomi: { label: '💰 Ekonomi', name: 'Ekonomi', desc: 'Stok banyak, harga murah' },
  premium: { label: '👑 Premium', name: 'Premium', desc: 'Stok banyak, harga bersaing, OTP rate sangat tinggi' },
  khusus:  { label: '⭐ Khusus',  name: 'Khusus',  desc: 'Stok sangat melimpah, harga murah, lengkap pilihan produknya' },
  wa_luar: { label: '🌍 Luar Negeri', name: 'Luar Negeri', desc: 'Nomor internasional sesuai negara yang dipilih' },
};
const SERVERS_ID = ['ekonomi', 'premium', 'khusus'];              // menu Nomor Indonesia
const SERVERS_EX = ['wa_luar'];                                  // API pusat: server khusus nomor luar negeri

/* ------------------------------------------------------------------
 *  DAFTAR NEGARA (otomatis)
 *  Bot mengecek sendiri negara yang punya stok di tiap server lewat API
 *  dibanana.id (hanya baca harga, tidak beli / potong saldo). Hasilnya
 *  disimpan di negara.json dan diperbarui otomatis tiap 24 jam.
 *  Admin bisa paksa perbarui dengan perintah /updatenegara.
 *  Sebelum pengecekan pertama selesai, daftar bawaan di bawah dipakai.
 * ------------------------------------------------------------------ */
const FALLBACK_CODES = ['my', 'sg', 'us', 'uk', 'th', 'vn', 'ph', 'in', 'kh', 'mm', 'hk', 'cn', 'jp', 'kr', 'au', 'ca',
  'ru', 'ua', 'tr', 'sa', 'ae', 'eg', 'ng', 'ke', 'pk', 'bd', 'br', 'mx', 'de', 'fr', 'es', 'it', 'nl', 'pl'];
const NEGARA_FILE = path.join(__dirname, 'negara.json');
const dnId = new Intl.DisplayNames(['id'], { type: 'region', fallback: 'none' });
const flagOf = (cc) => String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
// Hanya kode negara ISO 3166-1 yang benar-benar punya emoji bendera resmi.
// Ini mencegah kode "hantu"/historis (mis. reserved code lama) muncul sebagai
// bendera putih + tanda tanya di HP, karena kode itu tidak punya glyph bendera.
const VALID_CC = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
  'DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET',
  'FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT',
  'JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ',
  'OM',
  'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY',
  'QA',
  'RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ',
  'VA','VC','VE','VG','VI','VN','VU',
  'WF','WS',
  'XK',
  'YE','YT',
  'ZA','ZM','ZW',
]);
/* ------------------------------------------------------------------
 *  NEGARA SESUAI WEB PUSAT (dibanana.id -> "Layanan Luar Negeri")
 *  Semua negara di daftar web pusat WAJIB muncul di menu Nomor Luar Negeri,
 *  dengan nama yang sama persis seperti di web. Daftar hasil pengecekan otomatis
 *  tetap dipakai & digabung (negara tambahan di luar daftar ini tetap muncul).
 * ------------------------------------------------------------------ */
const WEB_COUNTRIES = [
  ['AF', 'Afganistan'], ['ZA', 'Afrika Selatan'], ['DZ', 'Aljazair'], ['US', 'Amerika Serikat'], ['SA', 'Arab Saudi'],
  ['AR', 'Argentina'], ['AM', 'Armenia'], ['AU', 'Australia'], ['AT', 'Austria'], ['AZ', 'Azerbaijan'],
  ['BH', 'Bahrain'], ['BD', 'Bangladesh'], ['NL', 'Belanda'], ['BY', 'Belarus'], ['BE', 'Belgia'],
  ['BO', 'Bolivia'], ['BR', 'Brasil'], ['BG', 'Bulgaria'], ['CL', 'Chili'], ['DK', 'Denmark'],
  ['EC', 'Ekuador'], ['EE', 'Estonia'], ['ET', 'Etiopia'], ['PH', 'Filipina'], ['FI', 'Finlandia'],
  ['GE', 'Georgia'], ['GH', 'Ghana'], ['HK', 'Hong Kong'], ['HU', 'Hungaria'], ['IN', 'India'],
  ['UK', 'Inggris Raya'], ['IQ', 'Irak'], ['IR', 'Iran'], ['IE', 'Irlandia'], ['IL', 'Israel'],
  ['IT', 'Italia'], ['JP', 'Jepang'], ['DE', 'Jerman'], ['KH', 'Kamboja'], ['CM', 'Kamerun'],
  ['CA', 'Kanada'], ['KZ', 'Kazakhstan'], ['KE', 'Kenya'], ['KG', 'Kirgizstan'], ['CO', 'Kolombia'],
  ['KR', 'Korea Selatan'], ['HR', 'Kroasia'], ['KW', 'Kuwait'], ['LA', 'Laos'], ['LV', 'Latvia'],
  ['LB', 'Lebanon'], ['LT', 'Lituania'], ['MY', 'Malaysia'], ['MA', 'Maroko'], ['MX', 'Meksiko'],
  ['EG', 'Mesir'], ['MD', 'Moldova'], ['MN', 'Mongolia'], ['MM', 'Myanmar'], ['NP', 'Nepal'],
  ['NG', 'Nigeria'], ['NO', 'Norwegia'], ['OM', 'Oman'], ['PK', 'Pakistan'], ['CI', 'Pantai Gading'],
  ['PY', 'Paraguay'], ['PE', 'Peru'], ['PL', 'Polandia'], ['PT', 'Portugal'], ['FR', 'Prancis'],
  ['QA', 'Qatar'], ['CZ', 'Republik Ceko'], ['RO', 'Romania'], ['RU', 'Rusia'], ['NZ', 'Selandia Baru'],
  ['SN', 'Senegal'], ['RS', 'Serbia'], ['SG', 'Singapura'], ['SK', 'Slovakia'], ['SI', 'Slovenia'],
  ['ES', 'Spanyol'], ['LK', 'Sri Lanka'], ['SE', 'Swedia'], ['CH', 'Swiss'], ['TW', 'Taiwan'],
  ['TZ', 'Tanzania'], ['TH', 'Thailand'], ['CN', 'Tiongkok'], ['TN', 'Tunisia'], ['TR', 'Turki'],
  ['UG', 'Uganda'], ['UA', 'Ukraina'], ['AE', 'Uni Emirat Arab'], ['UY', 'Uruguay'], ['UZ', 'Uzbekistan'],
  ['VE', 'Venezuela'], ['VN', 'Vietnam'], ['JO', 'Yordania'], ['GR', 'Yunani'],
];
const WEB_CODES = WEB_COUNTRIES.map((c) => c[0].toLowerCase());
const WEB_NAME = new Map(WEB_COUNTRIES.map(([c, n]) => [c === 'UK' ? 'GB' : c, n]));

/* Kode telepon tiap negara -> dipakai untuk MEMASTIKAN nomor yang diterima benar-benar
 * dari negara yang dipilih user (bukan +62 / negara lain). Negara yang tidak ada di tabel
 * ini tidak diperiksa prefix-nya (tapi nomor +62 tetap selalu ditolak untuk negara asing). */
const DIAL = {
  AF: '93', ZA: '27', DZ: '213', SA: '966', AR: '54', AM: '374', AU: '61', AT: '43', AZ: '994', BH: '973',
  BD: '880', NL: '31', BY: '375', BE: '32', BO: '591', BR: '55', BG: '359', CL: '56', DK: '45', EC: '593',
  EE: '372', ET: '251', PH: '63', FI: '358', GE: '995', GH: '233', HK: '852', HU: '36', IN: '91', GB: '44',
  IQ: '964', IR: '98', IE: '353', IL: '972', IT: '39', JP: '81', DE: '49', KH: '855', CM: '237', KE: '254',
  KG: '996', CO: '57', KR: '82', HR: '385', KW: '965', LA: '856', LV: '371', LB: '961', LT: '370', MY: '60',
  MA: '212', MX: '52', EG: '20', MD: '373', MN: '976', MM: '95', NP: '977', NG: '234', NO: '47', OM: '968',
  PK: '92', CI: '225', PY: '595', PE: '51', PL: '48', PT: '351', FR: '33', QA: '974', CZ: '420', RO: '40',
  NZ: '64', SN: '221', RS: '381', SG: '65', SK: '421', SI: '386', ES: '34', LK: '94', SE: '46', CH: '41',
  TW: '886', TZ: '255', TH: '66', CN: '86', TN: '216', TR: '90', UG: '256', UA: '380', AE: '971', UY: '598',
  UZ: '998', VE: '58', VN: '84', JO: '962', GR: '30',
};
// +1 dipakai bersama Amerika Serikat & Kanada -> dibedakan lewat kode area Kanada
const CA_AREA = new Set(['204', '226', '236', '249', '250', '257', '263', '289', '306', '343', '354', '365', '367', '368',
  '382', '403', '416', '418', '431', '437', '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584',
  '587', '604', '613', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780', '782', '807', '819', '825',
  '867', '873', '902', '905', '942']);
// true = nomor cocok dengan negara yang diminta
function phoneMatchesCountry(phone, country) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return false;
  if (!country || String(country).toLowerCase() === 'id') return true;
  if (d.startsWith('62')) return false;                       // nomor Indonesia tidak boleh lolos sebagai negara asing
  let cc = String(country).toUpperCase();
  if (cc === 'UK') cc = 'GB';
  if (cc === 'US') return d.startsWith('1') && !CA_AREA.has(d.slice(1, 4));
  if (cc === 'CA') return d.startsWith('1') && CA_AREA.has(d.slice(1, 4));
  if (cc === 'RU') return /^7(?![67])/.test(d);
  if (cc === 'KZ') return /^7[67]/.test(d);
  const dial = DIAL[cc];
  return dial ? d.startsWith(dial) : true;
}

function countryInfo(code) {           // -> [kode, bendera, nama] atau null untuk Indonesia / kode tak valid
  if (!code || code === 'id') return null;
  let cc = String(code).toUpperCase();
  if (cc === 'UK') cc = 'GB';
  if (!VALID_CC.has(cc)) return null;
  let n; try { n = dnId.of(cc); } catch { n = undefined; }
  return [code, flagOf(cc), WEB_NAME.get(cc) || (n && n !== cc ? n : cc)];
}
let negaraDb = {};                     // { at, ekonomi:[kode], premium:[kode], khusus:[kode] }
try {
  const j = JSON.parse(fs.readFileSync(NEGARA_FILE, 'utf8'));
  if (j && !Array.isArray(j)) negaraDb = j;
} catch { /* belum ada */ }
// v2 = daftar yang sudah divalidasi (lihat VALIDASI NEGARA). Daftar lama (tanpa v) berisi
// hampir semua negara karena API mengembalikan produk Indonesia -> dibuang & dicek ulang otomatis.
const NEGARA_VER = 3;
if (negaraDb.v !== NEGARA_VER) negaraDb = {};
function markBadCountry(server, cc) {     // negara yang terbukti memberi nomor +62 disembunyikan
  const code = String(cc).toLowerCase();
  negaraDb.bad = negaraDb.bad || {};
  negaraDb.bad[server] = [...new Set([...(negaraDb.bad[server] || []), code])];
  if (Array.isArray(negaraDb[server])) negaraDb[server] = negaraDb[server].filter((c) => c !== code);
  try { fs.writeFileSync(NEGARA_FILE, JSON.stringify(negaraDb)); } catch { /* abaikan */ }
}
// negara hanya tampil kalau awalan nomornya bisa dicek (supaya nomor yang masuk pasti sesuai negara)
function canVerifyPhone(code) {
  let cc = String(code).toUpperCase();
  if (cc === 'UK') cc = 'GB';
  return ['US', 'CA', 'RU', 'KZ'].includes(cc) || !!DIAL[cc];
}
function countryEntries(server) {
  const bad = negaraDb.bad?.[server] || [];
  // pakai daftar hasil pengecekan stok; sebelum pengecekan pertama selesai, pakai daftar web
  const checked = Array.isArray(negaraDb[server]) && negaraDb[server].length ? negaraDb[server] : WEB_CODES;
  let codes = [...new Set(checked.map((c) => String(c).toLowerCase()))].filter((c) => !bad.includes(c) && canVerifyPhone(c));
  if (codes.includes('gb') && codes.includes('uk')) codes = codes.filter((c) => c !== 'uk');
  return codes.map(countryInfo).filter(Boolean).sort((a, b) => a[2].localeCompare(b[2], 'id'));
}

const CAND = [...VALID_CC, 'UK'].filter((c) => c !== 'ID');   // 'UK' ikut dicek (sebagian API memakai kode uk)

let negaraRunning = false;
async function probeServices(server) {   // kode layanan populer (WA, Telegram, FB, IG, TikTok, Google) untuk cek stok negara
  try {
    const list = await getServices(server);
    const pick = (re) => list.find((x) => re.test(String(x.name)));
    const codes = [/whatsapp/i, /telegram/i, /facebook/i, /instagram/i, /tiktok/i, /google|gmail/i]
      .map(pick).filter(Boolean).map((x) => String(x.code));
    if (codes.length) return codes;
  } catch { /* pakai bawaan */ }
  return ['wa', 'tg'];
}
/* ------------------------------------------------------------------
 *  VALIDASI NEGARA (anti nomor +62 nyasar)
 *  Kalau API pusat mengabaikan parameter "country" untuk sebuah server,
 *  ia mengembalikan produk Indonesia untuk SEMUA negara. Akibatnya daftar
 *  negara penuh (termasuk Antarktika, dll) dan order malah dapat nomor +62.
 *  Di sini produk dianggap benar-benar milik negara itu hanya jika:
 *   1) field "country" di respons (kalau ada) sama dengan negara yang diminta
 *   2) id produknya BERBEDA dari id produk Indonesia di server & layanan yang sama
 * ------------------------------------------------------------------ */
const baseCache = new Map();   // "server:service" -> { at, ids:Set } (sidik jari produk Indonesia)
// id produk = base64 JSON {s:server, v:layanan, c:negara, p:kode produk, u:...}.
// Untuk negara palsu (mis. aq) API hanya mengganti "c" tapi p, harga, stok sama persis dengan Indonesia.
// Jadi id TIDAK bisa dibandingkan langsung; yang dibandingkan adalah p + harga.
function decId(id) {
  try { return JSON.parse(Buffer.from(String(id).split('.')[0], 'base64url').toString('utf8')); } catch { return null; }
}
function sigOf(p) {
  const d = decId(p.id);
  return d && d.p != null ? `${d.p}|${p.price_idr}` : `?|${p.price_idr}|${p.stock}`;
}
async function baselineIds(server, service) {
  const k = `${server}:${service}`;
  const c = baseCache.get(k);
  if (c && Date.now() - c.at < 10 * 60000) return c.ids;
  const r = await bn('/prices', { query: { server, service, country: 'id' } });
  const ids = new Set(r?.ok ? (r.providers || []).map(sigOf) : []);
  if (r?.ok) baseCache.set(k, { at: Date.now(), ids });
  return ids;
}
function foreignOnly(r, country, base) {
  const cc = String(country).toLowerCase();
  if (!r?.ok) return [];
  if (r.country && String(r.country).toLowerCase() !== cc) return [];
  return (r.providers || []).filter((p) => {
    if (!(p.stock > 0)) return false;
    if (p.country && String(p.country).toLowerCase() !== cc) return false;
    const d = decId(p.id);
    if (d && d.c && String(d.c).toLowerCase() !== cc) return false;
    return !base.has(sigOf(p));          // produk salinan Indonesia dibuang
  });
}

async function hasStock(server, code, svcs, stat) {
  for (const svc of svcs) {
    let r;
    for (let i = 0; i < 3; i++) {
      r = await bn('/prices', { query: { server, service: svc, country: code.toLowerCase() } });
      if (r.error === 'NETWORK' || r.error === 'BAD_RESPONSE') { await sleep(1500); continue; }
      break;
    }
    if (r?.error === 'INVALID_API_KEY') throw new Error('INVALID_API_KEY');
    if (r && r.error !== 'NETWORK' && r.error !== 'BAD_RESPONSE') stat.answered++;
    if (r?.ok) {
      const base = await baselineIds(server, svc);
      if (foreignOnly(r, code, base).length) return true;
    }
    await sleep(200);
  }
  return false;
}
async function refreshNegara(force = false) {
  if (negaraRunning) return false;
  if (!force && negaraDb.at && Date.now() - negaraDb.at < 24 * 3600 * 1000) return false;
  negaraRunning = true;
  if (force) negaraDb.bad = {};          // /updatenegara = beri kesempatan baru semua negara
  console.log('🌍 Memperbarui daftar negara dari dibanana.id...');
  try {
    for (const server of SERVERS_EX) {
      const svcs = await probeServices(server);
      const stat = { answered: 0 };
      const found = [];
      let idx = 0;
      const worker = async () => {
        while (idx < CAND.length) {
          const code = CAND[idx++];
          if (await hasStock(server, code, svcs, stat)) found.push(code.toLowerCase());
          await sleep(250);
        }
      };
      await Promise.all(Array.from({ length: 3 }, worker));
      let list = found.filter((c) => !(negaraDb.bad?.[server] || []).includes(c));
      if (list.includes('gb') && list.includes('uk')) list = list.filter((c) => c !== 'uk');
      if (stat.answered < 50) { console.error(`   ${server}: API jarang menjawab, daftar lama dipertahankan`); continue; }
      negaraDb[server] = list.sort();
      negaraDb.v = NEGARA_VER;
      fs.writeFileSync(NEGARA_FILE, JSON.stringify(negaraDb));
      console.log(`   ${server}: ${list.length} negara`);
    }
    negaraDb.at = Date.now();
    negaraDb.v = NEGARA_VER;
    fs.writeFileSync(NEGARA_FILE, JSON.stringify(negaraDb));
    return true;
  } catch (e) {
    console.error('refreshNegara gagal:', e.message);
    return false;
  } finally {
    negaraRunning = false;
  }
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bot = new Bot(BOT_TOKEN);

/* ============================== HELPER =============================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const UP = (x) => String(x ?? '').toUpperCase();   // huruf besar (pakai SEBELUM esc(), supaya &amp; tidak rusak)
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const wibTime = () =>
  new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/\./g, ':');

function salam() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }).format(new Date())) % 24;
  if (h >= 4 && h < 11) return 'Selamat pagi';
  if (h >= 11 && h < 15) return 'Selamat siang';
  if (h >= 15 && h < 18) return 'Selamat sore';
  return 'Selamat malam';
}

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) bot.api.sendMessage(id, text).catch(() => {});
}

/* ============================ API DIBANANA =========================== */
async function bn(path, { method = 'GET', query, body } = {}) {
  try {
    const url = new URL(BN_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${BANANA_API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    try { return await res.json(); } catch { return { ok: false, error: 'BAD_RESPONSE' }; }
  } catch (e) {
    return { ok: false, error: 'NETWORK', message: e.message };
  }
}

function errText(r) {
  // Kode & pesan asli dari pusat TIDAK ditampilkan ke user (hanya masuk log server).
  switch (r?.error) {
    case 'NO_NUMBERS': return 'Stok nomor untuk pilihan ini sedang habis. Coba harga atau layanan lain.';
    case 'INVALID_PRODUCT_ID': return 'Harga berubah. Silakan pilih ulang.';
    case 'SERVER_UNREACHABLE':
    case 'NETWORK': return 'Server penyedia sedang tidak merespons. Coba lagi sebentar lagi.';
    default: return 'Server penyedia sedang bermasalah. Coba lagi sebentar, atau pilih harga / layanan lain.';
  }
}

/* ============================== API PAYMENKU (QRIS) ======================== */
// Payment gateway: Paymenku (https://paymenku.com/api/v1) — QRIS, cek status via polling.
//   POST /transaction/create {channel_code:'qris', amount, reference_id, customer_name, customer_email, return_url}
//        -> data { trx_id, amount (total bayar, sudah termasuk fee), status, pay_url, payment_info{ qr_url, qr_string, expiration_date } }
//   GET  /check-status/:trx_id -> data { status: pending | paid | expired | failed | cancelled | refunded }
// Total yang harus dibayar user = data.amount. Batas API Paymenku: 60 request/menit.
const PAYMENKU_URL = PAYMENKU_BASE_URL.replace(/\/+$/, '');
const PAYMENKU_CUSTOMER_EMAIL = 'deposit@pediaotp.com';   // Paymenku mewajibkan email pelanggan (format valid saja)

async function paymenkuRequest(path, { method = 'GET', body, headers = {} } = {}, retried = false) {
  try {
    const res = await fetch(PAYMENKU_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: `Bearer ${PAYMENKU_API_KEY}`, ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && !retried) {   // kena rate limit: tunggu sesuai Retry-After lalu coba sekali lagi
      const wait = Math.min(Math.max(Number(res.headers.get('Retry-After')) || 5, 1), 20);
      await sleep(wait * 1000);
      return paymenkuRequest(path, { method, body, headers }, true);
    }
    let j; try { j = await res.json(); } catch { j = null; }
    if (!res.ok || !j || j.status !== 'success') {
      return { ok: false, status: res.status, message: j?.message || `Paymenku error (HTTP ${res.status})` };
    }
    return { ok: true, data: j.data, raw: j };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function paymenkuCreateQris(uid, amount) {
  const refId = `DEPO-${uid}-${Date.now().toString(36).toUpperCase()}`.slice(0, 50);
  const r = await paymenkuRequest('/transaction/create', {
    method: 'POST',
    headers: { 'Idempotency-Key': refId },
    body: {
      channel_code: 'qris', amount, reference_id: refId,
      customer_name: `User ${uid}`, customer_email: PAYMENKU_CUSTOMER_EMAIL, return_url: CHANNEL_URL,
    },
  });
  if (!r.ok) return { ok: false, message: r.message };
  const d = r.data;
  const qr = d?.payment_info?.qr_url;
  if (!d || !d.trx_id || !qr) {
    return { ok: false, message: 'Respons Paymenku tidak berisi trx_id / qr_url: ' + JSON.stringify(r.raw).slice(0, 200) };
  }
  const total = Math.round(Number(d.amount)) || amount;
  return { ok: true, id: String(d.trx_id), qrImage: String(qr), total };
}

async function paymenkuCheckStatus(id) {
  const r = await paymenkuRequest(`/check-status/${encodeURIComponent(id)}`);
  if (!r.ok) return { ok: false };
  const raw = String(r.data?.status || '').toLowerCase();
  if (raw === 'paid') return { ok: true, status: 'paid' };
  if (raw === 'expired' || raw === 'failed' || raw === 'cancelled') return { ok: true, status: 'expired' };
  return { ok: true, status: 'pending' };
}

/* ============================ SIARAN MONITOR =========================== */
async function postMonitorOtp(o) {
  try {
    const sv = SERVERS[o.server];
    const text = [
      '🤖 <b>REAL TIME OTP</b>', LINE,
      `🆔 ID: <code>${esc(o.provider_order_id ?? o.id)}</code>`,
      `🖥 SERVER: ${sv ? sv.label : esc(o.server)}`,
      `📦 LAYANAN: <b>${esc(o.service_name || o.service_code)}</b>`,
      `✉️ ISI SMS: ${esc(o.full_sms || o.otp_code || '-')}`, LINE,
    ].join('\n');
    await bot.api.sendMessage(MONITOR_CHANNEL_ID, text, { parse_mode: 'HTML' });
  } catch (e) { console.error('postMonitorOtp gagal:', e.message); }
}

async function postMonitorDeposit(d) {
  try {
    const text = [
      '💰 <b>DEPOSIT MASUK</b>', LINE,
      `🆔 ID: <code>${esc(d.invoice_id)}</code>`,
      `👤 USER ID: <code>${esc(d.user_id)}</code>`,
      `💵 NOMINAL: <b>${rp(d.nominal)}</b>`, LINE,
    ].join('\n');
    await bot.api.sendMessage(MONITOR_CHANNEL_ID, text, { parse_mode: 'HTML' });
  } catch (e) { console.error('postMonitorDeposit gagal:', e.message); }
}

/* ============================= SETTINGS ============================== */
let settingsCache = { at: 0, data: {} };
async function getSettings() {
  if (Date.now() - settingsCache.at < 5000) return settingsCache.data;
  const { data } = await db.from('otp_settings').select('key,value');
  const m = {};
  (data || []).forEach((r) => { m[r.key] = r.value; });
  settingsCache = { at: Date.now(), data: m };
  return m;
}
async function getMarkup() {
  const s = await getSettings();
  return {
    persen: Number(s.markup_persen ?? 10) || 0,
    flat: Number(s.markup_flat ?? 300) || 0,
    maintenance: String(s.maintenance || 'off') === 'on',
  };
}
// Maintenance khusus menu Deposit (terpisah dari maintenance Order di atas).
// Dashboard admin menulis ke key "deposit_maintenance" (dan salinannya "maintenance_deposit"
// untuk kompatibilitas) — di sini dibaca dari salah satu yang ada.
async function isDepositMaintenance() {
  const s = await getSettings();
  return String(s.deposit_maintenance ?? s.maintenance_deposit ?? 'off') === 'on';
}
// harga jual = modal + persen + flat, dibulatkan ke atas per Rp100
const calcJual = (modal, mk) => Math.ceil((modal * (1 + mk.persen / 100) + mk.flat) / 100) * 100;

/* ============================== DATABASE ============================= */
async function getUser(id) {
  const { data } = await db.from('otp_users').select('*').eq('id', id).maybeSingle();
  return data;
}
async function debit(uid, amt) {
  const { data, error } = await db.rpc('otp_debit', { p_user: uid, p_amount: amt });
  if (error) { console.error('debit error', error.message); return false; }
  return data === true;
}
async function credit(uid, amt) {
  const { error } = await db.rpc('otp_credit', { p_user: uid, p_amount: amt });
  if (error) {
    console.error('credit error', error.message);
    notifyAdmins(`⚠️ Gagal mengembalikan saldo ${rp(amt)} ke user ${uid}. Cek manual!`);
  }
  return !error;
}

let statsCache = { at: 0, users: 0, sukses: 0 };
async function getStats() {
  if (Date.now() - statsCache.at < 60000) return statsCache;
  const [u, s] = await Promise.all([
    db.from('otp_users').select('id', { count: 'exact', head: true }),
    db.from('otp_orders').select('id', { count: 'exact', head: true }).eq('status', 'received'),
  ]);
  statsCache = { at: Date.now(), users: u.count || 0, sukses: s.count || 0 };
  return statsCache;
}

/* ============================== SESSION ============================== */
const sessions = new Map();
function S(uid) {
  let s = sessions.get(uid);
  if (!s || Date.now() - s.ts > 30 * 60000) { s = {}; sessions.set(uid, s); }
  s.ts = Date.now();
  return s;
}
setInterval(() => {
  for (const [k, v] of sessions) if (Date.now() - v.ts > 30 * 60000) sessions.delete(k);
}, 10 * 60000).unref();

const lastMenu = new Map();   // uid -> message_id dashboard terakhir (supaya /start tidak menumpuk)
const buying = new Set();     // kunci anti klik ganda saat membeli

/* ========================= WAJIB JOIN CHANNEL ========================= */
const CHANNEL_CHAT_ID = '@pediaotp';
const memberCache = new Map();
const MEMBER_CACHE_MS = 15000;

async function isChannelMember(uid, force = false) {
  const now = Date.now();
  const cached = memberCache.get(uid);
  if (!force && cached && now - cached.at < MEMBER_CACHE_MS) return cached.ok;
  try {
    const m = await bot.api.getChatMember(CHANNEL_CHAT_ID, uid);
    const ok = ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member === true);
    memberCache.set(uid, { at: now, ok });
    return ok;
  } catch (e) {
    console.error('cek membership channel gagal:', e.message);
    memberCache.delete(uid);
    return null; // null = tidak bisa diverifikasi, jangan buka akses
  }
}

function joinGateKeyboard() {
  return new InlineKeyboard()
    .url('📢 Join Channel', CHANNEL_URL).row()
    .text('✅ Saya Sudah Join', 'joincheck');
}

async function showJoinGate(ctx, verifyFailed = false) {
  const text = verifyFailed
    ? '⏳ <b>Belum Bisa Dicek</b>\n\nMaaf, kami belum bisa memastikan kamu sudah join channel.\n\nCoba tekan <b>✅ Saya Sudah Join</b> lagi sebentar lagi ya. Kalau masih gagal, hubungi admin.'
    : '👋 <b>Selamat datang di PEDIA OTP!</b>\n\nSebelum mulai, join channel resmi kami dulu ya. Di sana ada info promo, update layanan, dan pengumuman penting.\n\n1️⃣ Tekan <b>Join Channel</b>\n2️⃣ Kembali ke sini, lalu tekan <b>Saya Sudah Join</b>';
  try {
    if (ctx.callbackQuery?.message?.message_id) {
      await bot.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, text, { parse_mode: 'HTML', reply_markup: joinGateKeyboard() });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: joinGateKeyboard() });
    }
  } catch (e) {
    if (!String(e.description || e.message || '').includes('message is not modified')) {
      ctx.reply(text, { parse_mode: 'HTML', reply_markup: joinGateKeyboard() }).catch(() => {});
    }
  }
}

/* ========================== RENDER / EDIT PESAN ====================== */
async function edit(chatId, msgId, text, kb) {
  try {
    await bot.api.editMessageText(chatId, msgId, text, {
      parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true },
    });
    return msgId;
  } catch (e) {
    const d = String(e.description || e.message || '');
    if (d.includes('message is not modified')) return msgId;
    const m = await bot.api.sendMessage(chatId, text, {
      parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true },
    });
    return m.message_id;
  }
}
const render = (ctx, text, kb) => edit(ctx.chat.id, ctx.callbackQuery.message.message_id, text, kb);

/* ============================== TAMPILAN ============================= */
const homeBtn = () => new InlineKeyboard().text('🏠 Menu Utama', 'home');

function mainKb() {
  return new InlineKeyboard()
    .text('🛒 Buat Order', 'ord').row()
    .text('💰 Deposit', 'dep').text('📜 Riwayat Order', 'hist:0').row()
    .url('🔎 Monitor', MONITOR_CHANNEL_URL).url('🔢 Cek Nomor', CEKNOMOR_URL).row()
    .text('ℹ️ Bantuan', 'help').url('💬 Hubungi CS', CS_URL).row()
    .url('📢 Channel Resmi', CHANNEL_URL);
}

async function dashboardText(u) {
  const st = await getStats();
  const { count } = await db.from('otp_orders')
    .select('id', { count: 'exact', head: true }).eq('user_id', u.id).eq('status', 'received');
  const nama = esc([u.first_name, u.last_name].filter(Boolean).join(' ') || 'Sobat');
  const bergabung = new Date(u.created_at).toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta',
  });
  const akun = [
    '👤 <b>AKUN KAMU</b>',
    `🆔 ID Telegram : <code>${u.id}</code>`,
    `📛 Username : <code>${u.username ? '@' + esc(u.username) : 'Tidak ada'}</code>`,
    `💰 Saldo : <b>${rp(u.saldo)}</b>`,
    `✅ Order Sukses : ${count || 0}`,
    `📅 Bergabung : ${bergabung}`,
  ].join('\n');
  const statistik = [
    `📊 <b>STATISTIK ${BRAND}</b>`,
    `👥 Total Pengguna : ${st.users.toLocaleString('id-ID')}`,
    `🔑 Total OTP Sukses : ${st.sukses.toLocaleString('id-ID')}`,
  ].join('\n');
  return [
    `📲 <b>${BRAND}</b>`,
    `<i>${TAGLINE}</i>`,
    '',
    `👋 ${salam()}, <b>${nama}</b>!`,
    'Pilih menu di bawah untuk mulai order nomor OTP.',
    '',
    `<blockquote>${akun}</blockquote>`,
    `<blockquote>${statistik}</blockquote>`,
    `🕐 <i>Diperbarui ${wibTime()} WIB</i>`,
  ].join('\n');
}

/* ============================== /START =============================== */
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return;
  const data = ctx.callbackQuery?.data || '';
  const allowedBypass = data === 'joincheck' || data === 'balancealert:stop';
  const joined = await isChannelMember(ctx.from.id, data === 'joincheck');
  if (joined !== true && !allowedBypass) {
    await showJoinGate(ctx, joined === null);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: joined === null ? 'Verifikasi channel gagal.' : 'Wajib join channel resmi.', show_alert: joined === null });
    return;
  }
  if (data === 'joincheck' && joined !== true) {
    await showJoinGate(ctx, joined === null);
    await ctx.answerCallbackQuery({ text: joined === null ? 'Verifikasi channel gagal.' : 'Kamu belum join channel resmi.', show_alert: joined === null });
    return;
  }
  const f = ctx.from;
  let u = await getUser(f.id);
  if (!u) {
    await db.from('otp_users').upsert(
      { id: f.id, first_name: f.first_name ?? null, last_name: f.last_name ?? null, username: f.username ?? null },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    u = await getUser(f.id);
    statsCache.at = 0;
  } else if (u.first_name !== (f.first_name ?? null) || u.last_name !== (f.last_name ?? null) || u.username !== (f.username ?? null)) {
    const { data } = await db.from('otp_users')
      .update({ first_name: f.first_name ?? null, last_name: f.last_name ?? null, username: f.username ?? null, updated_at: new Date().toISOString() })
      .eq('id', f.id).select().maybeSingle();
    if (data) u = data;
  }
  if (!u) return ctx.reply('⚠️ Terjadi gangguan database. Coba lagi sebentar lagi.').catch(() => {});
  if (u.is_banned) return ctx.reply('🚫 Akun kamu diblokir. Hubungi admin melalui channel resmi.').catch(() => {});
  ctx.user = u;
  return next();
});

bot.use(async (ctx, next) => {
  const q = ctx.callbackQuery;
  if (q?.message && !/^cxw?:/.test(q.data || '')) {
    for (const c of countdownMsgs.values()) if (c.mid === q.message.message_id) c.stop = true;
  }
  return next();
});

bot.command('start', async (ctx) => {
  sessions.delete(ctx.from.id);
  const prev = lastMenu.get(ctx.from.id);
  if (prev) ctx.api.deleteMessage(ctx.chat.id, prev).catch(() => {});
  const m = await ctx.reply(await dashboardText(ctx.user), {
    parse_mode: 'HTML', reply_markup: mainKb(), link_preview_options: { is_disabled: true },
  });
  lastMenu.set(ctx.from.id, m.message_id);
});

bot.callbackQuery('joincheck', async (ctx) => {
  const joined = await isChannelMember(ctx.from.id, true);
  if (joined !== true) {
    await ctx.answerCallbackQuery({ text: joined === null ? 'Verifikasi channel gagal. Coba lagi.' : 'Kamu belum join channel resmi.', show_alert: joined === null });
    return showJoinGate(ctx, joined === null);
  }
  await ctx.answerCallbackQuery({ text: 'Join terdeteksi. Akses dibuka.' });
  sessions.delete(ctx.from.id);
  const u = await getUser(ctx.from.id);
  if (!u) return ctx.reply('⚠️ Terjadi gangguan database. Coba lagi sebentar lagi.');
  const m = await bot.api.sendMessage(ctx.chat.id, await dashboardText(u), { parse_mode: 'HTML', reply_markup: mainKb(), link_preview_options: { is_disabled: true } });
  lastMenu.set(ctx.from.id, m.message_id);
});

bot.callbackQuery('home', async (ctx) => {
  await ctx.answerCallbackQuery();
  sessions.delete(ctx.from.id);
  await render(ctx, await dashboardText(ctx.user), mainKb());
  lastMenu.set(ctx.from.id, ctx.callbackQuery.message.message_id);
});

bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

/* ============================ DEPOSIT (QRIS PAYMENKU) ===================== */
const DEPOSIT_PRESETS = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const DEPOSIT_MIN = 1000;
const DEPOSIT_MAX = 10000000;

function depositPickerKb() {
  const kb = new InlineKeyboard();
  DEPOSIT_PRESETS.forEach((n, i) => {
    kb.text(rp(n), `depn:${n}`);
    if (i % 2 === 1) kb.row();
  });
  if (DEPOSIT_PRESETS.length % 2 === 1) kb.row();
  kb.text('✏️ Nominal Lain', 'depc').row();
  kb.text('⬅️ Kembali', 'home');
  return kb;
}

async function showDepositPicker(ctx) {
  const u = await getUser(ctx.from.id);
  await render(ctx, [
    '💰 <b>Deposit Saldo</b>', LINE,
    `Saldo kamu saat ini : <b>${rp(u.saldo)}</b>`, '',
    'Pilih nominal topup di bawah, atau ketik nominal sendiri lewat tombol ✏️ Nominal Lain.',
    '💳 Pembayaran otomatis via <b>QRIS</b> — scan & bayar, saldo langsung masuk.',
  ].join('\n'), depositPickerKb());
}

bot.callbackQuery('dep', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (await isDepositMaintenance()) {
    return render(ctx, '🛠 <b>Sedang Maintenance</b>\n\nDeposit dimatikan sementara. Silakan coba lagi nanti.', homeBtn());
  }
  await showDepositPicker(ctx);
});

bot.callbackQuery('depc', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (await isDepositMaintenance()) {
    return render(ctx, '🛠 <b>Sedang Maintenance</b>\n\nDeposit dimatikan sementara. Silakan coba lagi nanti.', homeBtn());
  }
  const s = S(ctx.from.id);
  s.awaitDeposit = true;
  s.chatId = ctx.chat.id; s.msgId = ctx.callbackQuery.message.message_id;
  await render(ctx, [
    '✏️ <b>Nominal Lain</b>', LINE,
    `Ketik jumlah deposit (min. ${rp(DEPOSIT_MIN)}, maks. ${rp(DEPOSIT_MAX)}), contoh: <code>75000</code>`,
  ].join('\n'), new InlineKeyboard().text('⬅️ Batal', 'dep'));
});

bot.callbackQuery(/^depn:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await startDeposit(ctx, Number(ctx.match[1]));
});

const DEPOSIT_TTL_MIN = 20;            // batas waktu bayar di bot (QRIS Paymenku aktif 24 jam; bayar telat tetap dikreditkan oleh penyapu di bawah)
const cancelledDep = new Set();       // id deposit yang dibatalkan user -> polling berhenti

function depositInvoiceText(row, status) {
  const exp = new Date(row.expired_at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/\./g, ':');
  if (status === 'paid') {
    return [
      '✅ <b>Deposit Berhasil</b>', LINE,
      `🧾 ID Transaksi : <code>${esc(row.invoice_id)}</code>`,
      `💵 Nominal Masuk : <b>${rp(row.nominal)}</b>`, LINE,
      'Saldo kamu sudah bertambah. Terima kasih! 🙏',
    ].join('\n');
  }
  if (status === 'expired' || status === 'cancelled' || status === 'failed') {
    const label = status === 'cancelled' ? 'Dibatalkan' : status === 'expired' ? 'Kedaluwarsa' : 'Gagal';
    return [
      `❌ <b>Pembayaran ${label}</b>`, LINE,
      `🧾 ID Transaksi : <code>${esc(row.invoice_id)}</code>`,
      `💵 Nominal : ${rp(row.nominal)}`, LINE,
      'Silakan buat invoice deposit baru lewat menu Deposit.',
    ].join('\n');
  }
  const unik = Math.max(0, Number(row.total) - Number(row.nominal) - Number(row.fee));
  return [
    '📱 <b>INVOICE QRIS</b>', LINE,
    `🧾 ID Transaksi : <code>${esc(row.invoice_id)}</code>`,
    '💳 Metode : <b>QRIS (Instan)</b>',
    `⏰ Expired : ${exp} WIB`, LINE,
    '<b>RINCIAN PEMBAYARAN</b>',
    `💵 Nominal Topup : ${rp(row.nominal)}`,
    `💸 Biaya QRIS : ${rp(row.fee)}`,
    ...(unik > 0 ? [`🔢 Kode Unik : ${rp(unik)}`] : []), LINE,
    `💰 Total Bayar : <b>${rp(row.total)}</b>`,
    `🏦 Saldo Masuk : <b>${rp(row.nominal)}</b>`, LINE,
    '⏳ <i>Menunggu pembayaran...</i>',
    `📲 Scan QRIS di atas, bayar tepat sejumlah <b>${rp(row.total)}</b>.`,
  ].join('\n');
}

async function showDepositInvoice(ctx, row, qrImageUrl) {
  const kb = new InlineKeyboard().text('❌ Batalkan Pembayaran', `depx:${row.id}`).row().text('🏠 Menu Utama', 'home');
  const capt = depositInvoiceText(row, 'pending');
  // QR dari Paymenku berupa URL gambar: diunduh dulu supaya Telegram pasti bisa menampilkannya.
  let photo = qrImageUrl;
  try {
    const res = await fetch(qrImageUrl, { signal: AbortSignal.timeout(15000) });
    if (res.ok) photo = new InputFile(Buffer.from(await res.arrayBuffer()), 'qris.png');
  } catch (e) { console.error('unduh QR Paymenku gagal, kirim lewat URL:', e.message); }
  let m;
  try {
    m = await bot.api.sendPhoto(ctx.chat.id, photo, { caption: capt, parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    console.error('kirim QR gagal:', e.message);
    m = await bot.api.sendMessage(ctx.chat.id, `${capt}\n\n🔗 <a href="${esc(qrImageUrl)}">Buka gambar QRIS</a>`, {
      parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true },
    });
  }
  await db.from('otp_deposits').update({ message_id: m.message_id }).eq('id', row.id);
  row.message_id = m.message_id;
  // hapus pesan "Membuat invoice..." supaya tidak menggantung di atas invoice
  const old = ctx.callbackQuery?.message?.message_id;
  if (old && old !== m.message_id) bot.api.deleteMessage(ctx.chat.id, old).catch(() => {});
}

async function startDeposit(ctx, nominal) {
  if (await isDepositMaintenance()) {
    return render(ctx, '🛠 <b>Sedang Maintenance</b>\n\nDeposit dimatikan sementara. Silakan coba lagi nanti.', homeBtn());
  }
  if (!Number.isFinite(nominal) || nominal < DEPOSIT_MIN || nominal > DEPOSIT_MAX) {
    return render(ctx, `⚠️ Nominal deposit minimal ${rp(DEPOSIT_MIN)} dan maksimal ${rp(DEPOSIT_MAX)}.`,
      new InlineKeyboard().text('⬅️ Kembali', 'dep'));
  }
  await render(ctx, '⏳ <b>Membuat invoice QRIS...</b>\nMohon tunggu sebentar.');
  const inv = await paymenkuCreateQris(ctx.from.id, nominal);   // Paymenku menambah fee -> inv.total = total yang dibayar user
  if (!inv.ok) {
    console.error('deposit gagal dibuat:', inv.message);
    return render(ctx, '⚠️ <b>Gagal membuat invoice deposit</b>\n\nLayanan pembayaran sedang bermasalah. Coba lagi sebentar lagi.',
      new InlineKeyboard().text('🔄 Coba Lagi', `depn:${nominal}`).row().text('⬅️ Kembali', 'dep'));
  }
  const fee = Math.max(0, inv.total - nominal);   // biaya QRIS asli dari Paymenku
  const expiredAt = new Date(Date.now() + DEPOSIT_TTL_MIN * 60000).toISOString();
  const { data: row, error } = await db.from('otp_deposits').insert({
    user_id: ctx.from.id, invoice_id: inv.id, nominal, fee, total: inv.total,
    status: 'pending', chat_id: ctx.chat.id, expired_at: expiredAt,
  }).select().single();
  if (error || !row) {
    console.error('insert deposit gagal', error?.code, error?.message, error?.details);
    notifyAdmins(`🚨 Invoice Paymenku ${inv.id} (user ${ctx.from.id}, Rp${inv.total}) dibuat tapi gagal disimpan ke DB.\nPenyebab: ${error?.message || 'tidak ada data balik'}${error?.code ? ' [' + error.code + ']' : ''}\nJika user bayar, tambah saldo manual dengan /addsaldo.`);
    return render(ctx, '⚠️ Terjadi gangguan saat menyimpan transaksi deposit. Hubungi admin.', homeBtn());
  }
  await showDepositInvoice(ctx, row, inv.qrImage);
  watchDeposit(row);
}

bot.callbackQuery(/^depx:(\d+)$/, async (ctx) => {
  const { data: row } = await db.from('otp_deposits').select('*').eq('id', Number(ctx.match[1])).eq('user_id', ctx.from.id).maybeSingle();
  if (!row || row.status !== 'pending') {
    return ctx.answerCallbackQuery({ text: 'Transaksi ini sudah tidak bisa dibatalkan.', show_alert: true });
  }
  await ctx.answerCallbackQuery();
  const { data } = await db.from('otp_deposits')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'pending').select().maybeSingle();
  if (!data) return;
  cancelledDep.add(data.id);
  await editDepositMessage(data, 'cancelled');
});

async function editDepositMessage(row, status) {
  const text = depositInvoiceText(row, status);
  const kb = new InlineKeyboard().text('💰 Deposit Lagi', 'dep').row().text('🏠 Menu Utama', 'home');

  // Saat deposit selesai/dibatalkan/kedaluwarsa, QRIS FOTO harus hilang.
  // Telegram tidak bisa mengubah media foto menjadi teks lewat edit caption, jadi
  // pesan foto dihapus lalu dibuat ulang sebagai pesan teks biasa.
  if (['paid', 'expired', 'cancelled', 'failed'].includes(status)) {
    try { await bot.api.deleteMessage(row.chat_id, row.message_id); } catch (e) {
      const d = String(e.description || e.message || '');
      if (!d.includes('message to delete not found')) console.error('hapus QR deposit gagal:', d);
    }
    try {
      const m = await bot.api.sendMessage(row.chat_id, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
      await db.from('otp_deposits').update({ message_id: m.message_id }).eq('id', row.id);
      row.message_id = m.message_id;
    } catch (e) {
      console.error('kirim teks hasil deposit gagal:', e.message);
    }
    return;
  }

  try {
    await bot.api.editMessageCaption(row.chat_id, row.message_id, { caption: text, parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    const d = String(e.description || e.message || '');
    if (d.includes('message is not modified')) return;
    try {
      await bot.api.editMessageText(row.chat_id, row.message_id, text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e2) {
      const d2 = String(e2.description || e2.message || '');
      if (!d2.includes('message is not modified')) console.error('editDepositMessage gagal:', d2);
    }
  }
}

// Tandai deposit lunas (atomik, anti kredit ganda) lalu tambah saldo user.
async function settleDepositPaid(row, fromStatuses, late = false) {
  const { data } = await db.from('otp_deposits')
    .update({ status: 'paid', updated_at: new Date().toISOString() })
    .eq('id', row.id).in('status', fromStatuses).select().maybeSingle();
  if (!data) return false;                       // sudah diproses di tempat lain
  const ok = await credit(data.user_id, data.nominal);
  if (!ok) notifyAdmins(`🚨 Deposit ${data.invoice_id} user ${data.user_id} ${rp(data.nominal)} SUDAH DIBAYAR tapi gagal menambah saldo. Tambah manual: /addsaldo ${data.user_id} ${data.nominal}`);
  await editDepositMessage(data, 'paid');
  postMonitorDeposit(data).catch(() => {});
  return true;
}

async function settleDepositEnd(row, status) {
  const { data } = await db.from('otp_deposits')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'pending').select().maybeSingle();
  if (data) await editDepositMessage(data, status);
}

const watchingDep = new Set();
async function watchDeposit(row) {
  if (watchingDep.has(row.id)) return;
  watchingDep.add(row.id);
  const deadline = new Date(row.expired_at).getTime() + 60000;   // + 1 menit cadangan
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      if (cancelledDep.has(row.id)) return;      // dibatalkan user (kalau tetap dibayar, penyapu yang mengkreditkan)
      const st = await paymenkuCheckStatus(row.invoice_id);
      if (!st.ok) continue;
      if (st.status === 'paid') { await settleDepositPaid(row, ['pending']); return; }
      if (st.status === 'expired') { await settleDepositEnd(row, 'expired'); return; }
    }
    // waktu habis: cek terakhir sebelum dinyatakan kedaluwarsa
    const st = await paymenkuCheckStatus(row.invoice_id);
    if (st.ok && st.status === 'paid') { await settleDepositPaid(row, ['pending']); return; }
    await settleDepositEnd(row, 'expired');
  } catch (e) {
    console.error('watchDeposit error', row.id, e.message);
  } finally {
    watchingDep.delete(row.id);
    cancelledDep.delete(row.id);
  }
}

// Penyapu pembayaran telat: invoice yang sudah dibatalkan / kedaluwarsa di bot tapi ternyata
// tetap dibayar user (QRIS Paymenku masih aktif 24 jam) tetap dikreditkan otomatis.
let sweepN = 0;
let sweeping = false;
async function sweepLateDeposits() {
  if (sweeping) return;
  sweeping = true;
  try {
    sweepN++;
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data } = await db.from('otp_deposits').select('*')
      .in('status', ['cancelled', 'expired']).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(60);
    for (const d of data || []) {
      const ageMin = (Date.now() - new Date(d.created_at).getTime()) / 60000;
      if (ageMin > 60 && sweepN % 10 !== 0) continue;      // invoice > 1 jam cukup dicek tiap ± 30 menit
      const st = await paymenkuCheckStatus(d.invoice_id);
      if (st.ok && st.status === 'paid') await settleDepositPaid(d, ['cancelled', 'expired'], true);
      await sleep(300);
    }
  } catch (e) {
    console.error('sweepLateDeposits error:', e.message);
  } finally {
    sweeping = false;
  }
}

/* ===================== ALERT SALDO DIBANANA.ID ====================== */
let centerBalanceMuted = false;
let centerBalanceLastAlertAt = 0;
let centerBalanceLastValue = null;
let centerBalanceChecking = false;
const CENTER_BALANCE_CHECK_MS = 2 * 60000;
const CENTER_BALANCE_ALERT_MS = 10 * 60000;

function balanceAlertKb() {
  return new InlineKeyboard().text('✅ Sudah Isi Saldo / Stop Notif', 'balancealert:stop');
}

async function checkCenterBalance() {
  if (centerBalanceChecking) return;
  centerBalanceChecking = true;
  try {
    const r = await bn('/balance');
    if (!r?.ok) return; // gangguan API tidak dianggap saldo habis
    const balance = Number(r.balance);
    if (!Number.isFinite(balance)) return;
    centerBalanceLastValue = balance;

    if (balance > 0) {
      // Setelah saldo terisi kembali, alarm di-arm lagi untuk kejadian berikutnya.
      centerBalanceMuted = false;
      centerBalanceLastAlertAt = 0;
      return;
    }

    if (centerBalanceMuted) return;
    if (Date.now() - centerBalanceLastAlertAt < CENTER_BALANCE_ALERT_MS) return;

    centerBalanceLastAlertAt = Date.now();
    await bot.api.sendMessage(ADMIN_ALERT_ID, [
      '🚨 <b>SALDO DIBANANA.ID HABIS</b>', LINE,
      'Saldo website terdeteksi <b>Rp 0</b>. Order baru bisa gagal sampai saldo diisi kembali.',
      '🔔 Notifikasi ini akan dikirim ulang setiap 10 menit sampai dihentikan.',
    ].join('\n'), { parse_mode: 'HTML', reply_markup: balanceAlertKb() });
  } catch (e) {
    console.error('cek saldo dibanana gagal:', e.message);
  } finally {
    centerBalanceChecking = false;
  }
}

bot.callbackQuery('balancealert:stop', async (ctx) => {
  if (ctx.from.id !== ADMIN_ALERT_ID) return ctx.answerCallbackQuery({ text: 'Tidak tersedia.', show_alert: true });
  centerBalanceMuted = true;
  centerBalanceLastAlertAt = Date.now();
  await ctx.answerCallbackQuery({ text: 'Notifikasi saldo dihentikan.' });
  try {
    await ctx.editMessageText([
      '✅ <b>Notifikasi saldo dihentikan</b>', LINE,
      centerBalanceLastValue === 0 ? 'Silakan isi saldo dibanana.id. Alarm akan aktif lagi setelah saldo terdeteksi terisi kembali.' : 'Alarm dinonaktifkan.',
    ].join('\n'), { parse_mode: 'HTML' });
  } catch {}
});

/* ============================== BANTUAN =============================== */

bot.callbackQuery('help', async (ctx) => {
  await ctx.answerCallbackQuery();
  await render(ctx, [
    'ℹ️ <b>Cara Order</b>', LINE,
    '1️⃣ Isi saldo lewat menu Deposit',
    '2️⃣ Tekan <b>Buat Order</b>, pilih Nomor Indonesia atau Luar Negeri, lalu server dan layanan',
    '3️⃣ Pilih harga, lalu konfirmasi pembelian',
    '4️⃣ Masukkan nomor ke aplikasi tujuan',
    '5️⃣ OTP muncul otomatis di chat ini',
    '',
    '🔁 Bisa minta SMS ke-2 (gratis) setelah OTP pertama masuk.',
    '❌ Order bisa dibatalkan setelah 2 menit jika OTP belum masuk, saldo kembali penuh.',
    '⌛ Jika OTP tidak masuk sampai batas waktu, saldo otomatis kembali.',
    LINE,
    '💰 <b>Cara Deposit Saldo</b>', LINE,
    '1️⃣ Tekan menu <b>Deposit</b> di halaman utama',
    '2️⃣ Pilih salah satu nominal yang tersedia, atau tekan <b>✏️ Nominal Lain</b> untuk mengetik jumlah sendiri (contoh: <code>75000</code>)',
    '3️⃣ Bot akan membuatkan <b>kode QRIS</b> otomatis, lengkap dengan rincian nominal, biaya QRIS, kode unik, dan total yang harus dibayar',
    '4️⃣ Buka aplikasi e-wallet / m-banking apa pun yang mendukung QRIS (Dana, OVO, GoPay, ShopeePay, mobile banking, dll), lalu <b>scan kode QR</b> tersebut',
    '5️⃣ Bayar <b>tepat sejumlah</b> nominal "Total Bayar" yang tertera — jangan dibulatkan sendiri',
    '6️⃣ Saldo masuk otomatis ke akun kamu begitu pembayaran terverifikasi, tanpa perlu konfirmasi manual',
    '⏰ Setiap kode QRIS punya batas waktu (expired). Jika lewat waktu, batalkan dan buat ulang lewat menu Deposit',
    '❌ Belum sempat bayar? Tekan <b>Batalkan Pembayaran</b> pada invoice, lalu buat invoice baru',
    '',
    '🔎 Semua transaksi OTP & deposit yang berhasil juga bisa dipantau real-time di menu <b>Monitor</b>.',
    '🔢 Menu <b>Cek Nomor</b> berguna untuk mengecek riwayat pemakaian sebuah nomor sebelum dipakai order.',
    '',
    '💬 Ada kendala? Hubungi CS kami.',
  ].join('\n'), new InlineKeyboard().url('💬 Hubungi CS', CS_URL).row().url('📢 Channel Resmi', CHANNEL_URL).row().text('⬅️ Kembali', 'home'));
});

/* ============================== LAYANAN ============================== */
const svcCache = {};
// Layanan populer selalu di halaman 1 (urutan sesuai daftar ini), sisanya mengikuti urutan API.
const PRIORITAS = ['whatsapp', 'telegram', 'facebook', 'instagram', 'google', 'tiktok', 'twitter', 'shopee', 'dana', 'ovo', 'gojek', 'tokopedia']
  .map((k) => new RegExp(`\\b${k}\\b`, 'i'));
function sortPrioritas(list) {
  const rank = (sv) => { const i = PRIORITAS.findIndex((re) => re.test(String(sv.name))); return i === -1 ? 999 : i; };
  return list.map((sv, i) => [sv, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}
async function getServices(server) {
  const c = svcCache[server];
  if (c && Date.now() - c.at < 10 * 60000) return c.data;
  const r = await bn('/services', { query: { server } });
  if (!r.ok) { if (c) return c.data; throw new Error(r.error || 'services'); }
  svcCache[server] = { at: Date.now(), data: sortPrioritas(r.services || []) };
  return svcCache[server].data;
}

function paginate(arr, page, per) {
  const total = Math.max(1, Math.ceil(arr.length / per));
  const p = Math.min(Math.max(0, page), total - 1);
  return { items: arr.slice(p * per, (p + 1) * per), page: p, total };
}
function navRow(kb, page, total, prefix) {
  kb.text(page > 0 ? '◀️' : '·', page > 0 ? `${prefix}:${page - 1}` : 'noop')
    .text(`${page + 1}/${total}`, 'noop')
    .text(page < total - 1 ? '▶️' : '·', page < total - 1 ? `${prefix}:${page + 1}` : 'noop').row();
}

bot.callbackQuery('ord', async (ctx) => {
  await ctx.answerCallbackQuery();
  const mk = await getMarkup();
  if (mk.maintenance) {
    return render(ctx, '🛠 <b>Sedang Maintenance</b>\n\nOrder dimatikan sementara. Silakan coba lagi nanti.', homeBtn());
  }
  const s = S(ctx.from.id);
  s.country = 'id'; s.filter = null; s.search = null;
  const kb = new InlineKeyboard()
    .text('🇮🇩 Nomor Indonesia', 'reg:id').row()
    .text('🌍 Nomor Luar Negeri', 'reg:ex').row()
    .text('📜 Riwayat Order', 'hist:0').row()
    .text('⬅️ Kembali', 'home');
  await render(ctx, [
    '🛒 <b>Buat Order</b>', LINE,
    'Pilih jenis nomor:', '',
    '🇮🇩 <b>Nomor Indonesia</b>',
    '└ OTP dengan nomor +62', '',
    '🌍 <b>Nomor Luar Negeri</b>',
    '└ Pilih negara yang tersedia', LINE,
  ].join('\n'), kb);
});

function pickerView(ex) {
  const list = ex ? SERVERS_EX : SERVERS_ID;
  const lines = ['🛒 <b>Buat Order</b>', LINE, ex ? '🌍 <b>Nomor Luar Negeri</b>' : '🇮🇩 <b>Nomor Indonesia</b>', '', 'Pilih server sesuai kebutuhanmu:', ''];
  const kb = new InlineKeyboard();
  for (const code of list) {
    const sv = SERVERS[code];
    lines.push(sv.label.replace(/^(\S+) (.+)$/, '$1 <b>$2</b>'), `└ ${sv.desc}`, '');
    kb.text(sv.label, ex ? `exs:${code}` : `srv:${code}`).row();
  }
  kb.text('⬅️ Kembali', 'ord');
  lines.push(LINE);
  return { text: lines.join('\n'), kb };
}

bot.callbackQuery('reg:id', async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  s.country = 'id'; s.filter = null; s.search = null; s.searchCountry = false;
  const v = pickerView(false);
  await render(ctx, v.text, v.kb);
});

bot.callbackQuery('reg:ex', async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  s.exServer = null; s.cfilter = null; s.filter = null; s.search = null; s.searchCountry = false;
  if (SERVERS_EX.length === 1) {   // hanya 1 server luar negeri -> langsung ke daftar negara
    s.exServer = SERVERS_EX[0];
    return showCountries(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, s.cpage || 0);
  }
  const v = pickerView(true);
  await render(ctx, v.text, v.kb);
});

// kalau server luar negeri cuma satu, tombol kembali langsung ke menu Buat Order
const EX_BACK = SERVERS_EX.length === 1 ? 'ord' : 'reg:ex';

async function showCountries(chatId, msgId, uid, page) {
  const s = S(uid);
  const server = s.exServer;
  if (!server) { const v = pickerView(true); return edit(chatId, msgId, v.text, v.kb); }
  const base = countryEntries(server);
  const head = `${SERVERS[server].label.split(' ')[0]} <b>Server ${SERVERS[server].name}</b>`;
  if (!base.length) {
    return edit(chatId, msgId, `🌍 <b>Nomor Luar Negeri</b>\n${LINE}\nBelum ada negara yang tersedia di server ini. Coba server lain.`,
      new InlineKeyboard().text('⬅️ Kembali', EX_BACK));
  }
  const all = s.cfilter || base;
  const pg = paginate(all, page, PER_PAGE);
  s.cpage = pg.page;   // ingat halaman daftar negara terakhir (reset saat /start)
  const kb = new InlineKeyboard().text('🔍 Cari Negara', 'ctq').row();
  pg.items.forEach((c, i) => {
    kb.text(clip(`${c[1]} ${c[2]}`, 24), `cty:${c[0]}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  if (!pg.items.length) kb.text('Negara tidak ditemukan', 'noop').row();
  navRow(kb, pg.page, pg.total, 'ctp');
  kb.text('⬅️ Kembali', EX_BACK);
  const judul = s.cfilter ? `🔍 Hasil: <i>${esc(s.cfilterQ)}</i>` : 'Pilih negara:';
  const info = negaraRunning && !Array.isArray(negaraDb[server]) ? '\n<i>ℹ️ Daftar negara sedang diperbarui.</i>' : '';
  await edit(chatId, msgId, [`🌍 <b>Nomor Luar Negeri</b>`, ...(SERVERS_EX.length > 1 ? [head] : []), LINE, `${judul} (${pg.page + 1}/${pg.total})${info}`].join('\n'), kb);
}

bot.callbackQuery(/^exs:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!SERVERS_EX.includes(ctx.match[1])) return;
  const s = S(ctx.from.id);
  s.exServer = ctx.match[1]; s.cfilter = null; s.filter = null; s.search = null; s.searchCountry = false;
  await showCountries(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, 0);
});
bot.callbackQuery(/^ctp:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showCountries(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, Number(ctx.match[1]));
});
bot.callbackQuery('ctq', async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  s.searchCountry = true; s.search = null;
  s.chatId = ctx.chat.id; s.msgId = ctx.callbackQuery.message.message_id;
  await render(ctx, '🔍 <b>Cari Negara</b>\n\nKetik nama negara yang kamu cari, contoh: <code>malaysia</code>',
    new InlineKeyboard().text('⬅️ Batal', `ctp:${s.cpage || 0}`));
});

bot.callbackQuery(/^cty:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  const chatId = ctx.chat.id, msgId = ctx.callbackQuery.message.message_id;
  if (!s.exServer) { const v = pickerView(true); return edit(chatId, msgId, v.text, v.kb); }
  s.country = ctx.match[1]; s.filter = null; s.search = null; s.searchCountry = false;
  await showServices(chatId, msgId, ctx.from.id, s.exServer, 0);
});

const isEx = (s) => !!s.country && s.country !== 'id';
const svReopen = (s, server) => (isEx(s) ? `cty:${s.country}` : `srv:${server}`);   // buka ulang daftar layanan
const svUp = (s) => (isEx(s) ? `ctp:${s.cpage || 0}` : 'reg:id');                                  // naik satu level

async function showServices(chatId, msgId, uid, server, page) {
  const s = S(uid);
  let all;
  try {
    all = s.filter && s.filterServer === server ? s.filter : await getServices(server);
  } catch (e) {
    return edit(chatId, msgId, `⚠️ Gagal memuat daftar layanan.\n${errText({ error: e.message })}`,
      new InlineKeyboard().text('🔄 Coba Lagi', svReopen(s, server)).row().text('⬅️ Kembali', svUp(s)));
  }
  const u = await getUser(uid);
  const pg = paginate(all, page, PER_PAGE);
  const kb = new InlineKeyboard().text('🔍 CARI LAYANAN', `svs:${server}`).row();
  pg.items.forEach((sv, i) => {
    kb.text(UP(clip(sv.name, 22)), `sv:${server}:${sv.code}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  if (!pg.items.length) kb.text('TIDAK ADA LAYANAN YANG COCOK', 'noop').row();
  navRow(kb, pg.page, pg.total, `svp:${server}`);
  kb.text('⬅️ Kembali', svUp(s));
  const cInfo = countryInfo(s.country);
  const judul = s.filter && s.filterServer === server ? `🔍 HASIL: <i>${esc(s.filterQ)}</i>` : 'PILIH LAYANAN:';
  await edit(chatId, msgId, [
    `${SERVERS[server].label.split(' ')[0]} <b>Server ${SERVERS[server].name}</b>`,
    ...(cInfo ? [`🌍 Negara : ${cInfo[1]} ${esc(cInfo[2])}`] : []), LINE,
    `💰 Saldo : <b>${rp(u.saldo)}</b>`, LINE,
    `${judul} (${pg.page + 1}/${pg.total})`,
  ].join('\n'), kb);
}

bot.callbackQuery(/^srv:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const server = ctx.match[1];
  if (!SERVERS[server]) return;
  const s = S(ctx.from.id);
  s.country = 'id'; s.filter = null; s.search = null; s.searchCountry = false;
  await showServices(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, server, 0);
});

bot.callbackQuery(/^svp:(\w+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showServices(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.callbackQuery(/^svs:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  s.search = ctx.match[1]; s.searchCountry = false;
  s.chatId = ctx.chat.id;
  s.msgId = ctx.callbackQuery.message.message_id;
  await render(ctx, '🔍 <b>CARI LAYANAN</b>\n\nKetik nama aplikasi yang kamu cari, contoh: <code>whatsapp</code>',
    new InlineKeyboard().text('⬅️ Batal', svReopen(s, ctx.match[1])));
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const s = S(ctx.from.id);
  if (s.searchCountry) {
    ctx.deleteMessage().catch(() => {});
    const q = text.toLowerCase();
    s.cfilter = countryEntries(s.exServer).filter((c) => c[2].toLowerCase().includes(q) || c[0] === q);
    s.cfilterQ = clip(text, 30);
    s.searchCountry = false;
    return showCountries(s.chatId, s.msgId, ctx.from.id, 0);
  }
  if (s.awaitDeposit) {
    ctx.deleteMessage().catch(() => {});
    s.awaitDeposit = false;
    const n = Number(text.replace(/[^\d]/g, ''));
    if (!n) {
      return edit(s.chatId, s.msgId, '⚠️ Nominal tidak valid. Ketik angka saja, contoh: <code>75000</code>',
        new InlineKeyboard().text('⬅️ Kembali', 'dep'));
    }
    const fakeCtx = { chat: { id: s.chatId }, from: ctx.from, callbackQuery: { message: { message_id: s.msgId } } };
    return startDeposit(fakeCtx, n);
  }
  if (!s.search) return ctx.reply('Ketik /start untuk membuka menu utama.').catch(() => {});
  ctx.deleteMessage().catch(() => {});
  const q = text.toLowerCase();
  const server = s.search;
  let all;
  try { all = await getServices(server); } catch { return; }
  s.filter = all.filter((x) => String(x.name).toLowerCase().includes(q) || String(x.code).toLowerCase() === q);
  s.filterServer = server;
  s.filterQ = clip(text, 30);
  s.search = null;
  await showServices(s.chatId, s.msgId, ctx.from.id, server, 0);
});

/* ============================== HARGA ================================ */
async function loadPrices(ctx, server, code, operator) {
  const s = S(ctx.from.id);
  let name = code;
  try { name = (await getServices(server)).find((x) => String(x.code) === code)?.name || code; } catch { /* abaikan */ }
  await render(ctx, '⏳ Mengambil harga terbaru...');
  const country = s.country || 'id';
  const cInfo = countryInfo(country);
  const query = { server, service: code, country };
  const r = await bn('/prices', { query });
  const back = new InlineKeyboard().text('⬅️ Kembali', svReopen(s, server));
  if (!r.ok) {
    const netErr = ['NETWORK', 'SERVER_UNREACHABLE'].includes(r.error);
    return render(ctx, `⚠️ ${cInfo && !netErr ? 'Layanan ini belum tersedia untuk negara / server tersebut.' : errText(r)}`, back);
  }
  // Negara asing: buang produk yang sebenarnya produk Indonesia (+62) supaya tidak salah beli.
  const providers = (cInfo ? foreignOnly(r, country, await baselineIds(server, code)) : (r.providers || []).filter((p) => p.stock > 0))
    .sort((a, b) => a.price_idr - b.price_idr);
  if (cInfo && !providers.length) {
    return render(ctx, `😔 <b>${esc(name)} belum tersedia untuk negara ini di server ${SERVERS[server].name}</b>\n\nCoba negara atau server lain.`, back);
  }
  if (!providers.length) {
    return render(ctx, `😔 <b>Stok ${esc(name)} sedang kosong</b>\n\nCoba server lain atau kembali lagi nanti.`, back);
  }
  Object.assign(s, { server, service: code, serviceName: cInfo ? `${cInfo[1]} ${name}` : name, providers, pricePage: 0, operator: operator || null });
  await showPrices(ctx, 0);
}

bot.callbackQuery(/^sv:(\w+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, server, code] = ctx.match;
  if (!SERVERS[server]) return;
  const s = S(ctx.from.id);
  await loadPrices(ctx, server, code);
});

async function showPrices(ctx, page) {
  const s = S(ctx.from.id);
  if (!s.providers) return expired(ctx);
  const [mk, u] = await Promise.all([getMarkup(), getUser(ctx.from.id)]);
  const pg = paginate(s.providers, page, PER_PAGE);
  s.pricePage = pg.page;
  const kb = new InlineKeyboard();
  pg.items.forEach((p, i) => {
    const harga = calcJual(p.price_idr, mk).toLocaleString('id-ID');
    kb.text(`${harga} | 📦 ${p.stock}`, `pr:${pg.page * PER_PAGE + i}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  navRow(kb, pg.page, pg.total, 'prp');
  kb.text('⬅️ Kembali', svReopen(s, s.server));
  await render(ctx, [
    `📱 <b>${esc(UP(s.serviceName))}</b> · ${SERVERS[s.server].label}`, LINE,
    `💰 Saldo : <b>${rp(u.saldo)}</b>`,
    `🔄 Update : ${wibTime()} WIB`, LINE,
    `Pilih harga (Rp): (${pg.page + 1}/${pg.total})`,
    '<i>📦 = stok tersedia</i>',
  ].join('\n'), kb);
}

const expired = (ctx) =>
  render(ctx, '⌛ <b>Sesi habis</b>\n\nSilakan mulai lagi dari menu Buat Order.', new InlineKeyboard().text('🛒 Buat Order', 'ord'));

bot.callbackQuery(/^prp:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPrices(ctx, Number(ctx.match[1]));
});

bot.callbackQuery(/^pr:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  const p = s.providers?.[Number(ctx.match[1])];
  if (!p) return expired(ctx);
  const [mk, u] = await Promise.all([getMarkup(), getUser(ctx.from.id)]);
  const jual = calcJual(p.price_idr, mk);
  const cukup = u.saldo >= jual;
  const kb = new InlineKeyboard();
  if (cukup) kb.text('✅ Beli Sekarang', `buy:${ctx.match[1]}`).row();
  else kb.text('💰 Deposit Saldo', 'dep').row();
  kb.text('⬅️ Kembali', `prp:${s.pricePage || 0}`);
  await render(ctx, [
    '🧾 <b>Konfirmasi Order</b>', LINE,
    `📱 LAYANAN : <b>${esc(UP(s.serviceName))}</b>`,
    `🖥 Server  : ${SERVERS[s.server].label}`,
    `💰 Harga   : <b>${rp(jual)}</b>`,
    `👛 Saldo   : ${rp(u.saldo)}`, LINE,
    cukup ? 'Saldo dipotong saat order diproses, lalu dikembalikan otomatis jika order gagal, dibatalkan, atau OTP tidak masuk.' : '⚠️ Saldo kamu belum cukup untuk order ini.',
  ].join('\n'), kb);
});

/* ============================== ORDER ================================ */
const cancelRemaining = (o) => (o.created_at
  ? Math.max(0, Math.ceil(CANCEL_WAIT_S - (Date.now() - new Date(o.created_at).getTime()) / 1000)) : 0);
const fmtMS = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const countdownMsgs = new Map();   // order.id -> { mid, stop } pesan yang sedang menampilkan hitung mundur

const ICON = { pending: '⏳', resend_wait: '⏳', received: '✅', cancelled: '❌', expired: '❌' };
const STATUS_HEAD = {
  pending: '⏳ <b>MENUNGGU OTP</b>',
  resend_wait: '⏳ <b>MENUNGGU SMS KE-2</b>',
  received: '✅ <b>OTP DITERIMA</b>',
  cancelled: '❌ <b>ORDER DIBATALKAN</b>',
  expired: '❌ <b>ORDER KEDALUWARSA</b>',
};

function formatPhoneForDisplay(phone, country = 'id') {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return String(phone || '-');
  const cc = String(country || 'id').toLowerCase();
  if (cc === 'id') {
    if (d.startsWith('62')) return `+${d}`;
    if (d.startsWith('0')) return `+62${d.slice(1)}`;
    if (d.startsWith('8')) return `+62${d}`;
  }
  return `+${d}`;
}

function orderView(o) {
  const country = o.country || (String(o.phone_number || '').startsWith('62') ? 'id' : '');
  const nomor = formatPhoneForDisplay(o.phone_number, country);
  const t = [
    STATUS_HEAD[o.status] || `<b>${esc(UP(o.status))}</b>`, LINE,
    `📱 <b>Layanan</b> : ${esc(UP(o.service_name || o.service_code))}`,
    `🖥 <b>Server</b>   : ${SERVERS[o.server]?.label || esc(o.server)}`,
    `📞 <b>Nomor</b>    : <code>${esc(nomor)}</code>`,
    `💰 <b>Harga</b>    : ${rp(o.harga_jual)}`,
    `🧾 <b>Order</b>    : #${o.id}`, LINE,
  ];
  const kb = new InlineKeyboard();
  if (o.status === 'pending') {
    const sisa = cancelRemaining(o);
    t.push('📲 Tempel nomor di atas ke aplikasi tujuan. OTP akan muncul otomatis di chat ini.', '⏱ <b>Berlaku ± 19 menit</b>');
    if (sisa > 0) {
      t.push(`⏳ Pembatalan tersedia dalam <b>${fmtMS(sisa)}</b>`);
      kb.text(`⏳ Batal dalam ${fmtMS(sisa)}`, `cxw:${o.id}`).row();
    } else {
      kb.text('❌ Batalkan Order', `cx:${o.id}`).row();
    }
  } else if (o.status === 'resend_wait') {
    t.push('📨 SMS ke-2 sudah diminta.', '⏳ Mohon tunggu OTP berikutnya...');
  } else if (o.status === 'received') {
    t.push(`🔑 <b>Kode OTP</b> : <code>${esc(o.otp_code)}</code>`);
    if (o.otp_code_2) t.push(`🔑 <b>OTP ke-2</b> : <code>${esc(o.otp_code_2)}</code>`);
    if (o.full_sms) t.push(`💬 <i>${esc(o.full_sms)}</i>`);
    if (!o.resend_used) kb.text('🔁 Minta SMS ke-2 (gratis)', `rs:${o.id}`).row();
  } else {
    t.push(`💸 Saldo ${rp(o.harga_jual)} sudah dikembalikan.`);
  }
  kb.text('🛒 Order Lagi', 'ord').text('📜 Riwayat', 'hist:0').row().text('🏠 Menu Utama', 'home');
  return { text: t.join('\n'), kb };
}

async function notifyOrder(o, fresh = false) {
  const { text, kb } = orderView(o);
  let mid = o.message_id;
  try {
    if (fresh) {
      const m = await bot.api.sendMessage(o.chat_id, text, { parse_mode: 'HTML', reply_markup: kb });
      if (o.message_id) bot.api.deleteMessage(o.chat_id, o.message_id).catch(() => {});
      mid = m.message_id;
    } else {
      mid = await edit(o.chat_id, o.message_id, text, kb);
    }
  } catch (e) { console.error('notifyOrder gagal:', e.message); return; }
  if (mid !== o.message_id) await db.from('otp_orders').update({ message_id: mid }).eq('id', o.id);
  o.message_id = mid;
}

async function refundOrder(o, newStatus) {
  const { data } = await db.from('otp_orders')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', o.id).eq('status', 'pending').select().maybeSingle();
  if (!data) return false;          // sudah diproses (mencegah refund ganda)
  await credit(data.user_id, data.harga_jual);
  await notifyOrder(data, true);
  return true;
}

const watching = new Set();
async function watchOrder(o, phase = 1) {
  if (watching.has(o.id)) return;
  watching.add(o.id);
  const t0 = Date.now();
  let cd = null;                       // hitung mundur tombol batal (hanya fase 1)
  if (phase === 1 && cancelRemaining(o) > 0) { cd = { mid: o.message_id, stop: false }; countdownMsgs.set(o.id, cd); }
  const limit = phase === 1 ? 35 * 60000 : 12 * 60000;
  const dead = ['cancelled', 'expired', 'refunded'];
  try {
    while (Date.now() - t0 < limit) {
      await sleep(POLL_MS);
      const s = await bn('/status', { query: { order_id: o.provider_order_id } });
      if (!s.ok) continue;
      if (phase === 1) {
        if (s.status === 'received' && s.otp_code) {
          const { data } = await db.from('otp_orders')
            .update({ status: 'received', otp_code: s.otp_code, full_sms: s.full_sms ?? null, updated_at: new Date().toISOString() })
            .eq('id', o.id).eq('status', 'pending').select().maybeSingle();
          if (data) { statsCache.at = 0; await notifyOrder(data, true); postMonitorOtp(data).catch(() => {}); }
          return;
        }
        if (dead.includes(s.status)) { await refundOrder(o, s.status === 'expired' ? 'expired' : 'cancelled'); return; }
        if (cd && !cd.stop) {
          if (cancelRemaining(o) === 0) cd.stop = true;
          await notifyOrder(o);
          cd.mid = o.message_id;
        }
      } else {
        if (s.status === 'received' && s.otp_code_2) {
          const { data } = await db.from('otp_orders')
            .update({ status: 'received', otp_code_2: s.otp_code_2, full_sms: s.full_sms ?? null, updated_at: new Date().toISOString() })
            .eq('id', o.id).eq('status', 'resend_wait').select().maybeSingle();
          if (data) { await notifyOrder(data, true); postMonitorOtp(data).catch(() => {}); }
          return;
        }
        if (dead.includes(s.status)) break;
      }
    }
    if (phase === 1) {
      notifyAdmins(`⚠️ Order #${o.id} (provider ${o.provider_order_id}) masih pending >35 menit. Cek manual.`);
    } else {
      const { data } = await db.from('otp_orders')
        .update({ status: 'received', updated_at: new Date().toISOString() })
        .eq('id', o.id).eq('status', 'resend_wait').select().maybeSingle();
      if (data) await notifyOrder(data, true);
    }
  } catch (e) {
    console.error('watchOrder error', o.id, e.message);
  } finally {
    watching.delete(o.id);
    countdownMsgs.delete(o.id);
  }
}

bot.callbackQuery(/^buy:(\d+)$/, async (ctx) => {
  const uid = ctx.from.id;
  if (buying.has(uid)) return ctx.answerCallbackQuery({ text: 'Sedang diproses...' });
  buying.add(uid);
  try {
    const s = S(uid);
    const p = s.providers?.[Number(ctx.match[1])];
    if (!p) { await ctx.answerCallbackQuery(); return expired(ctx); }
    const mk = await getMarkup();
    if (mk.maintenance) { await ctx.answerCallbackQuery({ text: 'Sedang maintenance.', show_alert: true }); return; }
    const jual = calcJual(p.price_idr, mk);

    await ctx.answerCallbackQuery();
    await render(ctx, '⏳ <b>Memeriksa stok terbaru...</b>');

    // CEK ULANG ke pusat sebelum saldo dipotong: kalau harga pusat sudah naik / stok berubah,
    // order ditolak dengan pesan "stok habis" (supaya kamu tidak rugi).
    const reload = new InlineKeyboard()
      .text('🔄 Muat Ulang Harga', `sv:${s.server}:${s.service}`).row().text('🏠 Menu Utama', 'home');
    const fresh = await bn('/prices', { query: { server: s.server, service: s.service, country: s.country || 'id' } });
    if (!fresh.ok) return render(ctx, `⚠️ ${errText(fresh)}`, reload);
    const buyCountry = s.country || 'id';
    const list = buyCountry !== 'id'
      ? foreignOnly(fresh, buyCountry, await baselineIds(s.server, s.service))
      : (fresh.providers || []).filter((x) => x.stock > 0);
    // Wajib produk yang SAMA persis dengan yang dipilih (id sama, harga tidak naik).
    // Dulu ada cadangan "produk lain dengan harga sama" -> inilah yang membuat nomor acak.
    const cur = list.find((x) => x.id === p.id && x.price_idr <= p.price_idr);
    if (!cur) {
      return render(ctx, '😔 <b>Stok sedang habis</b>\n\nStok atau harga pilihan ini baru saja berubah, jadi order dibatalkan sebelum saldo terpotong. Silakan muat ulang harga dan pilih lagi.', reload);
    }

    if (!(await debit(uid, jual))) {
      return render(ctx, '⚠️ <b>Saldo tidak cukup</b>\n\nSilakan isi saldo dulu.',
        new InlineKeyboard().text('💰 Deposit Saldo', 'dep').row().text('🏠 Menu Utama', 'home'));
    }
    await render(ctx, '⏳ <b>Memproses order...</b>\nMohon tunggu sebentar.');

    const body = (id) => {
      if (s.server === 'premium') return { id, operator: 'any' };   // operator tidak dipilih user (acak)
      return { id };
    };
    const r = await bn('/order', { method: 'POST', body: body(cur.id) });
    // PENGAMAN: minta negara luar tapi nomor yang diberikan pusat BUKAN nomor negara itu (mis. +62) ->
    // batalkan otomatis di pusat, saldo user dikembalikan, negara disembunyikan dari daftar.
    if (r.ok && (s.country || 'id') !== 'id' && !phoneMatchesCountry(r.phone_number, s.country)) {
      await credit(uid, jual);
      markBadCountry(s.server, s.country);
      notifyAdmins(`🚨 Order #${r.order_id}: user minta negara ${s.country} (${s.server}) tapi nomor ${r.phone_number} BUKAN nomor negara itu. Order dibatalkan otomatis, negara disembunyikan dari daftar.`);
      cancelProviderOrder(r.order_id).catch(() => {});
      return render(ctx, '⚠️ <b>Order gagal</b>\n\nNomor untuk negara ini sedang tidak tersedia, jadi order dibatalkan otomatis.\n\n💸 Saldo kamu tidak terpotong.',
        new InlineKeyboard().text('🌍 Pilih Negara Lain', 'reg:ex').row().text('🏠 Menu Utama', 'home'));
    }
    if (r.ok && (s.country || 'id') !== 'id' && r.country && String(r.country).toLowerCase() !== String(s.country).toLowerCase()) {
      notifyAdmins(`🚨 Order #${r.order_id}: user minta negara ${s.country} tapi yang diberikan ${r.country} (${r.phone_number}). Cek API dibanana.id!`);
    }
    if (r.ok && Number(r.price_idr) > p.price_idr) {
      notifyAdmins(`⚠️ Order #${r.order_id}: modal Rp${r.price_idr} lebih besar dari harga tampil Rp${p.price_idr}. Cek margin.`);
    }
    if (!r.ok) {
      await credit(uid, jual);
      console.error(`order gagal | server=${s.server} svc=${s.service} negara=${s.country || 'id'} operator=${s.operator || '-'} |`, JSON.stringify(r));
      if (['INSUFFICIENT_BALANCE', 'INVALID_API_KEY'].includes(r.error)) {
        notifyAdmins(`🚨 Order gagal: ${r.error}. Cek saldo / API key dibanana.id!`);
        if (r.error === 'INSUFFICIENT_BALANCE') checkCenterBalance().catch(() => {});
      }
      return render(ctx, `⚠️ <b>Order gagal</b>\n\n${errText(r)}\n\n💸 Saldo kamu tidak terpotong.`,
        new InlineKeyboard().text('⬅️ Pilih Harga Lain', `prp:${s.pricePage || 0}`).row().text('🏠 Menu Utama', 'home'));
    }

    const { data: row, error } = await db.from('otp_orders').insert({
      user_id: uid, provider_order_id: r.order_id, service_code: s.service, service_name: s.serviceName,
      server: s.server, phone_number: r.phone_number, country: (s.country || 'id').toLowerCase(), harga_modal: r.price_idr ?? p.price_idr, harga_jual: jual,
      status: 'pending', chat_id: ctx.chat.id, message_id: ctx.callbackQuery.message.message_id,
    }).select().single();
    if (error || !row) {
      console.error('insert order gagal', error?.message);
      notifyAdmins(`🚨 Order provider #${r.order_id} (${r.phone_number}) sukses tapi gagal disimpan ke DB. User ${uid}, harga ${rp(jual)}.`);
      return render(ctx, '⚠️ Terjadi gangguan saat menyimpan order. Hubungi admin.', homeBtn());
    }
    lastMenu.delete(uid);      // supaya /start tidak menghapus pesan order ini
    statsCache.at = 0;
    await notifyOrder(row);
    watchOrder(row);
  } finally {
    buying.delete(uid);
  }
});

// Batalkan order di pusat (dicoba berulang sampai pusat mengizinkan) untuk memulihkan modal.
async function cancelProviderOrder(orderId) {
  for (let i = 0; i < 20; i++) {
    const c = await bn('/cancel', { method: 'POST', body: { order_id: orderId } });
    if (c.ok) return true;
    if (['SMS_ALREADY_RECEIVED', 'CANNOT_CANCEL', 'ORDER_NOT_FOUND'].includes(c.error)) break;
    await sleep(15000);
  }
  notifyAdmins(`⚠️ Order #${orderId} (nomor salah negara) gagal dibatalkan otomatis. Batalkan manual di dibanana.id.`);
  return false;
}

async function ownOrder(id, uid) {
  const { data } = await db.from('otp_orders').select('*').eq('id', id).eq('user_id', uid).maybeSingle();
  return data;
}

bot.callbackQuery(/^cxw:(\d+)$/, async (ctx) => {
  const o = await ownOrder(Number(ctx.match[1]), ctx.from.id);
  const sisa = o ? cancelRemaining(o) : 0;
  return ctx.answerCallbackQuery({
    text: sisa > 0 ? `⏳ Pembatalan baru bisa dilakukan dalam ${fmtMS(sisa)}.` : 'Tombol batal sudah aktif. Buka ulang pesan order ini.',
    show_alert: true,
  });
});

bot.callbackQuery(/^cx:(\d+)$/, async (ctx) => {
  const o = await ownOrder(Number(ctx.match[1]), ctx.from.id);
  if (!o || o.status !== 'pending') {
    return ctx.answerCallbackQuery({ text: 'Order ini tidak bisa dibatalkan.', show_alert: true });
  }
  const sisa = cancelRemaining(o);
  if (sisa > 0) {
    return ctx.answerCallbackQuery({ text: `⏳ Pembatalan baru bisa dilakukan dalam ${fmtMS(sisa)}.`, show_alert: true });
  }
  const r = await bn('/cancel', { method: 'POST', body: { order_id: o.provider_order_id } });
  if (!r.ok) {
    const msg = {
      TOO_EARLY: '⏱ Order ini belum bisa dibatalkan. Coba lagi sebentar.',
      SMS_ALREADY_RECEIVED: 'OTP sudah masuk, order tidak bisa dibatalkan.',
      CANNOT_CANCEL: 'Order ini sudah tidak bisa dibatalkan (statusnya sudah berubah).',
      ORDER_NOT_FOUND: 'Order tidak ditemukan. Hubungi CS.',
    }[r.error] || errText(r);
    return ctx.answerCallbackQuery({ text: msg, show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: 'Order dibatalkan, saldo dikembalikan.' });
  await refundOrder(o, 'cancelled');
});

bot.callbackQuery(/^rs:(\d+)$/, async (ctx) => {
  const o = await ownOrder(Number(ctx.match[1]), ctx.from.id);
  if (!o || o.status !== 'received' || o.resend_used) {
    return ctx.answerCallbackQuery({ text: 'SMS ke-2 tidak tersedia untuk order ini.', show_alert: true });
  }
  const r = await bn('/resend', { method: 'POST', body: { order_id: o.provider_order_id } });
  if (!r.ok) return ctx.answerCallbackQuery({ text: errText(r), show_alert: true });
  await ctx.answerCallbackQuery({ text: 'Permintaan SMS ke-2 dikirim.' });
  const { data } = await db.from('otp_orders')
    .update({ status: 'resend_wait', resend_used: true, message_id: ctx.callbackQuery.message.message_id, updated_at: new Date().toISOString() })
    .eq('id', o.id).select().single();
  if (!data) return;
  await notifyOrder(data);
  watchOrder(data, 2);
});

/* ============================== RIWAYAT ============================== */
bot.callbackQuery(/^hist:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = Number(ctx.match[1]);
  const from = page * HIST_PER_PAGE;
  const { data, count } = await db.from('otp_orders')
    .select('id,service_name,service_code,status,harga_jual', { count: 'exact' })
    .eq('user_id', ctx.from.id).order('created_at', { ascending: false }).range(from, from + HIST_PER_PAGE - 1);
  const kb = new InlineKeyboard();
  if (!data?.length) {
    return render(ctx, '📜 <b>Riwayat Order</b>\n\nBelum ada order.', new InlineKeyboard().text('🛒 Buat Order', 'ord').row().text('🏠 Menu Utama', 'home'));
  }
  data.forEach((o) => kb.text(`${ICON[o.status] || '•'} #${o.id} · ${UP(clip(o.service_name || o.service_code, 14))} · ${rp(o.harga_jual)}`, `od:${o.id}`).row());
  const total = Math.max(1, Math.ceil((count || 0) / HIST_PER_PAGE));
  if (total > 1) navRow(kb, page, total, 'hist');
  kb.text('🏠 Menu Utama', 'home');
  await render(ctx, `📜 <b>Riwayat Order</b>\n${LINE}\nTotal ${count} order. Tekan salah satu untuk melihat detail.`, kb);
});

bot.callbackQuery(/^od:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const o = await ownOrder(Number(ctx.match[1]), ctx.from.id);
  if (!o) return;
  const { text, kb } = orderView(o);
  await render(ctx, text, kb);
});

/* ============================ ADMIN SEMENTARA ======================== */
// /addsaldo <id_telegram> <jumlah>  — hanya untuk ADMIN_IDS (untuk tes sebelum gateway jadi)
bot.command('updatenegara', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  if (negaraRunning) return ctx.reply('⏳ Pembaruan daftar negara sedang berjalan.');
  await ctx.reply('🌍 Memperbarui daftar negara... (± 5-10 menit). Kamu akan dapat kabar kalau sudah selesai.');
  refreshNegara(true).then((ok) => ctx.reply(ok
    ? `✅ Daftar negara diperbarui: Ekonomi ${negaraDb.ekonomi?.length ?? 0}, Premium ${negaraDb.premium?.length ?? 0}, Khusus ${negaraDb.khusus?.length ?? 0}.`
    : '⚠️ Gagal memperbarui daftar negara. Cek log PM2.')).catch(() => {});
});

bot.command('addsaldo', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const [id, amt] = String(ctx.match).trim().split(/\s+/).map(Number);
  if (!id || !amt || amt <= 0) return ctx.reply('Format: /addsaldo <id_telegram> <jumlah>');
  if (!(await getUser(id))) return ctx.reply('User belum pernah /start di bot.');
  await credit(id, amt);
  const u = await getUser(id);
  ctx.reply(`✅ Saldo user ${id} ditambah ${rp(amt)}. Saldo sekarang ${rp(u.saldo)}.`);
});

/* ============================== JALANKAN ============================= */
bot.catch((err) => console.error('Bot error:', err.error?.message || err.message || err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

async function resumePending() {
  const { data } = await db.from('otp_orders').select('*').in('status', ['pending', 'resend_wait']);
  (data || []).forEach((o) => watchOrder(o, o.status === 'resend_wait' ? 2 : 1));
  console.log(`🔄 Melanjutkan ${data?.length || 0} order yang masih menunggu OTP`);
  // deposit QRIS yang masih pending saat bot restart juga harus terus dipantau (kalau tidak, saldo tidak masuk)
  const { data: deps } = await db.from('otp_deposits').select('*').eq('status', 'pending');
  (deps || []).forEach((d) => watchDeposit(d));
  console.log(`🔄 Melanjutkan ${deps?.length || 0} deposit yang masih menunggu pembayaran`);
}

bot.api.setMyCommands([{ command: 'start', description: 'Buka menu utama' }]).catch(() => {});
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

bot.start({
  onStart: async (me) => {
    console.log(`✅ ${BRAND} berjalan sebagai @${me.username}`);
    await resumePending();
    setInterval(() => sweepLateDeposits(), 3 * 60000).unref();               // kreditkan deposit yang dibayar telat
    setTimeout(() => checkCenterBalance(), 15000);                            // cek saldo pusat setelah bot siap
    setInterval(() => checkCenterBalance(), CENTER_BALANCE_CHECK_MS).unref(); // alarm saldo pusat tiap 10 menit saat habis
    setTimeout(() => refreshNegara(false), 20000);                           // cek daftar negara setelah bot siap
    setInterval(() => refreshNegara(false), 6 * 3600 * 1000).unref();        // dan diperiksa tiap 6 jam (diperbarui bila >24 jam)
  },
});
