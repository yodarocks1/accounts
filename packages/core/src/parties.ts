/**
 * Parties (ADR 0008 part 4): the durable customer record. Documents snapshot
 * the party's name at the time; renames are events in an append-only history,
 * so a rename can never split or rewrite a customer's paper trail.
 */
export interface Party {
  readonly id: string;
  /** Current name (latest entry in the rename history). */
  readonly name: string;
  /** Unique when present; the strongest identity for matching. */
  readonly accountNumber: string | null;
  /** Default payment terms for new documents. */
  readonly termsDays: number | null;
  /** Exempt customers get no tax codes on their documents (ADR 0010). */
  readonly taxExempt: boolean;
  readonly createdAt: string;
}

export interface NewParty {
  name: string;
  accountNumber?: string;
  termsDays?: number;
  taxExempt?: boolean;
}

export interface PartyName {
  readonly nameSeq: number;
  readonly name: string;
  readonly at: string;
}
