#!/usr/bin/env node
// Regression test for the 2026-09-02 incident where two ORDINARY documents were carrying live
// passwords in clear text — `Internal Projects/_PROJECT_OVERVIEW.md` and, worse, the rulebook
// about protecting passwords, `standards/credential-rotation-standard.md`.
//
// The values are out (moved to gitignored credential files) and have since been ROTATED, so the
// old ones are dead. This test is what stops the shape coming back: it re-derives, from the files
// themselves, whether any must-be-clean document carries a credential value again.
//
// It needs no secrets and reaches no network, so it is safe to run anywhere and any time.
//
// Detection is the same grammar `C:\ClaudeShared\hooks\status-doc-secret-guard.js` enforces on
// write — a credential LABEL and an opaque VALUE on the same line, scanned INDEPENDENTLY, never
// assuming they are neighbours. That adjacency assumption is exactly why three earlier automated
// passes over the overview returned zero while eleven values sat in it.
//
// Run: node test/status-docs-carry-no-passwords.test.mjs      (exit 0 = clean)

import fs from 'fs';

const MUST_BE_CLEAN = [
  'C:/Business/Internal Projects/_PROJECT_OVERVIEW.md',
  'C:/Business/Internal Projects/standards/credential-rotation-standard.md',
  'C:/Business/Internal Projects/standards/FIX-status-documents-carrying-live-passwords-2026-09-02.md',
  'C:/Business/Internal Projects/standards/FIX-rotate-every-leaked-password-2026-09-02.md',
];

const LABEL = /(pass\s?wor[dt]s?|passwd|passphrase|pass\s?phrase|\bpwd\b|site\s?gate|gate\s?(?:password|code)|api[\s_-]?keys?|secret\s?keys?|\bsecrets?\b|credentials?|htpasswd|basic\s?auth|access\s?keys?|bearer\s?token|auth\s?tokens?|\btokens?\b|\bpin\s?code\b)/i;
const PAIR_LABEL = /(\baccounts?\b|\blogins?\b|\bsign[\s-]?in\b|\bcredentials?\b|\busers?\b)/i;
const POINTER = [/<[^>]{1,60}>/, /\{\{[^}]+\}\}/, /\$\{[^}]+\}/, /\bsee\b/i, /\bstored\s+in\b/i,
  /\bgithub\s+secrets?\b/i, /\bredact(ed)?\b/i, /\bvalue\s+(moved|removed|lives|parked|retired)\b/i,
  /\*{3,}/, /\bx{4,}\b/i, /\bTBD\b|\bTODO\b|\bN\/A\b/i, /\benv(ironment)?\s+var/i,
  /Credentials?\.txt/i, /\.env\b/i];
const NOT_A_SECRET = [
  /^(AES|SHA|HMAC|RSA|ECDSA|TLS|SSL|MD5|PBKDF2|ARGON2|BCRYPT|SCRYPT)[-_]/i,
  /^v?\d+(\.\d+)+[A-Za-z0-9.-]*$/, /^\d{4}-\d{2}-\d{2}/, /^#[0-9A-Fa-f]{3,8}$/,
  /^[A-Z]{2,4}-\d{3}\.\d{3}\.\d{3}$/, /^(eu|us|ap|sa|ca|af|me)-[a-z]+-\d$/i,
  /^G-[A-Z0-9]{8,12}$/, /^(acct|cus|sub|price|prod|pi|ch|in)_[A-Za-z0-9]{8,}$/,
  /^[0-9a-f]{7,40}$/i, /^\d+[A-Za-z]{0,4}$/, /^\d{1,3}-[A-Za-z][A-Za-z-]{1,20}$/,
  /^[A-Za-z][A-Za-z-]{1,20}-v?\d{1,3}$/, /^[A-Za-z]+([+=&|][A-Za-z]+)+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];
const KNOWN_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|eyJ|AKIA|AIza|SG\.|re_|whsec_|shpat_|glpat-|npm_|hf_|dckr_pat_|sbp_)[A-Za-z0-9_.-]{12,}/;
const STRUCTURE = /[=$*?()<>[\]{}\\\/@|:;,.\s→~^%&+#'"`…—–]/;

function opaque(atomRaw) {
  const t = String(atomRaw).trim().replace(/^[`'"([*_~]+/, '').replace(/[`'"*_~,;:.!?)\]]+$/, '');
  if (KNOWN_PREFIX.test(t)) return t;
  if (t.length < 8 || t.length > 64) return null;
  if (STRUCTURE.test(t)) return null;
  if (/_/.test(t)) return null;
  if (!/[A-Za-z]/.test(t) || !/\d/.test(t)) return null;
  if (/^[A-Z][A-Z0-9-]*$/.test(t)) return null;
  if (NOT_A_SECRET.some(r => r.test(t))) return null;
  if (t.includes('-') && !t.split('-').some(s => s.length >= 6 && /[A-Za-z]/.test(s) && /\d/.test(s))) return null;
  return t;
}
function atoms(line) {
  const out = [];
  for (const m of line.matchAll(/`([^`]{5,80})`/g)) out.push(m[1]);
  for (const m of line.matchAll(/"([^"]{5,80})"/g)) out.push(m[1]);
  for (const m of line.matchAll(/'([^']{5,80})'/g)) out.push(m[1]);
  for (const m of line.matchAll(/\(([^)]{5,80})\)/g)) out.push(m[1]);
  for (const m of line.matchAll(/(?::|=|→|->|\/)\s*([^\s|`"'()<>]{6,64})/g)) out.push(m[1]);
  for (const t of line.split(/[\s|]+/)) if (t) out.push(t.replace(/^\*+|\*+$|^_+|_+$/g, ''));
  return out;
}

let failures = 0, checked = 0, missing = 0;
for (const file of MUST_BE_CLEAN) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { console.log(`SKIP (not on this machine): ${file}`); missing++; continue; }
  checked++;
  let tableLabel = false, hits = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    const isRow = /^\s*\|/.test(line);
    if (!isRow) tableLabel = false; else if (LABEL.test(line)) tableLabel = true;
    if (isRow && /^[\s|:.-]+$/.test(line)) return;
    const labelled = LABEL.test(line) || (isRow && tableLabel);
    const pairish = PAIR_LABEL.test(line) && /\S\s*\/\s*\S/.test(line);
    if (!labelled && !pairish) return;
    if (POINTER.some(r => r.test(line))) return;
    for (const a of atoms(line)) {
      const hit = opaque(a);
      if (!hit) continue;
      hits++;
      // NEVER print the finding — only where it is and how big it is.
      console.log(`FAIL ${file}:${i + 1} carries a credential label and a ${hit.length}-character opaque token on one line`);
      break;
    }
  });
  if (hits) failures += hits; else console.log(`ok   ${file} — no credential value on any line`);
}

if (missing === MUST_BE_CLEAN.length) {
  console.log('\nNone of the documents exist here; nothing was actually checked.');
  process.exit(1);
}
console.log(`\n${checked} document(s) checked, ${failures} value-bearing line(s) found.`);
if (failures) {
  console.log('A value belongs in the gitignored docs/Credentials.txt (or a repo secret). Put a');
  console.log('POINTER in the document naming where it lives, and ROTATE the value that leaked —');
  console.log('moving it does not un-compromise it. See standards/credential-rotation-standard.md.');
  process.exit(1);
}
process.exit(0);
