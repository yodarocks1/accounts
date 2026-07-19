import { LedgerError } from './errors.js';
import type { DocumentStatus, DocumentType, DocumentView } from './documents.js';

/**
 * The document-link graph (ADR 0021): a pure read over document views
 * exposing what fulfillment, coverage, and deposit transfer each consume a
 * slice of — which lines link to which, across the whole family. Void
 * documents stay in the graph, labeled: hiding facts is nobody's job.
 */

/** One resolved end of a link: enough to display and navigate. */
export interface LinkEndpoint {
  readonly documentId: string;
  readonly type: DocumentType;
  readonly number: string;
  readonly label: string;
  readonly status: DocumentStatus;
  readonly lineId: string;
  readonly description: string;
}

/**
 * `conversion` = the consumer's document-level source is the linked
 * document (estimate→SO→invoice, PO→receipt→bill). `cross` = line-level
 * only (PO↔SO special orders, return↔invoice).
 */
export type LinkKind = 'conversion' | 'cross';

export interface DocumentLinkEdge {
  readonly from: string;
  /** Null for a document-level edge with no surviving line link. */
  readonly fromLineId: string | null;
  readonly to: string;
  readonly toLineId: string | null;
  readonly quantityMilli: bigint;
  readonly kind: LinkKind;
  readonly substituted: boolean;
}

export interface LineLinks {
  readonly lineId: string;
  readonly description: string;
  readonly quantityMilli: bigint;
  /** Where this line came from, if it links back to a source line. */
  readonly upstream: (LinkEndpoint & { kind: LinkKind }) | null;
  /** Every line anywhere that consumes this one. */
  readonly downstream: readonly (LinkEndpoint & { kind: LinkKind; quantityMilli: bigint })[];
}

export interface FamilyNode {
  readonly documentId: string;
  readonly type: DocumentType;
  readonly number: string;
  readonly label: string;
  readonly status: DocumentStatus;
  readonly date: string;
}

export interface DocumentLinks {
  readonly documentId: string;
  readonly lines: readonly LineLinks[];
  /** The connected component this document belongs to. */
  readonly family: {
    readonly nodes: readonly FamilyNode[];
    readonly edges: readonly DocumentLinkEdge[];
  };
}

/** All line-level edges plus document-level fallback edges, aggregated. */
function collectEdges(documents: readonly DocumentView[]): DocumentLinkEdge[] {
  const byId = new Map(documents.map((view) => [view.id, view]));
  const edges: DocumentLinkEdge[] = [];
  for (const view of documents) {
    let linkedToDocSource = false;
    for (const line of view.current.lines) {
      if (line.sourceDocumentId === null || line.sourceLineId === null) continue;
      if (!byId.has(line.sourceDocumentId)) continue; // dangling by deletion cannot happen; defensive
      if (line.sourceDocumentId === view.sourceDocumentId) linkedToDocSource = true;
      edges.push({
        from: line.sourceDocumentId,
        fromLineId: line.sourceLineId,
        to: view.id,
        toLineId: line.lineId,
        quantityMilli: line.quantityMilli,
        kind: line.sourceDocumentId === view.sourceDocumentId ? 'conversion' : 'cross',
        substituted: line.substituted,
      });
    }
    // Keep conversion chains connected even when no line link survives
    // (e.g. a correction rewrote the lines without sources).
    if (view.sourceDocumentId !== null && !linkedToDocSource && byId.has(view.sourceDocumentId)) {
      edges.push({
        from: view.sourceDocumentId,
        fromLineId: null,
        to: view.id,
        toLineId: null,
        quantityMilli: 0n,
        kind: 'conversion',
        substituted: false,
      });
    }
  }
  return edges;
}

function endpoint(view: DocumentView, lineId: string): LinkEndpoint {
  const line = view.current.lines.find((candidate) => candidate.lineId === lineId);
  return {
    documentId: view.id,
    type: view.type,
    number: view.number,
    label: view.label,
    status: view.status,
    lineId,
    description: line?.description ?? '(line no longer present)',
  };
}

export function computeDocumentLinks(documents: readonly DocumentView[], id: string): DocumentLinks {
  const byId = new Map(documents.map((view) => [view.id, view]));
  const target = byId.get(id);
  if (!target) {
    throw new LedgerError('UNKNOWN_DOCUMENT', `No such document: ${id}`);
  }
  const edges = collectEdges(documents);

  // Per-line upstream/downstream for the target document.
  const lines: LineLinks[] = target.current.lines.map((line) => {
    const upstreamEdge = edges.find((edge) => edge.to === id && edge.toLineId === line.lineId);
    const upstream =
      upstreamEdge && upstreamEdge.fromLineId !== null
        ? { ...endpoint(byId.get(upstreamEdge.from)!, upstreamEdge.fromLineId), kind: upstreamEdge.kind }
        : null;
    const downstream = edges
      .filter((edge) => edge.from === id && edge.fromLineId === line.lineId && edge.toLineId !== null)
      .map((edge) => ({
        ...endpoint(byId.get(edge.to)!, edge.toLineId!),
        kind: edge.kind,
        quantityMilli: edge.quantityMilli,
      }));
    return {
      lineId: line.lineId,
      description: line.description,
      quantityMilli: line.quantityMilli,
      upstream,
      downstream,
    };
  });

  // Connected component over the undirected edge set.
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string): void => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };
  for (const edge of edges) connect(edge.from, edge.to);
  const member = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (!member.has(next)) {
        member.add(next);
        queue.push(next);
      }
    }
  }
  const nodes: FamilyNode[] = [...member]
    .map((documentId) => byId.get(documentId)!)
    .sort((a, b) => (a.current.date === b.current.date ? (a.number < b.number ? -1 : 1) : a.current.date < b.current.date ? -1 : 1))
    .map((view) => ({
      documentId: view.id,
      type: view.type,
      number: view.number,
      label: view.label,
      status: view.status,
      date: view.current.date,
    }));
  const familyEdges = edges.filter((edge) => member.has(edge.from) && member.has(edge.to));

  return { documentId: id, lines, family: { nodes, edges: familyEdges } };
}
