import io, json, os, sys
sys.path.insert(0,os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import link_capture

class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self,*args): pass
class Opener:
    def __init__(self, values): self.values=list(values); self.requests=[]
    def open(self, request, timeout):
        self.requests.append((request,timeout))
        return Response(json.dumps(self.values.pop(0)).encode())

clock_values=iter([0,0,0.1,0.1,0.2])
opener=Opener([{"receipts":[]},{"receipts":[{"h_cipher_down":"aa"}]}])
receipt=link_capture._fetch_receipt("https://witness.example", "11"*32, "ticket", opener=opener,
    clock=lambda:next(clock_values), pause=lambda _:None)
assert receipt=={"h_cipher_down":"aa"} and len(opener.requests)==2
for request,_ in opener.requests:
    assert "h_client_hello=" in request.full_url
    assert request.get_header("X-thot-link-ticket")=="ticket"

opener=Opener([{"receipts":[{},{}]}])
try: link_capture._fetch_receipt("https://witness.example","11"*32,"ticket",opener=opener,clock=lambda:0,pause=lambda _:None); raise AssertionError("ambiguous accepted")
except RuntimeError as exc: assert str(exc)=="ambiguous_witness_receipt"
print("test_link_capture: PASS")
