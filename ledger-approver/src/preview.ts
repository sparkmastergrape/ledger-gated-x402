// Plain-language preview of an XRPL transaction, shown beside the device prompt.
// Track 01 seed: Payment today; TrustSet, OfferCreate and Escrow next. The device screen stays the source of truth,
// so every preview also lists the raw fields a person should match against the device.
type Tx = Record<string, any>;
export type Preview = { headline: string; fields: [string, string][] };

// Returns null for a missing or unreadable amount, so the caller drops the row instead of
// showing "NaN XRP". A rejected intent has no built transaction, so it carries no Fee.
const xrp = (drops: unknown): string | null => {
  const n = Number(drops);
  return typeof drops === 'string' && drops !== '' && Number.isFinite(n) ? `${n / 1_000_000} XRP` : null;
};
const fromHex = (h: string) => { try { return decodeURIComponent(h.replace(/(..)/g, '%$1')); } catch { return h; } };

export function describeTx(tx: Tx): Preview {
  const fields: [string, string][] = [];
  const add = (k: string, v: unknown) => { if (v !== undefined && v !== null) fields.push([k, String(v)]); };
  switch (tx.TransactionType) {
    case 'Payment': {
      if (typeof tx.Amount !== 'string') {
        return { headline: `Pay an issued currency from ${tx.Account} to ${tx.Destination}`, fields: [['Amount', JSON.stringify(tx.Amount)]] };
      }
      add('From', tx.Account); add('To', tx.Destination); add('Amount', xrp(tx.Amount));
      add('Destination tag', tx.DestinationTag); add('Fee', xrp(tx.Fee)); add('Expires after ledger', tx.LastLedgerSequence);
      if (tx.Memos?.[0]) add('Request id', fromHex(tx.Memos[0].Memo.MemoData ?? ''));
      return { headline: `Send ${xrp(tx.Amount) ?? `${tx.Amount} drops`} to ${tx.Destination}`, fields };
    }
    default:
      add('Type', tx.TransactionType); add('Account', tx.Account);
      return { headline: `${tx.TransactionType} (no plain-language preview yet): check every field on the device`, fields };
  }
}
