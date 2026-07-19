/**
 * Family-shared document numbers (ADR 0022): a document created from
 * exactly one source document continues that transaction, so it inherits
 * the family's base number with the next letter — Estimate 412 becomes
 * Sales Order 412b, then Invoices 412c and 412d. A document with multiple
 * sources (or none) starts a new transaction and draws from its type
 * sequence instead. An explicitly provided number always wins.
 */

/**
 * The single source document a new document continues, or null. Only
 * same-side sources count: sales documents and purchase documents keep
 * separate numbering, so a PO ordering for a sales order starts its own
 * supply-side family rather than borrowing the customer's number.
 */
export function familySourceOf(
  documentSourceId: string | undefined,
  lines: readonly { sourceDocumentId: string | null }[],
  sameSide: (documentId: string) => boolean,
): string | null {
  const sources = new Set<string>();
  if (documentSourceId !== undefined) sources.add(documentSourceId);
  for (const line of lines) {
    if (line.sourceDocumentId !== null) sources.add(line.sourceDocumentId);
  }
  // Cross-side links are references, not lineage: they never number.
  const eligible = [...sources].filter(sameSide);
  return eligible.length === 1 ? eligible[0]! : null;
}

/**
 * The family base: the number with any trailing lowercase suffix removed,
 * provided a digit precedes it — "412b" → "412", "EST-0412" → "EST-0412".
 * The digit requirement keeps word-shaped numbers ("DRAFT") intact.
 */
export function familyBaseOf(number: string): string {
  const match = /^(.*\d)([a-z]+)$/.exec(number);
  return match ? match[1]! : number;
}

/** '' is the root (1); letters are bijective base 26: b=2 … z=26, aa=27. */
function suffixIndex(suffix: string): number {
  if (suffix === '') return 1;
  let value = 0;
  for (const char of suffix) value = value * 26 + (char.charCodeAt(0) - 96);
  return value;
}

function suffixLetters(index: number): string {
  let value = index;
  let letters = '';
  while (value > 0) {
    const digit = (value - 1) % 26;
    letters = String.fromCharCode(97 + digit) + letters;
    value = (value - digit - 1) / 26;
  }
  return letters;
}

/**
 * The next member number in the source's family: base + the letter after
 * the highest suffix in use anywhere in the books. Monotonic — letters of
 * voided or explicitly numbered members are never reused, so gaps can
 * appear but collisions cannot.
 */
export function nextFamilyNumber(sourceNumber: string, existingNumbers: Iterable<string>): string {
  const base = familyBaseOf(sourceNumber);
  let highest = 1; // the root itself
  for (const number of existingNumbers) {
    if (!number.startsWith(base)) continue;
    const suffix = number.slice(base.length);
    if (suffix !== '' && !/^[a-z]+$/.test(suffix)) continue; // "412" vs "4120": not family
    const index = suffixIndex(suffix);
    if (index > highest) highest = index;
  }
  return base + suffixLetters(highest + 1);
}
