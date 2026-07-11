import type {
  AccountsPlugin,
  DocumentView,
  SupplierQuote,
} from '@accounts/core';

/**
 * Demo supplier connector (ADR 0018): the dogfood plugin. Everything here
 * goes through @accounts/core's public plugin API — zero core edits — and
 * exercises all three v1 extension points: a supplier connector, a document
 * lifecycle hook, and a report contribution.
 */

export interface DemoSupplierOptions {
  /** The party this connector serves. */
  partyId: string;
  /** Quoted unit costs per item id (minor units). */
  itemCosts: Record<string, bigint>;
  minimumOrderMinor?: bigint;
  prepaymentPercentMilli?: bigint;
  /** Lead time quoted on every item. */
  leadDays?: number;
}

/** The narrow slice of the book the pipeline report needs (structural). */
interface PurchaseReader {
  listDocuments(type?: 'purchase_order'): DocumentView[];
}

export function demoSupplierPlugin(options: DemoSupplierOptions): AccountsPlugin<PurchaseReader> {
  let submitCounter = 0;
  return {
    manifest: { id: 'demo-supplier', name: 'Demo Supplier Connector', version: '0.0.1' },
    activate(api) {
      api.registerSupplierConnector({
        partyId: options.partyId,
        fetchSupplierInfo(): SupplierQuote {
          // A real connector would call the supplier's API here.
          return {
            asOf: new Date().toISOString().slice(0, 10),
            currency: 'USD',
            ...(options.minimumOrderMinor !== undefined ? { minimumOrderMinor: options.minimumOrderMinor } : {}),
            ...(options.prepaymentPercentMilli !== undefined
              ? { prepaymentPercentMilli: options.prepaymentPercentMilli }
              : {}),
            items: Object.entries(options.itemCosts).map(([itemId, unitCost]) => ({
              itemId,
              unitCost,
              inStock: true,
              ...(options.leadDays !== undefined ? { leadDays: options.leadDays } : {}),
            })),
            notes: 'quoted by demo-supplier',
          };
        },
        submitPurchaseOrder(order: DocumentView) {
          submitCounter += 1;
          const reference = `DEMO-${String(submitCounter).padStart(4, '0')}`;
          api.log(`submitted ${order.number} as ${reference}`);
          return { reference };
        },
      });

      api.onDocumentEvent('document.sent', (view) => {
        api.log(`observed ${view.type} ${view.number} sent`);
      });

      api.registerReport({
        name: 'demo.purchase-pipeline',
        description: 'Open purchase orders: count and committed value',
        run(book) {
          const open = book.listDocuments('purchase_order').filter((view) => view.status === 'sent');
          return {
            openOrders: open.length,
            committedMinor: open.reduce((sum, view) => sum + view.total, 0n),
            numbers: open.map((view) => view.number),
          };
        },
      });
    },
  };
}
