// build.js — dijalankan otomatis oleh Vercel saat deploy (via "npm run build").
// Tugasnya: baca index.template.html, ganti semua __NAMA__ dengan Environment
// Variables asli yang kamu isi di dashboard Vercel, lalu simpan sebagai index.html.

const fs = require('fs');
const path = require('path');

const templatePath = path.join(__dirname, 'index.template.html');
const outputPath = path.join(__dirname, 'index.html');

const KEYS = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'BOT_TOKEN',
  'DOKU_CLIENT_ID',
  'DOKU_SECRET_KEY',
  'DOKU_BASE_URL',
];

let html = fs.readFileSync(templatePath, 'utf8');

for (const key of KEYS) {
  const value = process.env[key] || '';
  html = html.split(`__${key}__`).join(value);
}

fs.writeFileSync(outputPath, html);
console.log('index.html berhasil dibuat dari index.template.html dengan Environment Variables.');
