require('dotenv').config();

const restrictedNumbers = process.env.RESTRICTED_NUMBERS
  ? process.env.RESTRICTED_NUMBERS.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  : [];

function normalizeNumber(s) {
  return s ? s.toString().replace(/[^0-9]/g, '') : '';
}

function matchesPrefix(target, prefix) {
  const t = normalizeNumber(target);
  const p = normalizeNumber(prefix);
  if (!t || !p) return false;
  const variants = [p, '0' + p, '92' + p, '0092' + p];
  return variants.some(v => t.startsWith(v));
}

function matchesExact(target, prefix) {
  const t = normalizeNumber(target);
  const p = normalizeNumber(prefix);
  if (!t || !p) return false;
  const variants = [p, '0' + p, '92' + p, '0092' + p];
  return variants.some(v => t === v);
}

const samples = [
  '9123',
  '00929123',
  '09123',
  '9123123456',
  '91211',
  '009291211',
  '912200000',
  '001234567',
  '123456'
];

console.log('RESTRICTED_NUMBERS from .env =>', restrictedNumbers.join(','));
console.log('Testing samples:');
for (const s of samples) {
  const blocked = restrictedNumbers.some(prefix => {
    // Use exact-match logic (only block numbers that equal the restricted entries or their common variants)
    return matchesExact(s, prefix);
  });
  console.log(`${s} => ${blocked ? 'BLOCKED' : 'ALLOWED'}`);
}
