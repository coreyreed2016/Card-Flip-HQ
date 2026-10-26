/* Financial calculations operate entirely in integer cents. */
export const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
export const toCents = (value) => {
  const clean = String(value ?? '').replace(/[$,\s]/g, '');
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
export const id = (prefix = 'rec') => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export function dealMath(d) {
  const gross = +d.gross || 0, asking = +d.asking || 0;
  const platform = +d.platformFee || 0, processing = +d.processingFee || 0;
  const selling = platform + processing + (+d.shipping || 0) + (+d.otherSelling || 0);
  const purchaseOther = (+d.purchaseTax || 0) + (+d.travel || 0);
  const reserve = +d.reserve || 0, target = +d.targetProfit || 0;
  const maxOffer = gross - selling - purchaseOther - reserve - target;
  const costAtAsk = asking + purchaseOther;
  const profitAtAsk = gross - selling - costAtAsk - reserve;
  const net = gross - selling;
  const roi = costAtAsk ? profitAtAsk / costAtAsk : 0;
  return { gross, asking, selling, purchaseOther, reserve, target, maxOffer, profitAtAsk, net, roi,
    margin: gross ? profitAtAsk / gross : 0, maxPercent: gross ? maxOffer / gross : 0,
    difference: asking - maxOffer, assessment: asking <= maxOffer ? (asking < maxOffer * .9 ? 'BUY' : 'NEGOTIATE') : 'PASS' };
}
export function inventoryCost(item) { return (+item.acquisitionCost || 0) * (+item.quantity || 1); }
export function soldProfit(item) { return (+item.actualSalePrice || 0) - inventoryCost(item) - (+item.sellingFees || 0) - (+item.sellerShipping || 0) - (+item.otherExpenses || 0); }
export function summarize(data) {
  const inv = data.inventory || [], tx = data.transactions || [];
  const active = inv.filter(x => !['Sold', 'Written off'].includes(x.status));
  const sold = inv.filter(x => x.status === 'Sold');
  const revenue = sold.reduce((s, x) => s + (+x.actualSalePrice || 0), 0);
  const realized = sold.reduce((s, x) => s + soldProfit(x), 0);
  const inventory = active.reduce((s, x) => s + inventoryCost(x), 0);
  const operating = tx.filter(x => ['Marketplace fees','Payment processing','Shipping','Supplies','Travel','Other business expenses'].includes(x.type)).reduce((s,x)=>s+(+x.amount||0),0);
  const contributions = tx.filter(x => x.type === 'Owner contribution').reduce((s,x)=>s+(+x.amount||0),0);
  const withdrawals = tx.filter(x => x.type === 'Owner withdrawal').reduce((s,x)=>s+(+x.amount||0),0);
  // Cash represents settled business cash. Inventory purchases and sale settlement are driven by inventory records.
  const purchases = inv.reduce((s,x)=>s+inventoryCost(x),0);
  const salesCash = sold.reduce((s,x)=>(+x.actualSalePrice||0)-(+x.sellingFees||0)-(+x.sellerShipping||0)-(+x.otherExpenses||0),0);
  const nonOps = tx.filter(x => ['Supplies','Travel','Other business expenses','Refunds'].includes(x.type)).reduce((s,x)=>s+(+x.amount||0),0);
  const cash = (+data.settings.startingCapital || 0) + contributions - withdrawals - purchases + salesCash - nonOps;
  const now = new Date(), month = now.toISOString().slice(0,7);
  const monthlySold = sold.filter(x => String(x.saleDate || '').slice(0,7) === month);
  return { cash, inventory, revenue, realized, operating, records: inv.length, active: inv.filter(x=>x.status==='Listed').length,
    openDeals:(data.watchlist||[]).filter(x=>!['Purchased','Rejected','Expired'].includes(x.status)).length, contributions, withdrawals,
    monthlySales:monthlySold.reduce((s,x)=>s+(+x.actualSalePrice||0),0), monthlyProfit:monthlySold.reduce((s,x)=>s+soldProfit(x),0),
    avgProfit:sold.length ? realized/sold.length : 0, sellThrough:inv.length ? sold.length/inv.length : null,
    holdingDays:sold.length ? sold.reduce((s,x)=>s+(new Date(x.saleDate)-new Date(x.purchaseDate))/86400000,0)/sold.length : null,
    recent:inv.slice().sort((a,b)=>String(b.saleDate||b.purchaseDate||'').localeCompare(String(a.saleDate||a.purchaseDate||''))).slice(0,6) };
}
