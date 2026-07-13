import { LedgerError } from './errors.js';
import type { DocumentView } from './documents.js';
import type { NewSupplierInfo } from './suppliers.js';

/**
 * Plugin host v1 (ADR 0018): in-process, trusted, bundled plugins. The host
 * is a registry plus a synchronous event fan-out with per-listener error
 * isolation. Generic over the book type — storage engines bind themselves.
 */

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export type DocumentEvent = 'document.created' | 'document.sent' | 'document.voided';

/** What a connector's fetch returns; the host adds partyId and source. */
export type SupplierQuote = Omit<NewSupplierInfo, 'partyId' | 'source'>;

/** One supplier's integration: how we learn their terms and send them orders. */
export interface SupplierConnector {
  /** The party this connector serves. */
  readonly partyId: string;
  /** Pull fresh terms; recorded as supplier info with source = plugin id. */
  fetchSupplierInfo?(): SupplierQuote | Promise<SupplierQuote>;
  /** Deliver a sent purchase order however this supplier takes orders. */
  submitPurchaseOrder?(order: DocumentView): { reference?: string } | Promise<{ reference?: string }>;
}

export interface ReportContribution<TBook = unknown> {
  readonly name: string;
  readonly description?: string;
  run(book: TBook, params: Readonly<Record<string, string>>): unknown;
}

/** The scoped surface a plugin receives; never the host's internals. */
export interface PluginHostApi<TBook = unknown> {
  registerSupplierConnector(connector: SupplierConnector): void;
  registerReport(report: ReportContribution<TBook>): void;
  onDocumentEvent(event: DocumentEvent, listener: (view: DocumentView) => void): void;
  log(message: string): void;
}

export interface AccountsPlugin<TBook = unknown> {
  readonly manifest: PluginManifest;
  activate(api: PluginHostApi<TBook>): void;
}

export interface PluginLogEntry {
  readonly pluginId: string;
  readonly at: string;
  readonly message: string;
}

export class PluginHost<TBook = unknown> {
  private readonly manifests: PluginManifest[] = [];
  private readonly connectors = new Map<string, { pluginId: string; connector: SupplierConnector }>();
  private readonly reports = new Map<string, { pluginId: string; report: ReportContribution<TBook> }>();
  private readonly listeners = new Map<DocumentEvent, { pluginId: string; listener: (view: DocumentView) => void }[]>();
  private readonly logs: PluginLogEntry[] = [];
  /** Error sink for isolated hook failures; the storage binding audits these. */
  onError: ((pluginId: string, error: unknown) => void) | null = null;

  /**
   * Activate a plugin; every capability is an explicit registration.
   * Activation is transactional: registrations are staged and committed
   * only if `activate` returns — a plugin that throws partway leaves
   * nothing behind.
   */
  register(plugin: AccountsPlugin<TBook>): void {
    const { id } = plugin.manifest;
    if (!id.trim()) {
      throw new LedgerError('PLUGIN_ERROR', 'Plugin id must not be empty');
    }
    if (this.manifests.some((manifest) => manifest.id === id)) {
      throw new LedgerError('PLUGIN_ERROR', `Plugin already registered: ${id}`);
    }
    const staged = {
      connectors: new Map<string, { pluginId: string; connector: SupplierConnector }>(),
      reports: new Map<string, { pluginId: string; report: ReportContribution<TBook> }>(),
      listeners: [] as { event: DocumentEvent; pluginId: string; listener: (view: DocumentView) => void }[],
    };
    const api: PluginHostApi<TBook> = {
      registerSupplierConnector: (connector) => {
        const existing = this.connectors.get(connector.partyId) ?? staged.connectors.get(connector.partyId);
        if (existing) {
          throw new LedgerError(
            'PLUGIN_ERROR',
            `Party ${connector.partyId} already has a connector from ${existing.pluginId}`,
          );
        }
        staged.connectors.set(connector.partyId, { pluginId: id, connector });
      },
      registerReport: (report) => {
        if (this.reports.has(report.name) || staged.reports.has(report.name)) {
          throw new LedgerError('PLUGIN_ERROR', `Report already registered: ${report.name}`);
        }
        staged.reports.set(report.name, { pluginId: id, report });
      },
      onDocumentEvent: (event, listener) => {
        staged.listeners.push({ event, pluginId: id, listener });
      },
      log: (message) => {
        this.logs.push({ pluginId: id, at: new Date().toISOString(), message });
      },
    };
    plugin.activate(api); // may throw: nothing below runs, nothing is kept
    for (const [partyId, entry] of staged.connectors) this.connectors.set(partyId, entry);
    for (const [name, entry] of staged.reports) this.reports.set(name, entry);
    for (const { event, pluginId, listener } of staged.listeners) {
      const bucket = this.listeners.get(event) ?? [];
      bucket.push({ pluginId, listener });
      this.listeners.set(event, bucket);
    }
    this.manifests.push({ ...plugin.manifest });
  }

  list(): readonly PluginManifest[] {
    return this.manifests;
  }

  logEntries(): readonly PluginLogEntry[] {
    return this.logs;
  }

  /** Fan out an event; a throwing hook never breaks the write (ADR 0018). */
  emit(event: DocumentEvent, view: DocumentView): void {
    for (const { pluginId, listener } of this.listeners.get(event) ?? []) {
      try {
        listener(view);
      } catch (error) {
        this.onError?.(pluginId, error);
      }
    }
  }

  connectorFor(partyId: string): { pluginId: string; connector: SupplierConnector } | undefined {
    return this.connectors.get(partyId);
  }

  reportNames(): string[] {
    return [...this.reports.keys()];
  }

  runReport(name: string, book: TBook, params: Readonly<Record<string, string>> = {}): unknown {
    const entry = this.reports.get(name);
    if (!entry) {
      throw new LedgerError('UNKNOWN_REPORT', `No plugin report named ${JSON.stringify(name)}`);
    }
    return entry.report.run(book, params);
  }
}
