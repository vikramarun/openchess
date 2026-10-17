#!/usr/bin/env python3
"""Which source revision is actually deployed at an escrow address?

Compares the runtime bytecode at ADDRESS (Base mainnet by default) against the
vendored artifact crates/ledger/abi/ChessEscrow.json at a git ref, masking the
immutables (token, cached chain id, cached domain separator) that are filled in
at construction. Also reports which of the ref's ABI functions are missing from
the deployed code, the `tournaments()` return width the chain gives versus the
ref's ABI, and how much USDC the contract holds.

Use it to pick abi-compat.sh's LIVE_REF, and whenever DEPLOYMENTS.md and the
vendored ABI might have drifted apart.

Usage: verify-deployed.py ADDRESS [--ref origin/main] [--rpc https://mainnet.base.org]
       [--repo PATH]
"""
import argparse, json, subprocess, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("address")
ap.add_argument("--ref", default="origin/main")
ap.add_argument("--rpc", default="https://mainnet.base.org")
ap.add_argument("--repo", default=".")
ap.add_argument("--usdc", default="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
a = ap.parse_args()


def rpc(method, params):
    # Base's public RPC answers 403 to urllib's default User-Agent.
    req = urllib.request.Request(a.rpc, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "curl/8"})
    r = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in r:
        raise RuntimeError(r["error"].get("message", r["error"]))
    return r["result"]


def call(data):
    try:
        return rpc("eth_call", [{"to": a.address, "data": data}, "latest"])
    except RuntimeError as e:
        return None if "revert" in str(e) else f"ERR {e}"


art = json.loads(subprocess.run(["git", "-C", a.repo, "show", f"{a.ref}:crates/ledger/abi/ChessEscrow.json"],
                                capture_output=True, text=True, check=True).stdout)
local = art["deployedBytecode"]["object"].lower().removeprefix("0x")
code = rpc("eth_getCode", [a.address, "latest"]).lower().removeprefix("0x")
if not code:
    sys.exit(f"no contract at {a.address}")

L, C = list(local), list(code)
masked = 0
for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
    for r in refs:
        for i in range(r["start"] * 2, (r["start"] + r["length"]) * 2):
            if i < len(L):
                L[i] = "0"
            if i < len(C):
                C[i] = "0"
        masked += r["length"]
L, C = "".join(L), "".join(C)


def strip_metadata(h):  # the CBOR tail's length is in its last two bytes
    return h[: -(int(h[-4:], 16) * 2 + 4)]


sels = art.get("methodIdentifiers", {})
missing = sorted(f for f, s in sels.items() if s not in code)
tsig = next((f for f in sels if f.startswith("tournaments(")), None)
abi_words = len(next(x for x in art["abi"] if x.get("name") == "tournaments")["outputs"]) if tsig else None
t = call("0x" + sels[tsig] + "00" * 32) if tsig else None
bal = rpc("eth_call", [{"to": a.usdc, "data": "0x70a08231" + a.address[2:].lower().rjust(64, "0")}, "latest"])

ref_sha = subprocess.run(["git", "-C", a.repo, "rev-parse", "--short", a.ref], capture_output=True, text=True).stdout.strip()
print(f"address {a.address}  vs  {a.ref} ({ref_sha})")
print(f"  runtime code          {len(code) // 2} bytes deployed, {len(local) // 2} bytes in the artifact")
same = len(L) == len(C) and L == C
print(f"  identical (immutables masked, {masked} bytes)            {same}")
print(f"  identical ignoring the metadata hash (comment-only edits) {len(L) == len(C) and strip_metadata(L) == strip_metadata(C)}")
print(f"  ref ABI functions absent from deployed code              {missing or 'none'}")
if tsig:
    words = (len(t) - 2) // 64 if isinstance(t, str) and not t.startswith("ERR") else t
    print(f"  tournaments() width: chain {words} words, ref ABI {abi_words}")
print(f"  USDC held             {int(bal, 16) / 1e6:,.6f}")
sys.exit(0 if same or (len(L) == len(C) and strip_metadata(L) == strip_metadata(C)) else 1)
