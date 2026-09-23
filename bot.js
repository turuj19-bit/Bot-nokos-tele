/**
 * ============================================================
 *  PEDIA OTP — Bot Telegram Nokos / OTP (versi user)
 *  Stack : Node.js 22 + grammy + Supabase + API dibanana.id
 * ============================================================
 *
 *  FILE .env (satu folder dengan bot.js):
 *    BOT_TOKEN=token_bot_PEDIA_OTP_dari_BotFather
 *    SUPABASE_URL=https://xxxx.supabase.co
 *    SUPABASE_SERVICE_ROLE_KEY=xxxx
 *    BANANA_API_KEY=bn_live_xxxx
 *    CHANNEL_URL=https://t.me/pediaotp
 *    ADMIN_IDS=            # opsional, pisahkan koma (untuk notif + /addsaldo)
 *
 *  INSTALL :  npm i grammy @supabase/supabase-js dotenv
 *  JALANKAN:  pm2 start bot.js --name pedia-otp
 * ============================================================
 */
'use strict';
require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const { createClient } = require('@supabase/supabase-js');

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

const BN_BASE = 'https://dibanana.id/api/v1';
const POLL_MS = 5000;      // jeda cek OTP ke dibanana.id
const PER_PAGE = 12;       // tombol per halaman (layanan / harga)
const HIST_PER_PAGE = 8;   // riwayat per halaman
const LINE = '━━━━━━━━━━━━━━━━━━';

// Server yang dijual (kode = parameter "server" di API dibanana.id)
const SERVERS = {
  ekonomi: { label: '💰 Ekonomi', name: 'Ekonomi', desc: 'Stok banyak, harga hemat' },
  premium: { label: '👑 Premium', name: 'Premium', desc: 'Kualitas OTP tinggi' },
  khusus:  { label: '⭐ Khusus',  name: 'Khusus',  desc: 'Pilihan produk paling lengkap' },
  wa_luar: { label: '📲 WhatsApp Luar Negeri', name: 'WhatsApp Luar Negeri', desc: 'Khusus WhatsApp nomor luar negeri' },
};
const SERVERS_ID = ['ekonomi', 'premium', 'khusus'];              // menu Nomor Indonesia
const SERVERS_EX = ['ekonomi', 'premium', 'khusus', 'wa_luar'];   // menu Nomor Luar Negeri

// Daftar negara [kode API, bendera, nama]. Mau tambah/kurangi negara? Edit di sini saja.
const COUNTRIES = [
  ['my', '🇲🇾', 'Malaysia'], ['sg', '🇸🇬', 'Singapura'], ['us', '🇺🇸', 'Amerika Serikat'], ['uk', '🇬🇧', 'Inggris'],
  ['th', '🇹🇭', 'Thailand'], ['vn', '🇻🇳', 'Vietnam'], ['ph', '🇵🇭', 'Filipina'], ['in', '🇮🇳', 'India'],
  ['kh', '🇰🇭', 'Kamboja'], ['mm', '🇲🇲', 'Myanmar'], ['hk', '🇭🇰', 'Hong Kong'], ['cn', '🇨🇳', 'China'],
  ['jp', '🇯🇵', 'Jepang'], ['kr', '🇰🇷', 'Korea Selatan'], ['au', '🇦🇺', 'Australia'], ['ca', '🇨🇦', 'Kanada'],
  ['ru', '🇷🇺', 'Rusia'], ['ua', '🇺🇦', 'Ukraina'], ['tr', '🇹🇷', 'Turki'], ['sa', '🇸🇦', 'Arab Saudi'],
  ['ae', '🇦🇪', 'Uni Emirat Arab'], ['eg', '🇪🇬', 'Mesir'], ['ng', '🇳🇬', 'Nigeria'], ['ke', '🇰🇪', 'Kenya'],
  ['pk', '🇵🇰', 'Pakistan'], ['bd', '🇧🇩', 'Bangladesh'], ['br', '🇧🇷', 'Brasil'], ['mx', '🇲🇽', 'Meksiko'],
  ['de', '🇩🇪', 'Jerman'], ['fr', '🇫🇷', 'Prancis'], ['es', '🇪🇸', 'Spanyol'], ['it', '🇮🇹', 'Italia'],
  ['nl', '🇳🇱', 'Belanda'], ['pl', '🇵🇱', 'Polandia'],
];
const countryInfo = (code) =>
  code && code !== 'id' ? (COUNTRIES.find((x) => x[0] === code) || [code, '🌍', String(code).toUpperCase()]) : null;

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
    .text('🛒 Buat Order', 'ord').text('💰 Deposit', 'dep').row()
    .text('📜 Riwayat Order', 'hist:0').text('ℹ️ Bantuan', 'help').row()
    .url('📢 Channel Resmi', CHANNEL_URL).url('💬 Hubungi CS', CS_URL);
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
  ctx.deleteMessage().catch(() => {});
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

/* ============================ DEPOSIT / BANTUAN ====================== */
// TODO: sambungkan ke payment gateway kamu (QRIS dinamis / Midtrans) di sini.
bot.callbackQuery('dep', async (ctx) => {
  await ctx.answerCallbackQuery();
  const u = await getUser(ctx.from.id);
  await render(ctx, [
    '💰 <b>Deposit Saldo</b>', LINE,
    `Saldo kamu : <b>${rp(u.saldo)}</b>`, '',
    '🚧 Deposit otomatis sedang disiapkan.',
    'Untuk isi saldo sementara, silakan hubungi CS kami.',
  ].join('\n'), new InlineKeyboard().url('💬 Hubungi CS', CS_URL).row().url('📢 Channel Resmi', CHANNEL_URL).row().text('⬅️ Kembali', 'home'));
});

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
    '',
    '💬 Ada kendala? Hubungi CS kami.',
  ].join('\n'), new InlineKeyboard().url('💬 Hubungi CS', CS_URL).row().url('📢 Channel Resmi', CHANNEL_URL).row().text('⬅️ Kembali', 'home'));
});

/* ============================== LAYANAN ============================== */
const svcCache = {};
async function getServices(server) {
  const c = svcCache[server];
  if (c && Date.now() - c.at < 10 * 60000) return c.data;
  const r = await bn('/services', { query: { server } });
  if (!r.ok) { if (c) return c.data; throw new Error(r.error || 'services'); }
  svcCache[server] = { at: Date.now(), data: r.services || [] };
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

function pickerView(country) {
  const c = countryInfo(country);
  const list = c ? SERVERS_EX : SERVERS_ID;
  const lines = ['🛒 <b>Buat Order</b>', LINE, c ? `🌍 Negara : ${c[1]} <b>${esc(c[2])}</b>` : '🇮🇩 <b>Nomor Indonesia</b>', '', 'Pilih server sesuai kebutuhanmu:', ''];
  const kb = new InlineKeyboard();
  for (const code of list) {
    const sv = SERVERS[code];
    lines.push(sv.label.replace(/^(\S+) (.+)$/, '$1 <b>$2</b>'), `└ ${sv.desc}`, '');
    kb.text(sv.label, `srv:${code}`).row();
  }
  kb.text('⬅️ Kembali', c ? 'ctp:0' : 'ord');
  lines.push(LINE);
  return { text: lines.join('\n'), kb };
}

bot.callbackQuery('reg:id', async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  s.country = 'id'; s.filter = null; s.search = null;
  const v = pickerView('id');
  await render(ctx, v.text, v.kb);
});

async function showCountries(ctx, page) {
  const pg = paginate(COUNTRIES, page, PER_PAGE);
  const kb = new InlineKeyboard();
  pg.items.forEach((c, i) => {
    kb.text(`${c[1]} ${c[2]}`, `cty:${c[0]}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  navRow(kb, pg.page, pg.total, 'ctp');
  kb.text('⬅️ Kembali', 'ord');
  await render(ctx, ['🌍 <b>Nomor Luar Negeri</b>', LINE, `Pilih negara: (${pg.page + 1}/${pg.total})`].join('\n'), kb);
}
bot.callbackQuery('reg:ex', async (ctx) => { await ctx.answerCallbackQuery(); await showCountries(ctx, 0); });
bot.callbackQuery(/^ctp:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showCountries(ctx, Number(ctx.match[1])); });

bot.callbackQuery(/^cty:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!COUNTRIES.some((c) => c[0] === ctx.match[1])) return;
  const s = S(ctx.from.id);
  s.country = ctx.match[1]; s.filter = null; s.search = null;
  const v = pickerView(s.country);
  await render(ctx, v.text, v.kb);
});

async function showServices(chatId, msgId, uid, server, page) {
  const s = S(uid);
  let all;
  try {
    all = s.filter && s.filterServer === server ? s.filter : await getServices(server);
  } catch (e) {
    return edit(chatId, msgId, `⚠️ Gagal memuat daftar layanan.\n${errText({ error: e.message })}`,
      new InlineKeyboard().text('🔄 Coba Lagi', `srv:${server}`).row().text('⬅️ Kembali', s.country && s.country !== 'id' ? `cty:${s.country}` : 'reg:id'));
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
  kb.text('⬅️ Kembali', s.country && s.country !== 'id' ? `cty:${s.country}` : 'reg:id');
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
  s.filter = null; s.search = null;
  await showServices(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, server, 0);
});

bot.callbackQuery(/^svp:(\w+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showServices(ctx.chat.id, ctx.callbackQuery.message.message_id, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.callbackQuery(/^svs:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = S(ctx.from.id);
  s.search = ctx.match[1];
  s.chatId = ctx.chat.id;
  s.msgId = ctx.callbackQuery.message.message_id;
  await render(ctx, '🔍 <b>Cari Layanan</b>\n\nKetik nama aplikasi yang kamu cari, contoh: <code>whatsapp</code>',
    new InlineKeyboard().text('⬅️ Batal', `srv:${ctx.match[1]}`));
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const s = S(ctx.from.id);
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
bot.callbackQuery(/^sv:(\w+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, server, code] = ctx.match;
  if (!SERVERS[server]) return;
  const s = S(ctx.from.id);
  let name = code;
  try { name = (await getServices(server)).find((x) => String(x.code) === code)?.name || code; } catch { /* abaikan */ }
  await render(ctx, '⏳ Mengambil harga terbaru...');
  const country = s.country || 'id';
  const cInfo = countryInfo(country);
  const r = await bn('/prices', { query: { server, service: code, country } });
  const back = new InlineKeyboard().text('⬅️ Kembali', `srv:${server}`);
  if (!r.ok) {
    const netErr = ['NETWORK', 'SERVER_UNREACHABLE'].includes(r.error);
    return render(ctx, `⚠️ ${cInfo && !netErr ? 'Layanan ini belum tersedia untuk negara / server tersebut.' : errText(r)}`, back);
  }
  const providers = (r.providers || []).filter((p) => p.stock > 0).sort((a, b) => a.price_idr - b.price_idr);
  if (!providers.length) {
    return render(ctx, `😔 <b>Stok ${esc(name)} sedang kosong</b>\n\nCoba server lain atau kembali lagi nanti.`, back);
  }
  Object.assign(s, { server, service: code, serviceName: cInfo ? `${cInfo[1]} ${name}` : name, providers, pricePage: 0 });
  await showPrices(ctx, 0);
});

async function showPrices(ctx, page) {
  const s = S(ctx.from.id);
  if (!s.providers) return expired(ctx);
  const [mk, u] = await Promise.all([getMarkup(), getUser(ctx.from.id)]);
  const pg = paginate(s.providers, page, PER_PAGE);
  s.pricePage = pg.page;
  const kb = new InlineKeyboard();
  pg.items.forEach((p, i) => {
    kb.text(`${rp(calcJual(p.price_idr, mk))} | 📦${p.stock}`, `pr:${pg.page * PER_PAGE + i}`);
    if (i % 2 === 1) kb.row();
  });
  if (pg.items.length % 2 === 1) kb.row();
  navRow(kb, pg.page, pg.total, 'prp');
  kb.text('⬅️ Kembali', `srv:${s.server}`);
  await render(ctx, [
    `📱 <b>${esc(s.serviceName)}</b> · ${SERVERS[s.server].label}`, LINE,
    `💰 Saldo : <b>${rp(u.saldo)}</b>`,
    `🔄 Update : ${wibTime()} WIB`, LINE,
    `Pilih harga: (${pg.page + 1}/${pg.total})`,
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
          if (data) { statsCache.at = 0; await notifyOrder(data, true); }
          return;
        }
        if (dead.includes(s.status)) { await refundOrder(o, s.status === 'expired' ? 'expired' : 'cancelled'); return; }
      } else {
        if (s.status === 'received' && s.otp_code_2) {
          const { data } = await db.from('otp_orders')
            .update({ status: 'received', otp_code_2: s.otp_code_2, full_sms: s.full_sms ?? null, updated_at: new Date().toISOString() })
            .eq('id', o.id).eq('status', 'resend_wait').select().maybeSingle();
          if (data) await notifyOrder(data, true);
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

    const body = (id) => (s.server === 'premium' ? { id, operator: 'any' } : { id });
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
  },
});
