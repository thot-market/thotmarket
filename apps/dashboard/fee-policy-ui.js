// Account economics describes the current tariff. Under percentage/1 its
// service_fee field is a one-THOT sample, never a fixed per-purchase fee.
export function feePolicyCopy(economics,holderRewards){
  const amount=value=>{if(!/^\d{1,78}$/.test(String(value??'')))return null;const n=BigInt(value),base=10n**18n,frac=String(n%base).padStart(18,'0').slice(0,4).replace(/0+$/,'');return `${(n/base).toLocaleString()}${frac?'.'+frac:''} THOT`;};
  const percentage=economics?.policy==='percentage/1'||(!economics?.policy&&economics?.fee_bps!=null);
  const quoted=economics?.policy==='quoted-cost/1'||(!economics?.policy&&economics?.fee_bps==null);
  let kind='unavailable',label='Refresh quote',summary='The current service fee is unavailable. Refresh your account before reviewing sale terms.';
  if(percentage&&Number.isInteger(economics.fee_bps)&&economics.fee_bps>0&&economics.fee_bps<=1000){
    kind='percentage';label=`${economics.fee_bps/100}% of the price`;
    summary=`The base service fee is ${economics.fee_bps/100}% of the listed price, rounded up to the smallest THOT unit.`;
  }else if(quoted&&amount(economics?.service_fee)!==null&&amount(economics?.direct_cost)!==null){
    kind='quoted-cost';label=amount(economics.service_fee);
    summary=`The current base service fee is ${amount(economics.service_fee)} per purchase, including ${amount(economics.direct_cost)} of direct costs. The tariff is direct cost plus 1.5 times allocated overhead, rounded up.`;
  }
  const benefits=kind!=='unavailable'&&holderRewards?.mode==='upfront-discount'
    ?'Eligible holders and stakers receive independent buyer and seller discounts at funding. Discount percentages apply to the service fee, not the price.'
    :kind!=='unavailable'&&holderRewards?.policy
      ?'Any separately funded holder cashback is claimed after settlement and does not change the quoted seller proceeds.'
      :'The funding quote shows any applicable buyer and seller discounts separately.';
  return {kind,label,summary,details:benefits+' The funding quote fixes the exact buyer payment and seller proceeds. Estimates do not guarantee a sale or payout; funded purchases keep their agreed amounts.'};
}
