/**
 * OFX / QFX ("Web Connect") statements, both the SGML flavour banks still
 * emit (unclosed tags) and the XML flavour. Only the statement transaction
 * list and account identity are read.
 */
export interface OfxTransaction { fitid: string; date: string; amount: number; name: string; memo: string; type: string }
export interface OfxStatement { account_id: string; account_type: string; currency: string; balance: number | null; balance_date: string | null; transactions: OfxTransaction[] }

const tag = (block: string, name: string): string => {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? decode(m[1].trim()) : '';
};
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

const ofxDate = (s: string): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export function parseOfx(text: string): OfxStatement[] {
  // Headers (OFXHEADER:100 …) precede the first <OFX>; everything before it is ignored.
  const start = text.search(/<OFX>/i);
  const body = start >= 0 ? text.slice(start) : text;
  const out: OfxStatement[] = [];
  const stmtRe = /<(STMTRS|CCSTMTRS|INVSTMTRS)>([\s\S]*?)(?=<\/\1>|<STMTRS>|<CCSTMTRS>|<INVSTMTRS>|$)/gi;
  let sm: RegExpExecArray | null;
  while ((sm = stmtRe.exec(body)) !== null) {
    const kind = sm[1].toUpperCase();
    const block = sm[2];
    const acct = /<(BANKACCTFROM|CCACCTFROM|INVACCTFROM)>([\s\S]*?)(?=<\/\1>|<BANKTRANLIST>|<LEDGERBAL>|<INVTRANLIST>)/i.exec(block)?.[2] ?? '';
    const txns: OfxTransaction[] = [];
    const trnRe = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi;
    let tm: RegExpExecArray | null;
    while ((tm = trnRe.exec(block)) !== null) {
      const b = tm[1];
      const date = ofxDate(tag(b, 'DTPOSTED')) ?? ofxDate(tag(b, 'DTUSER'));
      const amount = Number(tag(b, 'TRNAMT').replace(/,/g, ''));
      const fitid = tag(b, 'FITID');
      if (!date || !Number.isFinite(amount) || !fitid) continue;
      txns.push({ fitid, date, amount, name: tag(b, 'NAME') || tag(b, 'PAYEE'), memo: tag(b, 'MEMO'), type: tag(b, 'TRNTYPE') });
    }
    const ledger = /<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i.exec(block)?.[1] ?? '';
    const bal = Number(tag(ledger, 'BALAMT').replace(/,/g, ''));
    out.push({
      account_id: tag(acct, 'ACCTID'),
      account_type: kind === 'CCSTMTRS' ? 'credit' : kind === 'INVSTMTRS' ? 'investment' : (tag(acct, 'ACCTTYPE') || 'depository').toLowerCase(),
      currency: tag(block, 'CURDEF') || 'USD',
      balance: Number.isFinite(bal) && ledger ? bal : null,
      balance_date: ofxDate(tag(ledger, 'DTASOF')),
      transactions: txns,
    });
  }
  return out;
}
