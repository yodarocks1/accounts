import { describe, expect, it } from 'vitest';
import { DocumentBook, computeDocumentLinks } from '../src/index.js';

/**
 * ADR 0021: the link graph. One family exercising every edge shape —
 * conversion chain (estimate → SO → invoice, partial), cross-link
 * (special-order PO → SO line), and a void consumer that stays visible.
 */
function buildFamily() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const gadget = book.createItem({ name: 'Gadget', currency: 'USD', unitPrice: 4000n, cost: 3000n });
  const supplier = book.createParty({ name: 'Widgets Wholesale' });

  const estimate = book.createDocument({
    type: 'estimate', number: 'EST-1', date: '2026-07-01', customerName: 'Acme',
    lines: [
      { itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, lineId: 'E1' },
      { itemId: gadget.id, description: 'Gadget', quantityMilli: 2_000n, lineId: 'E2' },
    ],
  });
  book.sendDocument(estimate.id);
  const order = book.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', date: '2026-07-02' });
  book.sendDocument(order.id);
  const orderLines = book.view(order.id).current.lines;
  const widgetLine = orderLines.find((line) => line.description === 'Widget')!;

  // Special order: a PO cross-links to the SO's widget line.
  const po = book.createDocument({
    type: 'purchase_order', number: 'PO-1', date: '2026-07-03', partyId: supplier.id,
    lines: [{
      itemId: widget.id, description: 'Widget', quantityMilli: 6_000n, unitPrice: 900n,
      sourceDocumentId: order.id, sourceLineId: widgetLine.lineId, lineId: 'P1',
    }],
  });

  // Partial invoice off the SO: 4 of 10 widgets.
  const invoice = book.convertDocument(order.id, {
    type: 'invoice', number: 'INV-1', date: '2026-07-04',
    lines: [{ sourceLineId: widgetLine.lineId, quantityMilli: 4_000n }],
  });
  book.sendDocument(invoice.id);

  // A second invoice, voided — it must stay in the graph, labeled.
  const dead = book.convertDocument(order.id, {
    type: 'invoice', number: 'INV-2', date: '2026-07-05',
    lines: [{ sourceLineId: widgetLine.lineId, quantityMilli: 1_000n }],
  });
  book.voidDocument(dead.id);

  return { book, estimate, order, invoice, dead, po, widgetLine };
}

describe('computeDocumentLinks (ADR 0021)', () => {
  it('resolves upstream and downstream per line, with kinds', () => {
    const { book, order, estimate, invoice, dead, po, widgetLine } = buildFamily();
    const links = book.documentLinks(order.id);

    const widget = links.lines.find((line) => line.lineId === widgetLine.lineId)!;
    // Upstream: the estimate line it converted from.
    expect(widget.upstream).toMatchObject({
      documentId: estimate.id, number: 'EST-1', type: 'estimate', lineId: 'E1', kind: 'conversion',
    });
    // Downstream: the PO cross-link, the live invoice, and the void one — all visible.
    expect(widget.downstream).toHaveLength(3);
    expect(widget.downstream).toContainEqual(
      expect.objectContaining({ documentId: po.id, kind: 'cross', quantityMilli: 6_000n }),
    );
    expect(widget.downstream).toContainEqual(
      expect.objectContaining({ documentId: invoice.id, kind: 'conversion', quantityMilli: 4_000n }),
    );
    expect(widget.downstream).toContainEqual(
      expect.objectContaining({ documentId: dead.id, status: 'void', quantityMilli: 1_000n }),
    );
    // The gadget line converted whole and has no consumers yet.
    const gadget = links.lines.find((line) => line.description === 'Gadget')!;
    expect(gadget.upstream).toMatchObject({ lineId: 'E2' });
    expect(gadget.downstream).toHaveLength(0);
  });

  it('family is the whole connected component, from any member', () => {
    const { book, estimate, order, invoice, dead, po } = buildFamily();
    const everyone = [estimate.id, order.id, invoice.id, dead.id, po.id].sort();
    // The same family is visible from the root, the middle, and a leaf.
    for (const memberId of [estimate.id, po.id, invoice.id]) {
      const links = book.documentLinks(memberId);
      expect(links.family.nodes.map((node) => node.documentId).sort()).toEqual(everyone);
    }
    const fromRoot = book.documentLinks(estimate.id);
    // Nodes are date-ordered; the void node carries its status.
    expect(fromRoot.family.nodes.map((node) => node.number)).toEqual(['EST-1', 'SO-1', 'PO-1', 'INV-1', 'INV-2']);
    expect(fromRoot.family.nodes.find((node) => node.number === 'INV-2')!.status).toBe('void');
    // Every edge kind shows up exactly where expected.
    const kinds = fromRoot.family.edges.map((edge) => edge.kind);
    expect(kinds.filter((kind) => kind === 'cross')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'conversion')).toHaveLength(4); // EST→SO ×2 lines, SO→INV-1, SO→INV-2
  });

  it('unrelated documents form their own single-node family', () => {
    const { book } = buildFamily();
    const widget = book.listDocuments('estimate')[0]!.current.lines[0]!;
    const loner = book.createDocument({
      type: 'invoice', number: 'INV-9', date: '2026-07-10', customerName: 'Bystander',
      lines: [{ itemId: widget.itemId!, description: 'Widget', quantityMilli: 1_000n }],
    });
    const links = book.documentLinks(loner.id);
    expect(links.family.nodes.map((node) => node.documentId)).toEqual([loner.id]);
    expect(links.family.edges).toHaveLength(0);
    expect(links.lines[0]!.upstream).toBeNull();
    expect(links.lines[0]!.downstream).toHaveLength(0);
  });

  it('throws UNKNOWN_DOCUMENT for a missing id', () => {
    expect(() => computeDocumentLinks([], 'nope')).toThrowError(/No such document/);
  });
});
