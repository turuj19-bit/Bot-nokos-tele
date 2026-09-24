/**
 * ============================================================
 *  PEDIA OTP — Bot Telegram Nokos / OTP (versi user)
 *  Stack : Node.js 22 + grammy + Supabase + API dibanana.id + Doku (QRIS)
 * ============================================================
 *
 *  FILE .env (satu folder dengan bot.js):
 *    BOT_TOKEN=token_bot_PEDIA_OTP_dari_BotFather
 *    SUPABASE_URL=https://xxxx.supabase.co
 *    SUPABASE_SERVICE_ROLE_KEY=xxxx
 *    BANANA_API_KEY=bn_live_xxxx
 *    CHANNEL_URL=https://t.me/pediaotp
 *    ADMIN_IDS=            # opsional, pisahkan koma (untuk notif + /addsaldo)
 *    MONITOR_CHANNEL_URL=https://t.me/monitornokos    # opsional, default sudah diisi
 *    MONITOR_CHANNEL_ID=@monitornokos                 # opsional; bot HARUS jadi admin channel ini
 *    CEKNOMOR_URL=https://t.me/Ceknomerdisini_bot     # opsional, default sudah diisi
 *    DOKU_CLIENT_ID=xxxx        # WAJIB diisi untuk deposit QRIS aktif (lihat blok DOKU QRIS di bawah)
 *    DOKU_SECRET_KEY=xxxx
 *    DOKU_BASE_URL=https://api-sandbox.doku.com   # ganti ke https://api.doku.com saat live
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
 *      chat_id bigint not null,
 *      message_id bigint,
 *      expired_at timestamptz,
 *      created_at timestamptz not null default now(),
 *      updated_at timestamptz not null default now()
 *    );
 *
 *  INSTALL :  npm i grammy @supabase/supabase-js dotenv qrcode
 *  JALANKAN:  pm2 start bot.js --name pedia-otp
 * ============================================================
 */
'use strict';
require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

/* ============================ KONFIGURASI ============================ */
const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BANANA_API_KEY } = process.env;
for (const [k, v] of Object.entries({ BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BANANA_API_KEY })) {
  if (!v) { console.error(`❌ .env belum lengkap: ${k} kosong`); process.exit(1); }
}

const BRAND = 'PEDIA OTP';
const TAGLINE = 'Layanan Nomor OTP Instan &amp; Terpercaya';
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/pediaotp';
const CS_URL = process.env.CS_URL || 'https://t.me/farishost1';   // chat admin / CS
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

// Menu Monitor (siaran real-time OTP & deposit) & menu Cek Nomor
const MONITOR_CHANNEL_URL = process.env.MONITOR_CHANNEL_URL || 'https://t.me/monitornokos';
const MONITOR_CHANNEL_ID = process.env.MONITOR_CHANNEL_ID
  || ('@' + MONITOR_CHANNEL_URL.replace(/^https?:\/\/t\.me\//, ''));   // bot wajib admin di channel ini
const CEKNOMOR_URL = process.env.CEKNOMOR_URL || 'https://t.me/Ceknomerdisini_bot';

const BN_BASE = 'https://dibanana.id/api/v1';
const POLL_MS = 5000;      // jeda cek OTP ke dibanana.id
const PER_PAGE = 12;       // tombol per halaman (layanan / harga)
const HIST_PER_PAGE = 8;   // riwayat per halaman
const LINE = '━━━━━━━━━━━━━━━━━━';

// Server yang dijual (kode = parameter "server" di API dibanana.id)
const SERVERS = {
  ekonomi: { label: '💰 Ekonomi', name: 'Ekonomi', desc: 'Stok banyak, harga murah, tanpa menunggu pembatalan 2 menit' },
  premium: { label: '👑 Premium', name: 'Premium', desc: 'Stok banyak, harga bersaing, OTP rate sangat tinggi' },
  khusus:  { label: '⭐ Khusus',  name: 'Khusus',  desc: 'Stok sangat melimpah, harga murah, lengkap pilihan produknya' },
};
const SERVERS_ID = ['ekonomi', 'premium', 'khusus'];              // menu Nomor Indonesia
const SERVERS_EX = ['ekonomi', 'premium', 'khusus'];              // menu Nomor Luar Negeri

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
function countryInfo(code) {           // -> [kode, bendera, nama] atau null untuk Indonesia / kode tak valid
  if (!code || code === 'id') return null;
  let cc = String(code).toUpperCase();
  if (cc === 'UK') cc = 'GB';
  if (!VALID_CC.has(cc)) return null;
  let n; try { n = dnId.of(cc); } catch { n = undefined; }
  return [code, flagOf(cc), n && n !== cc ? n : cc];
}
let negaraDb = {};                     // { at, ekonomi:[kode], premium:[kode], khusus:[kode] }
try {
  const j = JSON.parse(fs.readFileSync(NEGARA_FILE, 'utf8'));
  if (j && !Array.isArray(j)) negaraDb = j;
} catch { /* belum ada */ }
function countryEntries(server) {
  const codes = Array.isArray(negaraDb[server]) ? negaraDb[server] : FALLBACK_CODES;
  return codes.map(countryInfo).filter(Boolean).sort((a, b) => a[2].localeCompare(b[2], 'id'));
}

const CAND = [...VALID_CC].filter((c) => c !== 'ID');

let negaraRunning = false;
async function probeServices(server) {   // kode layanan WhatsApp & Telegram di server itu
  try {
    const list = await getServices(server);
    const pick = (re) => list.find((x) => re.test(String(x.name)));
    const codes = [pick(/whatsapp/i), pick(/telegram/i)].filter(Boolean).map((x) => String(x.code));
    if (codes.length) return codes;
  } catch { /* pakai bawaan */ }
  return ['wa', 'tg'];
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
    if (r?.ok && (r.providers || []).some((p) => p.stock > 0)) return true;
    await sleep(200);
  }
  return false;
}
async function refreshNegara(force = false) {
  if (negaraRunning) return false;
  if (!force && negaraDb.at && Date.now() - negaraDb.at < 24 * 3600 * 1000) return false;
  negaraRunning = true;
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
      let list = found;
      if (list.includes('gb') && list.includes('uk')) list = list.filter((c) => c !== 'uk');
      if (stat.answered < 50) { console.error(`   ${server}: API jarang menjawab, daftar lama dipertahankan`); continue; }
      negaraDb[server] = list.sort();
      fs.writeFileSync(NEGARA_FILE, JSON.stringify(negaraDb));
      console.log(`   ${server}: ${list.length} negara`);
    }
    negaraDb.at = Date.now();
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
  switch (r?.error) {
    case 'NO_NUMBERS': return 'Stok nomor untuk pilihan ini sedang habis. Coba harga atau layanan lain.';
    case 'INVALID_PRODUCT_ID': return 'Harga berubah. Silakan pilih ulang.';
    case 'INSUFFICIENT_BALANCE':
    case 'INVALID_API_KEY': return 'Layanan sedang gangguan. Coba lagi beberapa saat lagi.';
    case 'SERVER_UNREACHABLE':
    case 'NETWORK': return 'Server penyedia sedang tidak merespons. Coba lagi sebentar lagi.';
    default: return `Terjadi kesalahan (${r?.error || 'unknown'}). Coba lagi.`;
  }
}

/* ============================== API DOKU (QRIS) ======================== */
// ⚠️ PENTING — BACA DULU SEBELUM DIPAKAI TRANSAKSI SUNGGUHAN:
// Bagian ini butuh Client ID + Secret Key asli dari akun Doku kamu, dan endpoint
// di bawah mengikuti pola umum API Doku, tapi WAJIB kamu cocokkan dulu dengan
// dokumentasi/contoh kode resmi dari dashboard Doku milikmu (nama field & endpoint
// bisa berbeda tergantung produk Doku yang kamu pakai). Jangan aktifkan untuk
// transaksi nyata sebelum berhasil dites di sandbox Doku.
const { DOKU_CLIENT_ID, DOKU_SECRET_KEY } = process.env;
const DOKU_BASE_URL = process.env.DOKU_BASE_URL || 'https://api-sandbox.doku.com';
const DOKU_READY = !!(DOKU_CLIENT_ID && DOKU_SECRET_KEY);
if (!DOKU_READY) {
  console.error('⚠️ DOKU_CLIENT_ID / DOKU_SECRET_KEY belum diisi di .env — menu Deposit belum akan berfungsi sampai ini diisi.');
}

async function dokuRequest(path, { method = 'POST', body } = {}) {
  if (!DOKU_READY) return { ok: false, message: 'Pembayaran QRIS belum dikonfigurasi. Hubungi admin.' };
  try {
    const res = await fetch(DOKU_BASE_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': DOKU_CLIENT_ID,
        Authorization: `Bearer ${DOKU_SECRET_KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let data; try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data) return { ok: false, message: data?.message || `Doku error (HTTP ${res.status})` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function dokuCreateQris(uid, totalAmount) {
  const invoiceId = `DEPO-${uid}-${Date.now().toString(36).toUpperCase()}`;
  const r = await dokuRequest('/qris/v1.0/qr-mpm-generate', {
    body: {
      partnerReferenceNo: invoiceId,
      amount: { value: `${totalAmount}.00`, currency: 'IDR' },
      validityPeriod: new Date(Date.now() + 20 * 60000).toISOString(),
    },
  });
  if (!r.ok) return { ok: false, message: r.message };
  const qrString = r.data.qrContent || r.data.qr_string || r.data.qrisUrl;
  if (!qrString) return { ok: false, message: 'Respons Doku tidak berisi data QR.' };
  return {
    ok: true,
    invoiceId,
    qrString,
    expiredAt: r.data.validityPeriod || new Date(Date.now() + 20 * 60000).toISOString(),
  };
}

async function dokuCheckStatus(invoiceId) {
  const r = await dokuRequest('/qris/v1.0/qr-mpm-query', { body: { partnerReferenceNo: invoiceId } });
  if (!r.ok) return { ok: false };
  const raw = String(r.data.transactionStatusDesc || r.data.status || '').toLowerCase();
  let status = 'pending';
  if (raw.includes('success') || raw.includes('paid') || raw.includes('settlement')) status = 'paid';
  else if (raw.includes('expire')) status = 'expired';
  else if (raw.includes('cancel')) status = 'cancelled';
  else if (raw.includes('fail') || raw.includes('deny')) status = 'failed';
  return { ok: true, status };
}

async function dokuCancelQris(invoiceId) {
  return dokuRequest('/qris/v1.0/qr-mpm-cancel', { body: { partnerReferenceNo: invoiceId } });
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
  if (Date.now() - settingsCache.at < 30000) return settingsCache.data;
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

bot.command('start', async (ctx) => {
  sessions.delete(ctx.from.id);
  const prev = lastMenu.get(ctx.from.id);
  if (prev) ctx.api.deleteMessage(ctx.chat.id, prev).catch(() => {});
  const m = await ctx.reply(await dashboardText(ctx.user), {
    parse_mode: 'HTML', reply_markup: mainKb(), link_preview_options: { is_disabled: true },
  });
  lastMenu.set(ctx.from.id, m.message_id);
});

bot.callbackQuery('home', async (ctx) => {
  await ctx.answerCallbackQuery();
  sessions.delete(ctx.from.id);
  await render(ctx, await dashboardText(ctx.user), mainKb());
  lastMenu.set(ctx.from.id, ctx.callbackQuery.message.message_id);
});

bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

/* ============================ DEPOSIT (QRIS DOKU) ===================== */
const DEPOSIT_PRESETS = [10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const DEPOSIT_MIN = 1000;
const DEPOSIT_MAX = 10000000;
const QRIS_FEE_PERSEN = Number(process.env.QRIS_FEE_PERSEN ?? 0.7); // biaya qris dibebankan ke user, sesuaikan bila perlu

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
  await showDepositPicker(ctx);
});

bot.callbackQuery('depc', async (ctx) => {
  await ctx.answerCallbackQuery();
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
  return [
    '📱 <b>INVOICE QRIS</b>', LINE,
    `🧾 ID Transaksi : <code>${esc(row.invoice_id)}</code>`,
    '💳 Metode : <b>QRIS (Instan)</b>',
    `⏰ Expired : ${exp} WIB`, LINE,
    '<b>RINCIAN PEMBAYARAN</b>',
    `💵 Nominal Topup : ${rp(row.nominal)}`,
    `💸 Biaya QRIS : ${rp(row.fee)}`, LINE,
    `💰 Total Bayar : <b>${rp(row.total)}</b>`,
    `🏦 Saldo Masuk : <b>${rp(row.nominal)}</b>`, LINE,
    '⏳ <i>Menunggu pembayaran...</i>',
    `📲 Scan QRIS di atas, bayar tepat sejumlah <b>${rp(row.total)}</b>.`,
  ].join('\n');
}

async function showDepositInvoice(ctx, row, qrString) {
  const kb = new InlineKeyboard().text('❌ Batalkan Pembayaran', `depx:${row.id}`).row().text('🏠 Menu Utama', 'home');
  const capt = depositInvoiceText(row, 'pending');
  try {
    const png = await QRCode.toBuffer(qrString, { width: 512, margin: 1 });
    const m = await bot.api.sendPhoto(ctx.chat.id, new InputFile(png, 'qris.png'), {
      caption: capt, parse_mode: 'HTML', reply_markup: kb,
    });
    await db.from('otp_deposits').update({ message_id: m.message_id }).eq('id', row.id);
    row.message_id = m.message_id;
    row.is_photo = true;
  } catch (e) {
    console.error('kirim QR gagal:', e.message);
    const m = await bot.api.sendMessage(ctx.chat.id, capt, { parse_mode: 'HTML', reply_markup: kb });
    await db.from('otp_deposits').update({ message_id: m.message_id }).eq('id', row.id);
    row.message_id = m.message_id;
    row.is_photo = false;
  }
}

async function startDeposit(ctx, nominal) {
  if (!Number.isFinite(nominal) || nominal < DEPOSIT_MIN || nominal > DEPOSIT_MAX) {
    return render(ctx, `⚠️ Nominal deposit minimal ${rp(DEPOSIT_MIN)} dan maksimal ${rp(DEPOSIT_MAX)}.`,
      new InlineKeyboard().text('⬅️ Kembali', 'dep'));
  }
  await render(ctx, '⏳ <b>Membuat invoice QRIS...</b>\nMohon tunggu sebentar.');
  const fee = Math.ceil((nominal * QRIS_FEE_PERSEN) / 100);
  const total = nominal + fee;
  const inv = await dokuCreateQris(ctx.from.id, total);
  if (!inv.ok) {
    return render(ctx, `⚠️ <b>Gagal membuat invoice deposit</b>\n\n${esc(inv.message || 'Layanan pembayaran sedang gangguan.')}`,
      new InlineKeyboard().text('🔄 Coba Lagi', `depn:${nominal}`).row().text('⬅️ Kembali', 'dep'));
  }
  const { data: row, error } = await db.from('otp_deposits').insert({
    user_id: ctx.from.id, invoice_id: inv.invoiceId, nominal, fee, total,
    status: 'pending', chat_id: ctx.chat.id, expired_at: inv.expiredAt,
  }).select().single();
  if (error || !row) {
    console.error('insert deposit gagal', error?.message);
    return render(ctx, '⚠️ Terjadi gangguan saat menyimpan transaksi deposit. Hubungi admin.', homeBtn());
  }
  await showDepositInvoice(ctx, row, inv.qrString);
  watchDeposit(row);
}

bot.callbackQuery(/^depx:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { data: row } = await db.from('otp_deposits').select('*').eq('id', Number(ctx.match[1])).eq('user_id', ctx.from.id).maybeSingle();
  if (!row || row.status !== 'pending') {
    return ctx.answerCallbackQuery({ text: 'Transaksi ini sudah tidak bisa dibatalkan.', show_alert: true });
  }
  const { data } = await db.from('otp_deposits')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'pending').select().maybeSingle();
  if (!data) return;
  dokuCancelQris(data.invoice_id).catch(() => {});
  await editDepositMessage(data, 'cancelled');
});

async function editDepositMessage(row, status) {
  const text = depositInvoiceText(row, status);
  const kb = new InlineKeyboard().text('💰 Deposit Lagi', 'dep').row().text('🏠 Menu Utama', 'home');
  try {
    await bot.api.editMessageCaption(row.chat_id, row.message_id, { caption: text, parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    const d = String(e.description || e.message || '');
    if (d.includes('message is not modified')) return;
    // Pesan aslinya teks biasa (bukan foto QR), coba edit sebagai teks
    try {
      await bot.api.editMessageText(row.chat_id, row.message_id, text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e2) {
      const d2 = String(e2.description || e2.message || '');
      if (!d2.includes('message is not modified')) console.error('editDepositMessage gagal:', d2);
    }
  }
}

const watchingDep = new Set();
async function watchDeposit(row) {
  if (watchingDep.has(row.id)) return;
  watchingDep.add(row.id);
  const t0 = Date.now();
  const limit = 30 * 60000;
  try {
    while (Date.now() - t0 < limit) {
      await sleep(POLL_MS);
      const st = await dokuCheckStatus(row.invoice_id);
      if (!st.ok) continue;
      if (st.status === 'paid') {
        const { data } = await db.from('otp_deposits')
          .update({ status: 'paid', updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'pending').select().maybeSingle();
        if (data) {
          await credit(data.user_id, data.nominal);
          await editDepositMessage(data, 'paid');
          postMonitorDeposit(data).catch(() => {});
        }
        return;
      }
      if (['expired', 'cancelled', 'failed'].includes(st.status)) {
        const { data } = await db.from('otp_deposits')
          .update({ status: st.status, updated_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'pending').select().maybeSingle();
        if (data) await editDepositMessage(data, st.status);
        return;
      }
    }
    const { data } = await db.from('otp_deposits')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'pending').select().maybeSingle();
    if (data) await editDepositMessage(data, 'expired');
  } finally {
    watchingDep.delete(row.id);
  }
}

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
    '3️⃣ Bot akan membuatkan <b>kode QRIS</b> otomatis, lengkap dengan rincian nominal, biaya QRIS, dan total yang harus dibayar',
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
    '└ Pilih negara, banyak pilihan', LINE,
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
  const v = pickerView(true);
  await render(ctx, v.text, v.kb);
});

async function showCountries(chatId, msgId, uid, page) {
  const s = S(uid);
  const server = s.exServer;
  if (!server) { const v = pickerView(true); return edit(chatId, msgId, v.text, v.kb); }
  const base = countryEntries(server);
  const head = `${SERVERS[server].label.split(' ')[0]} <b>Server ${SERVERS[server].name}</b>`;
  if (!base.length) {
    return edit(chatId, msgId, `🌍 <b>Nomor Luar Negeri</b>\n${head}\n${LINE}\nBelum ada negara yang tersedia di server ini. Coba server lain.`,
      new InlineKeyboard().text('⬅️ Kembali', 'reg:ex'));
  }
  const all = s.cfilter || base;
  const pg = paginate(all, page, PER_PAGE);
  const kb = new InlineKeyboard().text('🔍 Cari Negara', 'ctq').row();
  pg.items.forEach((c, i) => {
    kb.text(clip(`${c[1]} ${c[2]}`, 24), `cty:${c[0]}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  if (!pg.items.length) kb.text('Negara tidak ditemukan', 'noop').row();
  navRow(kb, pg.page, pg.total, 'ctp');
  kb.text('⬅️ Kembali', 'reg:ex');
  const judul = s.cfilter ? `🔍 Hasil: <i>${esc(s.cfilterQ)}</i>` : 'Pilih negara:';
  const info = negaraRunning && !Array.isArray(negaraDb[server]) ? '\n<i>ℹ️ Daftar negara sedang diperbarui.</i>' : '';
  await edit(chatId, msgId, [`🌍 <b>Nomor Luar Negeri</b>`, head, LINE, `${judul} (${pg.page + 1}/${pg.total})${info}`].join('\n'), kb);
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
    new InlineKeyboard().text('⬅️ Batal', 'ctp:0'));
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
const svUp = (s) => (isEx(s) ? 'ctp:0' : 'reg:id');                                  // naik satu level

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
  const kb = new InlineKeyboard().text('🔍 Cari Layanan', `svs:${server}`).row();
  pg.items.forEach((sv, i) => {
    kb.text(clip(sv.name, 22), `sv:${server}:${sv.code}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  if (!pg.items.length) kb.text('Tidak ada layanan yang cocok', 'noop').row();
  navRow(kb, pg.page, pg.total, `svp:${server}`);
  kb.text('⬅️ Kembali', svUp(s));
  const cInfo = countryInfo(s.country);
  const judul = s.filter && s.filterServer === server ? `🔍 Hasil: <i>${esc(s.filterQ)}</i>` : 'Pilih layanan:';
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
  await render(ctx, '🔍 <b>Cari Layanan</b>\n\nKetik nama aplikasi yang kamu cari, contoh: <code>whatsapp</code>',
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
// Pilihan operator (hanya untuk server Khusus di Nomor Indonesia, lihat OPERATORS di bawah)
const OPERATORS = [
  { code: 'any', label: 'Any (Random)' },
  { code: 'xl', label: 'XL/AXIS' },
  { code: 'indosat', label: 'Indosat' },
  { code: 'telkomsel', label: 'Telkomsel' },
  { code: 'three', label: 'Three' },
  { code: 'smartfren', label: 'Smartfren' },
];

// Cek stok real tiap operator ke API pusat (dibanana.id), bukan pajangan statis.
async function operatorHasStock(server, code, country, operatorCode) {
  const query = { server, service: code, country };
  if (operatorCode) query.operator = operatorCode;
  const r = await bn('/prices', { query });
  return !!(r.ok && (r.providers || []).some((p) => p.stock > 0));
}

async function showOperatorPicker(ctx, server, code, name) {
  const s = S(ctx.from.id);
  const country = s.country || 'id';
  const header = [`${SERVERS[server].label.split(' ')[0]} <b>${esc(name)} — Server ${SERVERS[server].name}</b>`, LINE];
  const back = new InlineKeyboard().text('⬅️ Kembali', svReopen(s, server));
  await render(ctx, [...header, '⏳ Mengecek stok tiap operator ke server pusat...'].join('\n'));

  let checks;
  try {
    checks = await Promise.all(OPERATORS.map(async (op) => ({
      op, ok: await operatorHasStock(server, code, country, op.code),
    })));
  } catch {
    return render(ctx, [...header, '⚠️ Gagal mengambil data stok dari server pusat. Coba lagi.'].join('\n'), back);
  }

  const avail = checks.filter((c) => c.ok).map((c) => c.op);
  if (!avail.length) {
    return render(ctx, [...header, `😔 Stok ${esc(name)} sedang kosong untuk semua operator.`].join('\n'), back);
  }

  const kb = new InlineKeyboard();
  const any = avail.find((o) => o.code === 'any');
  const rest = avail.filter((o) => o.code !== 'any');
  if (any) kb.text(any.label, `op:${server}:${code}:${any.code}`).row();
  rest.forEach((op, i) => {
    kb.text(op.label, `op:${server}:${code}:${op.code}`);
    if (i % 2 === 1) kb.row();
  });
  if (rest.length % 2 === 1) kb.row();
  kb.text('⬅️ Kembali', svReopen(s, server));

  await render(ctx, [...header, 'Pilih operator (hanya yang stoknya tersedia yang tampil):'].join('\n'), kb);
}

async function loadPrices(ctx, server, code, operator) {
  const s = S(ctx.from.id);
  let name = code;
  try { name = (await getServices(server)).find((x) => String(x.code) === code)?.name || code; } catch { /* abaikan */ }
  await render(ctx, '⏳ Mengambil harga terbaru...');
  const country = s.country || 'id';
  const cInfo = countryInfo(country);
  const query = { server, service: code, country };
  if (operator) query.operator = operator;
  const r = await bn('/prices', { query });
  const back = new InlineKeyboard().text('⬅️ Kembali', svReopen(s, server));
  if (!r.ok) {
    const netErr = ['NETWORK', 'SERVER_UNREACHABLE'].includes(r.error);
    return render(ctx, `⚠️ ${cInfo && !netErr ? 'Layanan ini belum tersedia untuk negara / server tersebut.' : errText(r)}`, back);
  }
  const providers = (r.providers || []).filter((p) => p.stock > 0).sort((a, b) => a.price_idr - b.price_idr);
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
  const country = s.country || 'id';
  if (server === 'khusus' && country === 'id') {
    let name = code;
    try { name = (await getServices(server)).find((x) => String(x.code) === code)?.name || code; } catch { /* abaikan */ }
    return showOperatorPicker(ctx, server, code, name);
  }
  await loadPrices(ctx, server, code);
});

bot.callbackQuery(/^op:(\w+):([^:]+):(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, server, code, operator] = ctx.match;
  if (!SERVERS[server] || !OPERATORS.some((o) => o.code === operator)) return;
  await loadPrices(ctx, server, code, operator);
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
    `📱 <b>${esc(s.serviceName)}</b> · ${SERVERS[s.server].label}`, LINE,
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
    `📱 Layanan : <b>${esc(s.serviceName)}</b>`,
    `🖥 Server  : ${SERVERS[s.server].label}`,
    `💰 Harga   : <b>${rp(jual)}</b>`,
    `👛 Saldo   : ${rp(u.saldo)}`, LINE,
    cukup ? 'Saldo akan dipotong setelah nomor berhasil didapat.' : '⚠️ Saldo kamu belum cukup untuk order ini.',
  ].join('\n'), kb);
});

/* ============================== ORDER ================================ */
const ICON = { pending: '⏳', resend_wait: '⏳', received: '✅', cancelled: '❌', expired: '⌛' };
const STATUS_HEAD = {
  pending: '⏳ <b>Menunggu OTP</b>',
  resend_wait: '⏳ <b>Menunggu SMS ke-2</b>',
  received: '✅ <b>OTP Diterima</b>',
  cancelled: '❌ <b>Order Dibatalkan</b>',
  expired: '⌛ <b>Order Kedaluwarsa</b>',
};

function orderView(o) {
  const t = [
    STATUS_HEAD[o.status] || `<b>${esc(o.status)}</b>`, LINE,
    `📱 Layanan : <b>${esc(o.service_name || o.service_code)}</b>`,
    `🖥 Server  : ${SERVERS[o.server]?.label || esc(o.server)}`,
    `📞 Nomor   : <code>${esc(o.phone_number)}</code>`,
    `💰 Harga   : ${rp(o.harga_jual)}`,
    `🧾 Order   : #${o.id}`, LINE,
  ];
  const kb = new InlineKeyboard();
  if (o.status === 'pending') {
    t.push('Masukkan nomor di atas ke aplikasi tujuan. OTP akan muncul di sini otomatis.', '⏱ Berlaku ± 19 menit');
    kb.text('❌ Batalkan Order', `cx:${o.id}`).row();
  } else if (o.status === 'resend_wait') {
    t.push('SMS ke-2 sudah diminta. Mohon tunggu sebentar...');
  } else if (o.status === 'received') {
    t.push(`🔑 Kode OTP : <code>${esc(o.otp_code)}</code>`);
    if (o.otp_code_2) t.push(`🔑 OTP ke-2 : <code>${esc(o.otp_code_2)}</code>`);
    if (o.full_sms) t.push(`💬 <i>${esc(o.full_sms)}</i>`);
    if (!o.resend_used) kb.text('🔁 Minta SMS ke-2 (gratis)', `rs:${o.id}`).row();
  } else {
    t.push(`💸 Saldo ${rp(o.harga_jual)} sudah dikembalikan.`);
  }
  kb.text('🛒 Order Lagi', 'ord').text('📜 Riwayat', 'hist:0').row().text('🏠 Menu Utama', 'home');
  return { text: t.join('\n'), kb };
}

// fresh=true -> kirim pesan baru (supaya user dapat notifikasi) & hapus pesan lama
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
    const list = (fresh.providers || []).filter((x) => x.stock > 0);
    const cur = list.find((x) => x.id === p.id && x.price_idr <= p.price_idr)
      || list.find((x) => x.price_idr === p.price_idr);
    if (!cur) {
      return render(ctx, '😔 <b>Stok sedang habis</b>\n\nStok untuk pilihan ini baru saja habis. Silakan muat ulang harga dan coba lagi.', reload);
    }

    if (!(await debit(uid, jual))) {
      return render(ctx, '⚠️ <b>Saldo tidak cukup</b>\n\nSilakan isi saldo dulu.',
        new InlineKeyboard().text('💰 Deposit Saldo', 'dep').row().text('🏠 Menu Utama', 'home'));
    }
    await render(ctx, '⏳ <b>Memproses order...</b>\nMohon tunggu sebentar.');

    const body = (id) => {
      if (s.server === 'premium') return { id, operator: 'any' };
      if (s.server === 'khusus' && s.operator) return { id, operator: s.operator };
      return { id };
    };
    const r = await bn('/order', { method: 'POST', body: body(cur.id) });
    if (r.ok && Number(r.price_idr) > p.price_idr) {
      notifyAdmins(`⚠️ Order #${r.order_id}: modal Rp${r.price_idr} lebih besar dari harga tampil Rp${p.price_idr}. Cek margin.`);
    }
    if (!r.ok) {
      await credit(uid, jual);
      if (['INSUFFICIENT_BALANCE', 'INVALID_API_KEY'].includes(r.error)) {
        notifyAdmins(`🚨 Order gagal: ${r.error}. Cek saldo / API key dibanana.id!`);
      }
      return render(ctx, `⚠️ <b>Order gagal</b>\n\n${errText(r)}\n\n💸 Saldo kamu tidak terpotong.`,
        new InlineKeyboard().text('⬅️ Pilih Harga Lain', `prp:${s.pricePage || 0}`).row().text('🏠 Menu Utama', 'home'));
    }

    const { data: row, error } = await db.from('otp_orders').insert({
      user_id: uid, provider_order_id: r.order_id, service_code: s.service, service_name: s.serviceName,
      server: s.server, phone_number: r.phone_number, harga_modal: r.price_idr ?? p.price_idr, harga_jual: jual,
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

async function ownOrder(id, uid) {
  const { data } = await db.from('otp_orders').select('*').eq('id', id).eq('user_id', uid).maybeSingle();
  return data;
}

bot.callbackQuery(/^cx:(\d+)$/, async (ctx) => {
  const o = await ownOrder(Number(ctx.match[1]), ctx.from.id);
  if (!o || o.status !== 'pending') {
    return ctx.answerCallbackQuery({ text: 'Order ini tidak bisa dibatalkan.', show_alert: true });
  }
  const r = await bn('/cancel', { method: 'POST', body: { order_id: o.provider_order_id } });
  if (!r.ok) {
    const msg = {
      TOO_EARLY: '⏱ Pembatalan baru bisa dilakukan 2 menit setelah order dibuat.',
      SMS_ALREADY_RECEIVED: 'OTP sudah masuk, order tidak bisa dibatalkan.',
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
  if (!r.ok) return ctx.answerCallbackQuery({ text: r.message || errText(r), show_alert: true });
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
  data.forEach((o) => kb.text(`${ICON[o.status] || '•'} #${o.id} · ${clip(o.service_name || o.service_code, 14)} · ${rp(o.harga_jual)}`, `od:${o.id}`).row());
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
}

bot.api.setMyCommands([{ command: 'start', description: 'Buka menu utama' }]).catch(() => {});
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

bot.start({
  onStart: async (me) => {
    console.log(`✅ ${BRAND} berjalan sebagai @${me.username}`);
    await resumePending();
    setTimeout(() => refreshNegara(false), 20000);                           // cek daftar negara setelah bot siap
    setInterval(() => refreshNegara(false), 6 * 3600 * 1000).unref();        // dan diperiksa tiap 6 jam (diperbarui bila >24 jam)
  },
});
