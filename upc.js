'use strict';
// UPC matching.
//
// Razco's item file and BRdata store a UPC without its check digit
// (11 digits, zero padded). A scanner reads the full 12-digit UPC-A off the
// product. Same item, two spellings. This turns anything into one canonical
// 12-digit key, and produces an ordered list of candidates for a scan so the
// most trustworthy reading is tried first.

function digitsOf(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function strip(d) { return d.replace(/^0+/, ''); }

function checkDigit(d11) {
  if (!/^\d{11}$/.test(d11)) return null;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(d11[i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

function upceToUpca(e) {
  if (!/^[01]\d{7}$/.test(e)) return null;
  const ns = e[0], body = e.slice(1, 7), chk = e[7], last = body[5];
  let a;
  if (last === '0' || last === '1' || last === '2') a = ns + body.slice(0, 2) + last + '0000' + body.slice(2, 5);
  else if (last === '3') a = ns + body.slice(0, 3) + '00000' + body.slice(3, 5);
  else if (last === '4') a = ns + body.slice(0, 4) + '00000' + body[4];
  else a = ns + body.slice(0, 5) + '0000' + last;
  return a + chk;
}

// One canonical 12-digit key, or null when the code isn't UPC-shaped.
// Leading zeros are only trimmed when the code is too long to be a UPC:
// trimming first would turn an 11-digit file code into a false UPC-E.
function upcKey(raw) {
  let d = digitsOf(raw);
  if (!d) return null;
  if (d.length === 8 && /^[01]/.test(d)) { const a = upceToUpca(d); if (a) return a; }
  if (d.length > 12) d = strip(d);
  if (d.length === 14 && d.slice(0, 2) === '00') d = d.slice(2);
  if (d.length === 13 && d[0] === '0') d = d.slice(1);
  if (d.length === 12) return d;
  if (d.length <= 11) { const p = d.padStart(11, '0'); return p + checkDigit(p); }
  return null;
}

// Ordered readings of a scanned code, best first:
//   1. exactly as stored (digits, no leading zeros)
//   2. the same code with its check digit removed  <- the common case
//   3. canonical key of each
// Returns { raws: [...], keys: [...] } with duplicates removed, order kept.
function candidates(raw) {
  const d = strip(digitsOf(raw));
  const raws = [], keys = [];
  const pushRaw = v => { if (v && raws.indexOf(v) < 0) raws.push(v); };
  const pushKey = v => { if (v && keys.indexOf(v) < 0) keys.push(v); };
  if (!d) return { raws, keys };

  const full = digitsOf(raw);
  pushRaw(d);
  pushKey(upcKey(full));
  if (full.length >= 12) {
    const noCheck = full.slice(0, -1);
    pushRaw(strip(noCheck));
    pushKey(upcKey(noCheck));
  }
  if (full.length === 8 && /^[01]/.test(full)) {
    const a = upceToUpca(full);
    if (a) { pushRaw(strip(a)); pushKey(a); pushRaw(strip(a.slice(0, -1))); }
  }
  return { raws, keys };
}

// Do two codes refer to the same item? Used to verify a scan against a tag.
function sameItem(a, b) {
  if (!a || !b) return false;
  const A = candidates(a), B = candidates(b);
  const all = s => new Set(s.raws.concat(s.keys));
  const sa = all(A), sb = all(B);
  for (const v of sa) if (sb.has(v)) return true;
  return false;
}

module.exports = { upcKey, candidates, sameItem, checkDigit, upceToUpca, digitsOf };
