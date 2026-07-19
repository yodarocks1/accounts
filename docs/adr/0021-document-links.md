# ADR 0021: Document links — the graph read and the linking UI

## Status

Accepted.

## Context

Line-level links are the system's connective tissue: conversions carry
`sourceDocumentId`/`sourceLineId` (ADR 0005), returns link to the invoice
they credit (ADR 0006), purchase-order lines cross-link to sales-order
lines for special orders (ADR 0011), and fulfillment, coverage, deposit
transfer, and revision guards all derive from those links. Yet no read
exposes the graph itself — every consumer (fulfillment, coverage) answers
a narrower question. The web UI (ADR 0020) now needs to *show* links and
*create* them, which surfaces the gap directly — the third instance of
"an API shaped by its own tests has UI-shaped holes" (findings).

## Decision

1. **One graph read, computed in core.** `computeDocumentLinks(documents,
   id)` is a pure function over `DocumentView`s returning:
   - `lines[]` — for each line of the target: its **upstream** link
     (resolved to document type/number/label/status + source-line
     description) and its **downstream** consumers (every line in any
     other document that references it, with quantity and status).
   - `family` — the whole connected component: nodes (id, type, number,
     label, status, date) and edges (from/fromLineId → to/toLineId,
     quantity, kind), BFS over line-level links plus document-level
     `sourceDocumentId` edges so conversion chains stay connected even
     where a revision dropped line links.
   - Edge **kind** distinguishes `conversion` (the consumer's
     document-level source is the linked document — estimate→SO→invoice,
     PO→receipt→bill) from `cross` (line-level only — PO↔SO special
     orders, return↔invoice).
   - **Void documents stay in the graph, labeled void.** Fulfillment
     rightly ignores them; a link browser that hid them would lie about
     history. Showing status is the UI's job; hiding facts is nobody's.
   Both engines expose `documentLinks(id)` by delegating to the shared
   function over their own `listDocuments()`.
2. **`GET /documents/:id/links`** serves it; **`GET /parties`** joins the
   route table (`listParties()` on both engines) because the
   order-from-supplier flow needs to offer a supplier picker — the second
   read this UI found missing.
3. **The UI shows every link fact on the document detail page:**
   per-line upstream chip, downstream consumer list, fulfillment state
   (open/converted/closed with closure kinds and reasons), purchase
   coverage on sales orders (draft/sent/unordered), line prepayments
   when deposits are held, and a family panel listing every related
   document with its edges — all navigable, current document highlighted.
4. **The UI creates every kind of link the API can create safely:**
   - **Convert** (sent documents with conversion targets): per-line
     checkboxes and quantities bounded by the shown open amount, free
     flag, optional substitution (description/price), target type and
     date → `POST /documents/:id/convert`. Safe because conversion takes
     explicit `sourceLineId`s — the positional-matching risk that blocks
     an editing UI (findings #5) does not exist here.
   - **Order from supplier** (sent sales orders): pick a supplier party
     and per-line quantities bounded by the unordered amount → creates a
     draft purchase order whose lines carry the SO cross-links; costs
     resolve from supplier info exactly as everywhere else.
   - **Close line** (sent documents): quantity bounded by open, kind
     (`unfulfilled`/`substituted`), reason, optional approver.
   - **Send** (draft documents): so a PO or conversion drafted in the UI
     can finish its lifecycle; deposit/minimum override checkboxes appear
     with the server's error code when a gate fires. Void with the same
     confirm-and-approve shape.
   Every write refetches; the client owns no derived state. Errors always
   surface the stable `LedgerError` code.

**Cut (recorded):** free-form revision editing (unchanged, findings #5);
retroactively linking an *existing* line to a source (the API has no such
write — links are set at line creation by design, so the UI creates
linked lines rather than mutating link fields); graphical edge rendering
(the family panel is a table — function over form).

## Consequences

- The link graph is now a first-class read; future UIs (and plugins) get
  provenance without re-deriving it from raw document lists.
- `LINE_OVERDRAWN` and `LINE_LINKED` guards now have a UI that shows the
  quantities they protect *before* the user trips them — bounds are
  printed next to every input.
- Two more entries for the findings' UI-shaped-holes ledger: the links
  read and the parties list, both additive.
