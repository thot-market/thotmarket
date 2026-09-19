import { canonicalHash, uuidv7 } from '../../protocol/src/index.ts';
import { ensure, type Transaction, type Document } from '../../storage/src/index.ts';

export type Currency = 'USD' | 'USDC' | 'THOT';
export interface Posting { account: string; owner: string; amount: bigint }
export interface DirectCost { code: string; amount_minor: string }
export function splitSale(gross: bigint, costs: DirectCost[] = [], approvedCodes: string[] = [], maximumCosts = 0n) {
  ensure(typeof gross === 'bigint' && gross >= 0n && gross < 10n ** 78n, 'INVALID_GROSS');
  const seen = new Set<string>();
  let direct = 0n;
  for (const cost of costs) {
    ensure(approvedCodes.includes(cost.code) && !seen.has(cost.code), 'UNAPPROVED_COST_CODE');
    ensure(typeof cost.amount_minor === 'string' && /^(0|[1-9][0-9]*)$/.test(cost.amount_minor), 'INVALID_DIRECT_COST');
    seen.add(cost.code); direct += BigInt(cost.amount_minor);
  }
  ensure(direct <= maximumCosts && direct <= gross, 'COST_CAP_EXCEEDED');
  const net = gross - direct;
  const contributor = net * 65n / 100n;
  const burn = net * 20n / 100n;
  return { gross_minor: gross, direct_costs_minor: direct, eligible_net_minor: net, contributor_minor: contributor, burn_minor: burn, operator_minor: net - contributor - burn, split_policy_id: 'split/65-20-15/v1' };
}
export function accountId(currency: Currency, owner: string, account: string): string {
  return canonicalHash({currency,owner,account});
}
export async function postJournal(tx: Transaction, reference: string, currency: Currency, postings: Posting[]): Promise<string> {
  ensure(['USD','USDC','THOT'].includes(currency), 'INVALID_CURRENCY');
  ensure(postings.length >= 2 && postings.every(p => typeof p.amount === 'bigint' && p.amount > -(10n ** 78n) && p.amount < 10n ** 78n), 'INVALID_JOURNAL');
  ensure(postings.reduce((sum,p) => sum+p.amount,0n) === 0n, 'UNBALANCED_JOURNAL');
  const fingerprint = canonicalHash({currency,postings});
  const prior = (await tx.sql.query('SELECT * FROM ledger_transactions WHERE reference=$1', [reference])).rows[0];
  if (prior) { ensure(prior.fingerprint === fingerprint, 'JOURNAL_REPLAY_CONFLICT', 409); return prior.id; }
  const id = uuidv7();
  await tx.sql.query('INSERT INTO ledger_transactions(id,reference,currency,fingerprint) VALUES($1,$2,$3,$4)', [id,reference,currency,fingerprint]);
  for (const p of postings) {
    const aid = accountId(currency,p.owner,p.account);
    const kind = p.account.split(':')[0];
    ensure(['ASSET','LIABILITY','REVENUE','EXPENSE'].includes(kind), 'INVALID_ACCOUNT');
    await tx.sql.query('INSERT INTO ledger_accounts(id,currency,kind,owner_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [aid,currency,kind,p.owner]);
    await tx.sql.query('INSERT INTO ledger_entries(id,transaction_id,account_id,amount) VALUES($1,$2,$3,$4)', [uuidv7(),id,aid,p.amount.toString()]);
  }
  return id;
}
export async function accountBalance(tx: Transaction, currency: Currency, owner: string, account: string): Promise<bigint> {
  const result = await tx.sql.query('SELECT COALESCE(SUM(amount),0)::text AS amount FROM ledger_entries WHERE account_id=$1', [accountId(currency,owner,account)]);
  return BigInt(result.rows[0].amount);
}
export async function reconcile(tx: Transaction): Promise<Document> {
  const journals = await tx.sql.query('SELECT t.id,t.currency,COALESCE(SUM(e.amount),0)::text AS total FROM ledger_transactions t JOIN ledger_entries e ON t.id=e.transaction_id GROUP BY t.id,t.currency ORDER BY t.id');
  const unbalanced = journals.rows.filter(r=>BigInt(r.total)!==0n).map(r=>r.id);
  const currencies = await tx.sql.query('SELECT a.currency,a.kind,SUM(e.amount)::text AS amount FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY a.currency,a.kind ORDER BY a.currency,a.kind');
  return { balanced: unbalanced.length === 0, unbalanced_journal_ids: unbalanced, totals: currencies.rows, journal_count: journals.rows.length, commitment: canonicalHash(journals.rows) };
}
