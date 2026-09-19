import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseEther, id} from 'ethers';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {demoUser, demoBuyer, demoOperator} from '../packages/market/src/fixtures.ts';

async function samplingOverHttp(app) {
  const server = createHttpServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const session = await fetch(url + '/v1/dev/session', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({role: 'operator_security'}),
    });
    assert.equal(session.status, 200);
    const {token} = await session.json();
    const response = await fetch(url + '/v1/thot/sampling', {headers: {Authorization: 'Bearer ' + token}});
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const wire = await response.text();
    assert.ok(wire.length > 0, 'HTTP response must not silently end after committing successful headers');
    return {status: response.status, body: JSON.parse(wire)};
  } finally {await new Promise(resolve => server.close(resolve));}
}

test('HTTP serialization failures return structured errors before committing success headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'thot-response-'));
  let app;
  try {
    app = await createApplication({dataDir: dir, memory: true});
    app.thot.samplingWorkspace = async () => ({invalid: undefined});
    const response = await samplingOverHttp(app);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'INTERNAL_ERROR');
    assert.equal(typeof response.body.request_id, 'string');
  } finally {if (app) await app.close(); await rm(dir, {recursive: true, force: true});}
});

test('automatic sales and reserve sampling: signed enrollment → private funded release → configured-window proceeds', async t => {
  const f = await deployThotFixture(), dir = await mkdtemp(join(tmpdir(), 'thot-automatic-'));
  const config = {...f.config, confirmations: 1, codeHashes: f.manifest.codeHashes, localDeliverySigner: f.config.operator};
  let app;
  const contributors = [
    {actor: demoUser, signer: f.seller},
    {actor: {id: 'sample-contributor-2', role: 'user'}, signer: f.other},
    {actor: {id: 'sample-contributor-3', role: 'user'}, signer: f.referrer},
    {actor: {id: 'sample-contributor-4', role: 'user'}, signer: f.attacker},
  ];
  const link = async (actor, signer) => {
    const challenge = await app.thot.challenge(actor, randomUUID(), {address: await signer.getAddress()}, 'http://127.0.0.1');
    await app.thot.link(actor, randomUUID(), {id: challenge.id, signature: await signer.signMessage(challenge.message)});
  };
  const activate = async (listed, contributor) => {
    const {EIP712Domain: _domainType, ...types} = listed.typed_data.types;
    const signature = await contributor.signer.signTypedData(listed.typed_data.domain, types, listed.typed_data.message);
    const activated = await app.thot.activateListing(contributor.actor, randomUUID(), {id: listed.id, signature});
    assert.equal(activated.id, listed.id);return activated;
  };
  let selectionIndex=0;
  const persistQueueSelection=async listed=>app.db.transaction(async tx=>{
    const row=await tx.get('thot_records',listed.id);
    const selectionId='test-selection:'+listed.id;
    await tx.insert('thot_records',selectionId,row.owner_id,{kind:'treasury_sample_selection',policy:'thot.treasury-sampling/1',contributor_id:row.owner_id,group_index:selectionIndex++,inventory_commitment:'test-inventory:'+listed.id,listing_id:row.id,trace_id:row.trace_id,release_hash:row.evidence_hash,content_hash:row.release_content_hash,selected_at:app.service.now()});
    return selectionId;
  });
  const enroll = async (contributor, name, {optIn = true, activateNow = true, persistSelection = optIn, price = '1000', reviewConsent = true} = {}) => {
    const bundle = await app.service.privacy.createDemoBundle({turns: [
      {role: 'user', content: `Help debug the TypeScript cache in synthetic test scenario ${name}; the key must include the tenant ID.`},
      {role: 'assistant', content: 'Make the cache key tenant-scoped and add a cross-tenant unit test.'},
      {role: 'tool', content: 'Synthetic tests: same-tenant cache hit and cross-tenant isolation both pass.'},
    ]}, contributor.actor.id);
    const imported = await app.service.importTrace(contributor.actor, randomUUID(), {bundle, category: 'general', rights_confirmed: true, model_output_licensed: true});
    const metadata = await app.thot.listingMetadata(contributor.actor, imported.trace_id);
    const listed = await app.thot.listTrace(contributor.actor, randomUUID(), {
      trace_id: imported.trace_id, content_hash: metadata.content_hash, title: name,
      price_thot: price, license: 'Synthetic trace; non-exclusive inspection for 30 days, no onward transfer or model training.',
      rights_confirmed: true, metadata_public: true, automatic_sales: true, ...(reviewConsent?{dispute_review_consent:'thot.dispute-review/1'}:{}), treasury_opt_in: optIn,
      ...(optIn?{treasury_sampling_consent:'thot.treasury-sampling/1'}:{}),
    });
    assert.ok(listed.typed_data);
    if(activateNow){await activate(listed,contributor);if(persistSelection)await persistQueueSelection(listed);}
    return {...listed, trace_id: imported.trace_id, contributor};
  };
  const relist = async (original, title, price = '1100') => {
    const metadata = await app.thot.listingMetadata(original.contributor.actor, original.trace_id);
    const listed = await app.thot.listTrace(original.contributor.actor, randomUUID(), {
      trace_id: original.trace_id, content_hash: metadata.content_hash, title, price_thot: price,
      license: 'Revised synthetic non-exclusive inspection licence for 30 days. Changing this description does not make the content new.',
      rights_confirmed: true, metadata_public: true, automatic_sales: true, treasury_opt_in: true,treasury_sampling_consent:'thot.treasury-sampling/1',
    });
    await activate(listed, original.contributor);await persistQueueSelection(listed);return {...listed, trace_id: original.trace_id, contributor: original.contributor};
  };
  const send = async (signer, transactions) => {
    for (const transaction of transactions) await (await signer.sendTransaction(transaction)).wait();
  };
  try {
    // Principal is locked before enrollment and remains in the same lot after sales.
    await (await f.locks.connect(f.seller).deposit(parseEther('5000000'), (await f.now()) + 100 * 86400)).wait();
    await f.advance(7 * 86400 + 1);
    app = await createApplication({dataDir: dir, thot: config});
    for (const contributor of contributors) await link(contributor.actor, contributor.signer);
    await link(demoBuyer, f.buyer);
    await link(demoOperator, f.admin);
    const lotBefore = await f.locks.lot(await f.seller.getAddress(), 0);
    const sellerNonceBefore = await f.provider.getTransactionCount(await f.seller.getAddress());
    const balancesBefore = new Map(await Promise.all(contributors.map(async ({signer}) => {
      const address = await signer.getAddress(); return [address, await f.token.balanceOf(address)];
    })));
    const qualifier={actor:{id:'subjective-dispute-qualifier',role:'user'},signer:f.signers[7]};
    await link(qualifier.actor,qualifier.signer);
    const qualifyingListing=await enroll(qualifier,'Prior reviewed independent purchase',{optIn:false,price:'10000000'});
    const qualifyingOffer=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:qualifyingListing.id});
    await send(f.buyer,qualifyingOffer.transactions);await app.thot.processSales();await f.advance(Number(await f.market.DISPUTE_WINDOW()));await app.thot.processSales();
    assert.equal(await f.market.finalizedIndependentSpend(await f.buyer.getAddress()),parseEther('10000000'));
    let ordinary;
    await t.test('seller authorizes once at enrollment and buyer funding automatically accepts exact terms', async () => {
      const listed = await enroll(contributors[0], 'Ordinary automatic purchase', {optIn: false});
      ordinary = await app.thot.prepareOffer(demoBuyer, randomUUID(), {listing_id: listed.id});
      await assert.rejects(app.thot.delivery(demoBuyer, ordinary.id), /OFFER_NOT_CONFIRMED/);
      await send(f.buyer, ordinary.transactions);
      const receipt = await f.market.offers(ordinary.id);
      assert.equal(Number(receipt.status), 2);
      assert.equal(receipt.independent,true,'the hosted preparation path reviews the exact purchase before returning buyer transactions');
      assert.equal(receipt.sellerAmount, parseEther('999.96'));
      assert.equal(await f.provider.getTransactionCount(await f.seller.getAddress()), sellerNonceBefore);
      const row = await app.db.transaction(tx => tx.get('thot_records', listed.id));
      assert.equal(await f.market.authorizationUses(row.wallet, row.authorization.nonce), 1n);
      const repeated = await f.input('repeat-enrollment', {gross: parseEther('1000')});
      repeated.licenseHash = row.license_hash; repeated.evidenceHash = row.evidence_hash;
      await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer(repeated, row.authorization, row.signature, repeated.gross));
      await app.thot.processSales();
      assert.equal(Number((await f.market.offers(ordinary.id)).status), 3);
      const delivery = await app.thot.delivery(demoBuyer, ordinary.id);
      assert.ok(delivery.release.content.turns.length);
      await assert.rejects(app.thot.delivery(demoOperator, ordinary.id), /FORBIDDEN|NOT_FOUND/);
    });

    await t.test('complaint, seller response and governance vote stay encrypted while their hashes drive the onchain case',async()=>{
      const reason='Synthetic confidential complaint: the licensed tool outcome was incomplete.';
      const prepared=await app.thot.transaction(demoBuyer,{action:'dispute',id:ordinary.id,reason});
      assert.ok(prepared.notice.includes(`Sign within ${Number(await f.market.DISPUTE_WINDOW())/3600} hour(s) of recorded delivery.`));
      assert.equal(Number((await f.market.offers(ordinary.id)).status),3,'preparing a dispute is not submitting it');
      await assert.rejects(app.thot.disputeEvidence(demoOperator,{id:ordinary.id}),/DISPUTE_NOT_OPEN/);
      assert(!(await app.thot.disputes(demoOperator)).items.some(item=>item.offer_id===ordinary.id),'an unsubmitted complaint grants no governance inspection');
      const rows=await app.db.transaction(tx=>tx.list('thot_records'));
      assert(!JSON.stringify(rows).includes(reason));assert.equal(rows.filter(r=>r.kind==='dispute_explanation').length,1);
      await assert.rejects(app.thot.disputes(demoBuyer),/GOVERNANCE_REVIEWER_REQUIRED/);
      await assert.rejects(app.thot.voteDispute(demoBuyer,{id:ordinary.id,decision:'buyer_wins',reason}),/GOVERNANCE_REVIEWER_REQUIRED/);
      const receipt=await(await f.buyer.sendTransaction(prepared.transactions[0])).wait();
      const onchainInbox=(await app.thot.disputes(demoOperator)).items.find(row=>row.offer_id===ordinary.id);
      assert.equal(onchainInbox.explanations[0].status,'confirmed','onchain complaint must remain reviewable if the buyer closes their tab before app confirmation');
      assert.equal(onchainInbox.explanations[0].transaction_hash,null);
      await assert.rejects(app.thot.confirmDispute(demoUser,{id:ordinary.id,transaction_hash:receipt.hash}),/DISPUTE_PARTY_MISMATCH/);
      const confirmed=await app.thot.confirmDispute(demoBuyer,{id:ordinary.id,transaction_hash:receipt.hash});
      assert.equal(confirmed.reason_hash,prepared.reason_hash);
      const inbox=await app.thot.disputes(demoOperator),item=inbox.items.find(row=>row.offer_id===ordinary.id);
      assert.equal(item.receipt.status,4);assert.equal(item.explanations[0].reason,reason);assert.equal(item.explanations[0].status,'confirmed');
      assert.equal(item.can_inspect,true);
      await assert.rejects(app.thot.disputeEvidence(demoBuyer,{id:ordinary.id}),/GOVERNANCE_REVIEWER_REQUIRED/);
      await assert.rejects(app.thot.disputeEvidence({...demoBuyer,role:'operator_security'},{id:ordinary.id}),/GOVERNANCE_REVIEWER_REQUIRED/);
      await assert.rejects(app.thot.disputes({...demoBuyer,role:'operator_security'}),/GOVERNANCE_REVIEWER_REQUIRED/);
      const reviewed=await app.thot.disputeEvidence({...demoOperator,role:'user'},{id:ordinary.id});
      assert((await app.thot.disputes({...demoOperator,role:'user'})).items.some(item=>item.offer_id===ordinary.id),'onchain reviewer needs no operator app role');
      const purchased=await app.thot.delivery(demoBuyer,ordinary.id);
      assert.deepEqual(reviewed.release,purchased.release,'reviewers receive the purchased release, not private source objects');
      assert.equal(reviewed.release_hash,item.receipt.evidence_hash);assert.equal(reviewed.delivery_hash,item.receipt.delivery_hash);
      assert.equal(reviewed.scope,'disputed_purchased_release');assert.equal(reviewed.release.brokerage_evidence,undefined);
      const reads=(await app.db.query("SELECT payload FROM audit_events WHERE event_type='ThotDisputeEvidenceInspected'")).rows;
      assert(reads.some(row=>row.payload.offer_id===ordinary.id&&row.payload.release_hash===reviewed.release_hash));
      assert(!JSON.stringify(reads).includes(reason),'private explanations are absent from audit payloads');
      const intent=await app.db.transaction(tx=>tx.get('thot_records','intent:'+ordinary.id));
      const exactListing=await app.db.transaction(tx=>tx.get('thot_records',intent.listing_id));
      await app.db.transaction(tx=>tx.update('thot_records',exactListing.id,{...exactListing,evidence_hash:id('another committed release')}));
      try{await assert.rejects(app.thot.disputeEvidence(demoOperator,{id:ordinary.id}),/ONCHAIN_OFFER_MISMATCH/);}
      finally{await app.db.transaction(tx=>tx.update('thot_records',exactListing.id,exactListing));}
      const snapshot=await f.provider.send('evm_snapshot',[]);await f.warp(item.receipt.dispute.vote_ends_at);
      await assert.rejects(app.thot.disputeEvidence(demoOperator,{id:ordinary.id}),/DISPUTE_REVIEW_WINDOW_CLOSED/);
      await f.provider.send('evm_revert',[snapshot]);

      await app.thot.processSales();assert.equal(Number((await f.market.offers(ordinary.id)).status),4);
      const responseText='Synthetic seller response identifies the complete licensed result and its test evidence.';
      const response=await app.thot.respondToDispute(demoUser,{id:ordinary.id,response:responseText});await send(f.seller,response.transactions);
      assert(!JSON.stringify(await app.db.transaction(tx=>tx.list('thot_records'))).includes(responseText));
      const dispute=await f.market.disputeCases(ordinary.id);await f.warp(Number(dispute.voteStartsAt));
      const decisionText='Synthetic governance review finds the buyer complaint sufficient under the signed licence.';
      const decision=await app.thot.voteDispute(demoOperator,{id:ordinary.id,decision:'buyer_wins',reason:decisionText});
      assert.equal(decision.wallet.toLowerCase(),f.config.operator.toLowerCase());await send(f.admin,decision.transactions);
      assert(!JSON.stringify(await app.db.transaction(tx=>tx.list('thot_records'))).includes(decisionText));
      assert.equal(Number((await f.market.offers(ordinary.id)).status),6);
      const decided=(await app.thot.disputes(demoOperator)).items.find(row=>row.offer_id===ordinary.id);
      assert.equal(decided.responses[0].response,responseText);assert.equal(decided.responses[0].status,'confirmed');
      assert.equal(decided.decisions[0].reason,decisionText);assert.equal(decided.decisions[0].status,'confirmed');
      assert.equal(decided.can_inspect,false);await assert.rejects(app.thot.disputeEvidence(demoOperator,{id:ordinary.id}),/DISPUTE_NOT_OPEN/);
    });

    await t.test('a governance wallet that bought the trace cannot inspect or vote as its own reviewer',async()=>{
      const listed=await enroll(contributors[0],'Conflicted governance purchase',{optIn:false,price:'10000000'});
      const offer=await app.thot.prepareOffer(demoOperator,randomUUID(),{listing_id:listed.id});
      await send(f.admin,offer.transactions);await app.thot.processSales();
      const complaint=await app.thot.transaction(demoOperator,{action:'dispute',id:offer.id,reason:'Synthetic governance buyer complaint about incomplete licensed results.'});
      await send(f.admin,complaint.transactions);
      await assert.rejects(app.thot.disputeEvidence(demoOperator,{id:offer.id}),/GOVERNANCE_REVIEWER_CONFLICT/);
      const item=(await app.thot.disputes(demoOperator)).items.find(row=>row.offer_id===offer.id);
      assert.equal(item.reviewer_conflict,true);assert.equal(item.can_inspect,false);assert.equal(item.can_vote,false);
      assert.deepEqual(item.explanations,[]);assert.deepEqual(item.responses,[]);
      await assert.rejects(app.thot.voteDispute(demoOperator,{id:offer.id,decision:'buyer_wins',reason:'A conflicted reviewer must not vote their own purchase.'}),/GOVERNANCE_REVIEWER_CONFLICT/);
    });

    await t.test('storage exhaustion preserves the onchain dispute path without leaking an explanation or hiding unexpected errors',async()=>{
      const quotaSeller={actor:{id:'quota-dispute-seller',role:'user'},signer:f.signers[8]};await link(quotaSeller.actor,quotaSeller.signer);
      const quotaListing=await enroll(quotaSeller,'Quota-path independent purchase',{optIn:false});
      const quotaOffer=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:quotaListing.id});
      await send(f.buyer,quotaOffer.transactions);await app.thot.processSales();assert.equal(Number((await f.market.offers(quotaOffer.id)).status),3);
      const reason='Synthetic quota complaint: delivery differs from the licensed expected tool output.';
      const seal=app.service.privacy.seal.bind(app.service.privacy);
      app.service.privacy.seal=async(owner,value)=>{if(value?.reason===reason)throw Error('VAULT_ACCOUNTING_UNAVAILABLE');return seal(owner,value);};
      await assert.rejects(app.thot.transaction(demoBuyer,{action:'dispute',id:quotaOffer.id,reason}),/VAULT_ACCOUNTING_UNAVAILABLE/);
      app.service.privacy.seal=async(owner,value)=>{if(value?.reason===reason)throw Error('VAULT_OWNER_QUOTA');return seal(owner,value);};
      let prepared;
      try{prepared=await app.thot.transaction(demoBuyer,{action:'dispute',id:quotaOffer.id,reason});}
      finally{app.service.privacy.seal=seal;}
      assert.equal(prepared.explanation_stored,false);assert.match(prepared.notice,/Keep a copy/);
      const rows=await app.db.transaction(tx=>tx.list('thot_records'));
      assert(!JSON.stringify(rows).includes(reason));
      const row=rows.find(r=>r.kind==='dispute_explanation'&&r.reason_hash===prepared.reason_hash);
      assert.equal(row.object_ref,null);
      const receipt=await(await f.buyer.sendTransaction(prepared.transactions[0])).wait();
      await app.thot.confirmDispute(demoBuyer,{id:quotaOffer.id,transaction_hash:receipt.hash});
      const inbox=await app.thot.disputes(demoOperator),item=inbox.items.find(r=>r.offer_id===quotaOffer.id);
      const explanation=item.explanations.find(r=>r.reason_hash===prepared.reason_hash);
      assert.equal(item.receipt.status,4);assert.equal(explanation.status,'confirmed');assert.equal(explanation.explanation_stored,false);
      assert.match(explanation.reason,/storage was at capacity/);
      const dispute=await f.market.disputeCases(quotaOffer.id);await f.warp(Number(dispute.voteStartsAt));
      const decision=await app.thot.voteDispute(demoOperator,{id:quotaOffer.id,decision:'buyer_wins',reason:'Synthetic quota complaint reviewed against the complete delivered evidence.'});
      await send(f.admin,decision.transactions);assert.equal(Number((await f.market.offers(quotaOffer.id)).status),6);
    });

    await t.test('older signed releases retain their original privacy permissions during a dispute',async()=>{
      const listed=await enroll(contributors[0],'Legacy inspection terms',{optIn:false,reviewConsent:false});
      const offer=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:listed.id});
      await send(f.buyer,offer.transactions);await app.thot.processSales();
      const complaint=await app.thot.transaction(demoBuyer,{action:'dispute',id:offer.id,reason:'Synthetic legacy complaint: review only the evidence the parties submitted.'});
      await send(f.buyer,complaint.transactions);
      await assert.rejects(app.thot.disputeEvidence(demoOperator,{id:offer.id}),/DISPUTE_INSPECTION_NOT_AUTHORIZED/);
      const item=(await app.thot.disputes(demoOperator)).items.find(row=>row.offer_id===offer.id);
      assert.equal(item.inspection_authorized,false);assert.equal(item.can_inspect,false);assert.match(item.notice,/older sale/);
      assert.equal((await app.thot.delivery(demoBuyer,offer.id)).release.dispute_review,undefined,'the buyer keeps the originally licensed release unchanged');
    });

    const eligible = [];
    for (const [i, contributor] of contributors.slice(0, 3).entries()) eligible.push(await enroll(contributor, 'Sample candidate ' + (i + 1)));
    const excluded = await enroll(contributors[3], 'No treasury consent', {optIn: false});
    const optedButUnselected = await enroll(contributors[3], 'Opted in but group is incomplete', {persistSelection:false});
    const unlisted = await enroll(contributors[3], 'Withdrawn before sample draw');
    const unlisting = await app.thot.unlist(contributors[3].actor, randomUUID(), unlisted.id);
    await send(contributors[3].signer, unlisting.transactions);
    let sampleIds = [], queued;
    await t.test('operator samples two of three opted-in contributors without exposing raw traces', async () => {
      const input = {max_samples: 2, max_gross_thot: '2000', price_ceiling_thot: '1000', workflow: 'coding'};
      await assert.rejects(app.thot.queueSamples(demoBuyer, randomUUID(), input), /FORBIDDEN/);
      await app.db.transaction(async tx=>{
        for(let n=0;n<201;n++)await tx.insert('thot_records','stale-selection:'+n,demoOperator.id,{kind:'treasury_sample_selection',policy:'thot.treasury-sampling/1',contributor_id:'!',group_index:n,inventory_commitment:'stale',listing_id:'missing-listing:'+n,release_hash:'stale',content_hash:'stale'});
      });
      const batchKey = randomUUID();
      queued = await app.thot.queueSamples(demoOperator, batchKey, input);
      const retry = await app.thot.queueSamples(demoOperator, batchKey, input);
      assert.equal(retry.id, queued.id); assert.deepEqual(retry.jobs, queued.jobs);
      const records = await app.db.transaction(tx => tx.list('thot_records'));
      const sampleIntents = records.filter(row => row.kind === 'intent' && row.wallet === f.config.reserve);
      assert.equal(sampleIntents.length, 2);
      const selected = new Set(sampleIntents.map(row => row.listing_id));
      assert.equal(selected.size, 2);
      for (const id of selected) assert.ok(eligible.some(row => row.id === id));
      assert.ok(!selected.has(excluded.id)); assert.ok(!selected.has(unlisted.id));assert.ok(!selected.has(optedButUnselected.id),'queueing cannot turn an unselected opt-in into a second draw');
      for(const intent of sampleIntents){const selection=records.find(row=>row.id===intent.selection_id);assert.equal(selection?.listing_id,intent.listing_id);assert.equal(selection?.release_hash,intent.evidence_hash);}
      sampleIds = sampleIntents.map(row => row.offer_id);
      assert.equal(await f.reserve.grossCommitted(), 0n);
      const workspace = await app.thot.samplingWorkspace(demoOperator);
      assert.ok(workspace.reserve); assert.equal(workspace.jobs.length, 2);
      assert.doesNotMatch(JSON.stringify(workspace), /tenant-scoped|alex@example|turns|release_ref|scrub_ref|raw_ref/);
      const http = await samplingOverHttp(app);
      assert.equal(http.status, 200); assert.equal(http.body.jobs.length, 2);
      for (const job of http.body.jobs) {
        assert.equal(job.status, 'queued'); assert.equal(job.error, null);
        assert.equal(job.payout_transaction, null); assert.equal(job.receipt.status, 0);
      }
      await assert.rejects(app.thot.samplingWorkspace(demoUser), /FORBIDDEN/);
      await assert.rejects(app.thot.delivery(demoOperator, sampleIds[0]), /OFFER_NOT_CONFIRMED/);
    });

    await t.test('durable queue survives restart and repeat processing charges the reserve only once', async () => {
      await app.close();
      app = await createApplication({dataDir: dir, thot: config});
      await app.thot.processSales();
      assert.equal(await f.reserve.grossCommitted(), parseEther('2000'));
      for (const id of sampleIds) {
        const receipt = await f.market.offers(id);
        assert.equal(receipt.buyer.toLowerCase(), f.config.reserve.toLowerCase());
        assert.equal(receipt.treasury, true); assert.equal(receipt.independent, false);
        assert.equal(Number(receipt.status), 3);
      }
      await app.thot.processSales();
      assert.equal(await f.reserve.grossCommitted(), parseEther('2000'));
      assert.equal(await f.reserve.independentDemand(), 0n);
      assert.equal(await f.provider.getTransactionCount(await f.seller.getAddress()), sellerNonceBefore+1,'only the explicit dispute response adds a seller transaction');
      const http = await samplingOverHttp(app);
      assert.equal(http.status, 200);
      for (const job of http.body.jobs) {
        assert.equal(job.status, 'awaiting_settlement'); assert.equal(job.error, null);
        assert.equal(job.receipt.status, 3);
      }
    });

    await t.test('only the purchasing operator can retrieve treasury-licensed samples', async () => {
      const delivered = await app.thot.delivery(demoOperator, sampleIds[0]);
      assert.ok(delivered.release.content.turns.length);
      assert.equal(delivered.receipt.buyer.toLowerCase(), f.config.reserve.toLowerCase());
      await assert.rejects(app.thot.delivery({...demoOperator, id: 'another-security-operator'}, sampleIds[0]), /FORBIDDEN|NOT_FOUND/);
      await assert.rejects(app.thot.delivery(demoBuyer, sampleIds[0]), /FORBIDDEN|NOT_FOUND/);
      await assert.rejects(app.thot.delivery(demoUser, sampleIds[0]), /FORBIDDEN|NOT_FOUND/);
      const before = await app.thot.samplingWorkspace(demoOperator);
      assert.doesNotMatch(JSON.stringify(before), /tenant-scoped|alex@example|release_ref|scrub_ref|raw_ref/);
    });

    await t.test('no payout before the dispute window; undisputed proceeds arrive after the configured window without unlocking principal', async () => {
      for (const id of sampleIds) await assert.rejects(f.market.finalize(id));
      for (const [address, balance] of balancesBefore) assert.equal(await f.token.balanceOf(address), balance);
      const allReceipts = await Promise.all(sampleIds.map(id => f.market.offers(id)));
      const earliestDelivery = Math.min(...allReceipts.map(receipt => Number(receipt.deliveredAt)));
      const latestDelivery = Math.max(...allReceipts.map(receipt => Number(receipt.deliveredAt)));
      await f.warp(earliestDelivery + 3599);
      await app.thot.processSales();
      for (const [address, balance] of balancesBefore) assert.equal(await f.token.balanceOf(address), balance);
      for (const id of sampleIds) assert.equal(Number((await f.market.offers(id)).status), 3);
      await f.warp(latestDelivery + Number(await f.market.DISPUTE_WINDOW()));
      await app.thot.processSales();
      const expected = new Map();
      for (const receipt of allReceipts) expected.set(receipt.seller, (expected.get(receipt.seller) ?? 0n) + receipt.sellerAmount);
      for (const [address, balance] of balancesBefore) {
        assert.equal(await f.token.balanceOf(address) - balance, expected.get(address) ?? 0n);
        assert.equal(await f.market.claimable(address), 0n);
      }
      for (const id of sampleIds) assert.equal(Number((await f.market.offers(id)).status), 5);
      assert.deepEqual(Array.from(await f.locks.lot(await f.seller.getAddress(), 0)), Array.from(lotBefore));
      assert.equal(await f.locks.qualifiedBalance(await f.seller.getAddress()), parseEther('5000000'));
      await assert.rejects(f.locks.connect(f.seller).withdraw(0));
      await app.thot.processSales();
      assert.equal(await f.reserve.grossCommitted(), parseEther('2000'));
      for (const [address, balance] of balancesBefore) assert.equal(await f.token.balanceOf(address) - balance, expected.get(address) ?? 0n);
    });
    await t.test('revoking a queued but unfunded listing stops its purchase without disturbing completed sales', async () => {
      const batch = await app.thot.queueSamples(demoOperator, randomUUID(), {max_samples: 1, max_gross_thot: '1000', price_ceiling_thot: '1000', workflow: 'coding'});
      assert.equal(batch.jobs.length, 1);
      const selected = eligible.find(row => row.id === batch.jobs[0].listing_id);
      assert.ok(selected);
      const revoked = await app.thot.unlist(selected.contributor.actor, randomUUID(), selected.id);
      await send(selected.contributor.signer, revoked.transactions);
      await app.thot.processSales();
      const jobs = (await app.thot.samplingWorkspace(demoOperator)).jobs;
      const blocked = jobs.find(row => row.id === batch.jobs[0].id);
      assert.equal(blocked.status, 'complete'); assert.equal(blocked.error, 'AUTHORIZATION_UNAVAILABLE');
      const closed=await app.db.transaction(tx=>tx.get('thot_records','intent:'+batch.jobs[0].id));
      assert.equal((await app.db.transaction(tx=>tx.get('thot_records','sampling-content:'+closed.subsidy_content_fingerprint))).status,'released');
      assert.equal(Number((await f.market.offers(batch.jobs[0].id)).status), 0);
      assert.equal(await f.reserve.grossCommitted(), parseEther('2000'));
      for (const id of sampleIds) assert.equal(Number((await f.market.offers(id)).status), 5);
    });
    await t.test('wallet signing retains prepared material, but expired preparation cannot activate a deleted copy', async () => {
      const prepared = await enroll(contributors[3], 'Wallet still signing', {optIn:false,activateNow:false});
      await app.thot.sweepRetention();
      const row = await app.db.transaction(tx=>tx.get('thot_records',prepared.id));
      assert.equal(row.release_deleted_at,undefined);
      assert.ok((await app.service.privacy.open(row.owner_id,row.release_ref)).content.turns.length);
      await activate(prepared,contributors[3]);
      const expired = await enroll(contributors[3], 'Expired wallet preparation', {optIn:false,activateNow:false});
      await app.db.transaction(async tx=>{const l=await tx.get('thot_records',expired.id);l.created_at=new Date(Date.now()-16*60*1000).toISOString();await tx.update('thot_records',l.id,l);});
      await app.thot.sweepRetention();
      assert.ok((await app.db.transaction(tx=>tx.get('thot_records',expired.id))).release_deleted_at);
      await assert.rejects(activate(expired,contributors[3]),/LISTING_NOT_PREPARED/);
    });
    await t.test('identical paid content cannot collect another subsidy by changing its listing, licence or price', async () => {
      const paid = eligible.find(row=>row.id===queued.jobs[0].listing_id);
      const duplicate=await relist(paid,'Same paid content under another title');
      const [a,b]=await app.db.transaction(async tx=>[await tx.get('thot_records',paid.id),await tx.get('thot_records',duplicate.id)]);
      assert.notEqual(a.evidence_hash,b.evidence_hash);assert.equal(a.subsidy_content_fingerprint,b.subsidy_content_fingerprint);
      await assert.rejects(app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:2,max_gross_thot:'2200',price_ceiling_thot:'1100',workflow:'coding'}),/NO_ELIGIBLE_SAMPLES/);
      assert.equal(await f.reserve.grossCommitted(),parseEther('2000'));
    });
    await t.test('the same paid content from a second wallet keeps separate ownership but cannot collect a second subsidy', async () => {
      const paid=eligible.find(row=>row.id===queued.jobs[0].listing_id);
      const otherOwner=await enroll(contributors[3],paid.title);
      assert.notEqual(otherOwner.trace_id,paid.trace_id);
      const [original,copy]=await app.db.transaction(async tx=>[await tx.get('thot_records',paid.id),await tx.get('thot_records',otherOwner.id)]);
      assert.notEqual(copy.owner_id,original.owner_id);
      assert.equal(copy.subsidy_content_fingerprint,original.subsidy_content_fingerprint);
      await assert.rejects(app.service.trace(contributors[3].actor,paid.trace_id),/NOT_FOUND/);
      await assert.rejects(app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:2,max_gross_thot:'2000',price_ceiling_thot:'1000',workflow:'coding'}),/NO_ELIGIBLE_SAMPLES/);
      assert.equal(await f.reserve.grossCommitted(),parseEther('2000'));
    });
    await t.test('duplicate content is reserved only once, while unpaid buyer preparations do not exclude sampling', async () => {
      const fresh=await enroll(contributors[1],'Unique content for reservation test');
      await relist(fresh,'Second licence for same unsold content','1000');
      await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:fresh.id});
      const batch=await app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:2,max_gross_thot:'2000',price_ceiling_thot:'1000',workflow:'coding'});
      assert.equal(batch.jobs.length,1);
      await assert.rejects(app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:1,max_gross_thot:'1000',price_ceiling_thot:'1000',workflow:'coding'}),/NO_ELIGIBLE_SAMPLES/);
      await app.thot.processSales();
      assert.equal(await f.reserve.grossCommitted(),parseEther('3000'));
      assert.equal(Number((await f.market.offers(batch.jobs[0].id)).status),3);
    });
    await t.test('persisted fair cursor reaches funded sales behind more than 50 abandoned preparations after restart', async () => {
      const abandoned=await enroll(contributors[3],'Many abandoned buyer preparations',{optIn:false});
      const prepared=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:abandoned.id});
      const template=await app.db.transaction(tx=>tx.get('thot_records','intent:'+prepared.id));
      await app.db.transaction(async tx=>{
        for(let n=1;n<=55;n++){
          const offerId='0x'+n.toString(16).padStart(64,'0');
          await tx.insert('thot_records','intent:'+offerId,template.owner_id,{...template,offer_id:offerId,job_status:'awaiting_funding',created_at:new Date(Date.now()-2*86400*1000).toISOString()});
        }
        await tx.update('thot_records','automation:sales-cursor',{kind:'automation_cursor',last_id:''});
      });
      const sale=await enroll(contributors[0],'Funded after the abandoned queue',{optIn:false});
      const purchase=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:sale.id});await send(f.buyer,purchase.transactions);
      await app.thot.processSales();
      const cursorBefore=await app.db.transaction(tx=>tx.get('thot_records','automation:sales-cursor'));
      assert.ok(cursorBefore.last_id);
      await app.close();app=await createApplication({dataDir:dir,thot:config});
      assert.equal((await app.db.transaction(tx=>tx.get('thot_records','automation:sales-cursor'))).last_id,cursorBefore.last_id);
      await app.thot.processSales();
      assert.equal(Number((await f.market.offers(purchase.id)).status),3);
      await f.advance(Number(await f.market.DISPUTE_WINDOW())+1);await app.thot.processSales();await app.thot.processSales();
      assert.equal(Number((await f.market.offers(purchase.id)).status),5);
      const revocation=await app.thot.unlist(contributors[3].actor,randomUUID(),abandoned.id);await send(contributors[3].signer,revocation.transactions);
      await app.thot.processSales();await app.thot.processSales();
      const abandonedRows=await app.db.transaction(async tx=>(await tx.list('thot_records')).filter(r=>r.kind==='intent'&&r.listing_id===abandoned.id));
      assert.equal(abandonedRows.length,56);assert.ok(abandonedRows.every(r=>r.job_status==='complete'&&r.unfunded_closed));
    });
    await t.test('a worker recovering after 48 hours refunds undelivered purchases to the original buyer', async () => {
      const sale=await enroll(contributors[3],'Undelivered during worker outage',{optIn:false});
      const purchase=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:sale.id});
      const balance=await f.token.balanceOf(await f.buyer.getAddress());await send(f.buyer,purchase.transactions);
      assert.equal(Number((await f.market.offers(purchase.id)).status),2);
      await f.advance(48*3600+1);await app.thot.processSales();
      assert.equal(Number((await f.market.offers(purchase.id)).status),6);
      assert.equal(await f.token.balanceOf(await f.buyer.getAddress()),balance);
      assert.equal((await app.db.transaction(tx=>tx.get('thot_records','intent:'+purchase.id))).job_status,'complete');
    });
    await t.test('a funding transaction between worker snapshots is reconciled rather than permanently blocked', async () => {
      const listed=await enroll(contributors[1],'Concurrent reserve funding');
      const batch=await app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:1,max_gross_thot:'1000',price_ceiling_thot:'1000',workflow:'coding'});
      assert.equal(batch.jobs[0].listing_id,listed.id);
      const [intent,listing]=await app.db.transaction(async tx=>[await tx.get('thot_records','intent:'+batch.jobs[0].id),await tx.get('thot_records',listed.id)]);
      const before=await f.reserve.grossCommitted(),original=app.thot.chain.authorizationState.bind(app.thot.chain);let injected=false;
      app.thot.chain.authorizationState=async(seller,nonce)=>{
        if(nonce===listing.authorization.nonce&&!injected){injected=true;await app.thot.chain.purchaseSample(intent.offer,listing.authorization,listing.signature,intent.review_hash);}
        return original(seller,nonce);
      };
      try{await app.thot.processSales();}finally{app.thot.chain.authorizationState=original;}
      assert.equal(injected,true);assert.equal(await f.reserve.grossCommitted(),before+parseEther('1000'));
      assert.equal(Number((await f.market.offers(intent.offer_id)).status),3);
      assert.equal((await app.db.transaction(tx=>tx.get('thot_records',intent.id))).job_status,'awaiting_settlement');
    });
    await t.test('a funded but refunded sample cannot repeatedly consume subsidy under new listings', async () => {
      const listed=await enroll(contributors[1],'Refunded sampled content');
      const batch=await app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:1,max_gross_thot:'1000',price_ceiling_thot:'1000',workflow:'coding'});
      assert.equal(batch.jobs[0].listing_id,listed.id);
      const [intent,listing]=await app.db.transaction(async tx=>[await tx.get('thot_records','intent:'+batch.jobs[0].id),await tx.get('thot_records',listed.id)]);
      await app.thot.chain.purchaseSample(intent.offer,listing.authorization,listing.signature,intent.review_hash);
      const committed=await f.reserve.grossCommitted();await f.advance(48*3600+1);await app.thot.processSales();
      assert.equal(Number((await f.market.offers(intent.offer_id)).status),6);
      assert.equal((await app.db.transaction(tx=>tx.get('thot_records','sampling-content:'+listing.subsidy_content_fingerprint))).status,'committed');
      await relist(listed,'Refunded material with new title','1000');
      await assert.rejects(app.thot.queueSamples(demoOperator,randomUUID(),{max_samples:1,max_gross_thot:'1000',price_ceiling_thot:'1000',workflow:'coding'}),/NO_ELIGIBLE_SAMPLES/);
      assert.equal(await f.reserve.grossCommitted(),committed);
    });
    await t.test('canonical observation anchors suppress prices from a reverted post-deployment sale', async () => {
      const target=await enroll(contributors[3],'Unsold comparable target',{optIn:false});
      const sale=await enroll(contributors[0],'Independently reviewed comparable',{optIn:false});
      const baseline=(await app.thot.workspace(contributors[3].actor)).valuations.find(v=>v.trace_id===target.trace_id);
      const baselineCount=baseline.estimate.independent.sample_count;
      const snapshot=await f.provider.send('evm_snapshot',[]);
      const purchase=await app.thot.prepareOffer(demoBuyer,randomUUID(),{listing_id:sale.id});
      await send(f.buyer,purchase.transactions);await app.thot.processSales();await f.advance(Number(await f.market.DISPUTE_WINDOW())+1);await app.thot.processSales();
      const observation=await app.db.transaction(tx=>tx.get('thot_records','observation:'+purchase.id));
      assert.ok(observation.confirmation_block.hash);
      assert.equal(await app.thot.chain.isCanonicalBlock(observation.confirmation_block),true);
      const before=(await app.thot.workspace(contributors[3].actor)).valuations.find(v=>v.trace_id===target.trace_id);
      assert.equal(before.estimate.independent.sample_count,baselineCount+1,'the new comparable adds exactly one canonical observation');
      await f.provider.send('evm_revert',[snapshot]);
      assert.equal(await app.thot.chain.isCanonicalBlock(observation.confirmation_block),false);
      const after=(await app.thot.workspace(contributors[3].actor)).valuations.find(v=>v.trace_id===target.trace_id);
      assert.equal(after.estimate.independent.sample_count,baselineCount,'reverting this sale leaves earlier canonical purchases intact');
      // Put this completed job first in the bounded recovery page, then verify
      // its persisted completion does not strand the now-absent onchain sale.
      await app.db.transaction(tx=>tx.update('thot_records','automation:completed-sales-cursor',{kind:'automation_cursor',last_id:'intent:0x'+(BigInt(purchase.id)-1n).toString(16).padStart(64,'0')}));
      await app.thot.processSales();
      assert.equal((await app.db.transaction(tx=>tx.get('thot_records','intent:'+purchase.id))).job_status,'awaiting_funding');
      await send(f.buyer,purchase.transactions);await app.thot.processSales();
      assert.equal(Number((await f.market.offers(purchase.id)).status),3);
      await f.advance(Number(await f.market.DISPUTE_WINDOW())+1);await app.thot.processSales();
      const recovered=await app.db.transaction(tx=>tx.get('thot_records','intent:'+purchase.id));
      assert.equal(recovered.job_status,'complete');assert.equal(await app.thot.chain.isCanonicalBlock(recovered.completion_block),true);
    });
    await t.test('onchain revocation and expiry deactivate listings and remove only copies without paid obligations', async () => {
      const revoked=await enroll(contributors[3],'Revoked without frontend unlisting',{optIn:false});
      const row=await app.db.transaction(tx=>tx.get('thot_records',revoked.id));
      await(await contributors[3].signer.sendTransaction(app.thot.chain.transaction('market','revokeSaleAuthorization',[row.authorization.nonce]))).wait();
      await app.thot.sweepRetention();
      const cleared=await app.db.transaction(tx=>tx.get('thot_records',revoked.id));assert.equal(cleared.active,false);assert.ok(cleared.release_deleted_at);
      const expired=await enroll(contributors[3],'Authorization expires while source retained',{optIn:false});
      const expiring=await app.db.transaction(tx=>tx.get('thot_records',expired.id));
      await f.warp(expiring.authorization.validUntil);await app.thot.sweepRetention();
      const ended=await app.db.transaction(tx=>tx.get('thot_records',expired.id));assert.equal(ended.active,false);assert.ok(ended.release_deleted_at);
      const paidListing=await app.db.transaction(tx=>tx.get('thot_records',queued.jobs[0].listing_id));
      assert.equal(paidListing.release_deleted_at,undefined);
    });
  } finally {
    if (app) await app.close();
    await f.close();
    await rm(dir, {recursive: true, force: true});
  }
});
