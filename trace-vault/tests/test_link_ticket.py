"""Offline ticket interoperability and rejection checks; no brokerage credentials."""
import datetime as dt
import json
import pathlib
import subprocess
import sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from link_ticket import verify_ticket
from witness import _offered_alpn, _parse_sni
import ssl

script="""
import {generateKeyPairSync, sign} from 'node:crypto';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const payload={schema_version:'thot.robinhood-link-ticket/1',job_id:'job-1',owner_user_id:'owner-1',nonce:'a'.repeat(64),issued_at:'2026-09-07T16:00:00Z',expires_at:'2026-09-07T16:10:00Z',audience:'trace-vault-robinhood'};
const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
console.log(JSON.stringify({ticket:encoded+'.'+sign(null,Buffer.from(encoded),privateKey).toString('base64url'),publicKey:publicKey.export({type:'spki',format:'pem'})}));
"""
fixture=json.loads(subprocess.check_output(['node','--input-type=module','-e',script]))
now=dt.datetime(2026,9,7,16,1,tzinfo=dt.timezone.utc)
assert verify_ticket(fixture['ticket'],fixture['publicKey'],now)['owner_user_id']=='owner-1'
for ticket,time in [(fixture['ticket'][:-10]+'aaaaaaaaaa',now),(fixture['ticket'],now+dt.timedelta(minutes=10))]:
    try: verify_ticket(ticket,fixture['publicKey'],time)
    except Exception: pass
    else: raise AssertionError('invalid ticket accepted')
for protocols in [['http/1.1'],['h2','http/1.1']]:
    ctx=ssl.create_default_context();ctx.set_alpn_protocols(protocols)
    incoming,outgoing=ssl.MemoryBIO(),ssl.MemoryBIO();conn=ctx.wrap_bio(incoming,outgoing,server_hostname='api.robinhood.com')
    try:conn.do_handshake()
    except ssl.SSLWantReadError:pass
    hello=outgoing.read()
    assert _offered_alpn(hello)==protocols
    assert _parse_sni(hello)=='api.robinhood.com'
print('test_link_ticket: PASS (Node/Python signatures; expiry; ClientHello policy)')
