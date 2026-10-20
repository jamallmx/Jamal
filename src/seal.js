import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GENESIS = '0'.repeat(64);

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Key-sorted JSON so the same record always hashes to the same seal.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildPayload({ rental, kind, reading, notes, sealedAt, photos, staffSig, customerSig, prevSeal }) {
  return {
    v: 1,
    rental: rental.public_token,
    asset: rental.asset,
    customer: rental.customer_name,
    kind,
    reading,
    notes,
    sealed_at: sealedAt,
    photos: photos.map((p) => ({ slot: p.slot, sha256: p.sha256 })),
    staff_signature: staffSig,
    customer_signature: customerSig,
    prev_seal: prevSeal,
  };
}

export function sealOf(payload) {
  return sha256(stableStringify(payload));
}

export function ledgerHash(prevHash, sealHash, createdAt) {
  return sha256(`${prevHash}|${sealHash}|${createdAt}`);
}

export function appendLedger(db, inspectionId, sealHash) {
  const last = db.prepare('SELECT entry_hash FROM ledger ORDER BY id DESC LIMIT 1').get();
  const prevHash = last ? last.entry_hash : GENESIS;
  const createdAt = new Date().toISOString();
  const entryHash = ledgerHash(prevHash, sealHash, createdAt);
  db.prepare(
    'INSERT INTO ledger (inspection_id, seal_hash, prev_hash, entry_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(inspectionId, sealHash, prevHash, entryHash, createdAt);
  return entryHash;
}

export function shortCode(hash) {
  return hash.slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

function fileMatches(file, expected) {
  try {
    return sha256(fs.readFileSync(file)) === expected;
  } catch {
    return false;
  }
}

function ledgerIntact(db, inspection) {
  const entry = db.prepare('SELECT * FROM ledger WHERE inspection_id = ?').get(inspection.id);
  if (!entry || entry.seal_hash !== inspection.seal_hash) return false;
  let prev = GENESIS;
  for (const row of db.prepare('SELECT * FROM ledger WHERE id <= ? ORDER BY id').all(entry.id)) {
    if (row.prev_hash !== prev) return false;
    if (ledgerHash(row.prev_hash, row.seal_hash, row.created_at) !== row.entry_hash) return false;
    prev = row.entry_hash;
  }
  return true;
}

// Re-derives every seal from the stored files and rows; any edit to a photo,
// signature, note, or ledger entry after sealing makes a check fail.
export function verifyRental(db, uploadsDir, rental) {
  const inspections = db.prepare('SELECT * FROM inspections WHERE rental_id = ? ORDER BY id').all(rental.id);
  const checks = [];
  let prevSeal = null;

  for (const ins of inspections) {
    const photos = db.prepare('SELECT * FROM photos WHERE inspection_id = ? ORDER BY id').all(ins.id);
    const add = (key, ok) => checks.push({ kind: ins.kind, key, ok: Boolean(ok) });

    add(
      'check_files',
      photos.every((p) => fileMatches(path.join(uploadsDir, p.sha256 + p.ext), p.sha256)) &&
        fileMatches(path.join(uploadsDir, `${ins.staff_sig_sha}.png`), ins.staff_sig_sha) &&
        fileMatches(path.join(uploadsDir, `${ins.customer_sig_sha}.png`), ins.customer_sig_sha)
    );

    let payload = null;
    try {
      payload = JSON.parse(ins.payload);
    } catch {}
    add('check_seal', payload && sealOf(payload) === ins.seal_hash);

    const expected = buildPayload({
      rental,
      kind: ins.kind,
      reading: ins.reading,
      notes: ins.notes,
      sealedAt: ins.sealed_at,
      photos,
      staffSig: ins.staff_sig_sha,
      customerSig: ins.customer_sig_sha,
      prevSeal,
    });
    add('check_record', payload && stableStringify(payload) === stableStringify(expected));
    add('check_ledger', ledgerIntact(db, ins));

    prevSeal = ins.seal_hash;
  }

  return { ok: inspections.length > 0 && checks.every((c) => c.ok), checks, inspections };
}
