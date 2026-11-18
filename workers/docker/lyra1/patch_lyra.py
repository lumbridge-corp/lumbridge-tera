"""Small source patches so Lyra-1 runs on NGC 25.x/26.x (Transformer Engine 2.x)."""

import pathlib
import sys

root = pathlib.Path(sys.argv[1])
OLD = "from transformer_engine.pytorch.attention import DotProductAttention, apply_rotary_pos_emb"
NEW = ("from transformer_engine.pytorch.attention import DotProductAttention\n"
       "try:\n"
       "    from transformer_engine.pytorch.attention.rope import apply_rotary_pos_emb\n"
       "except ImportError:  # TE 1.x\n"
       "    from transformer_engine.pytorch.attention import apply_rotary_pos_emb")
OLD2 = "from transformer_engine.pytorch.attention import apply_rotary_pos_emb"
NEW2 = ("try:\n"
        "    from transformer_engine.pytorch.attention.rope import apply_rotary_pos_emb\n"
        "except ImportError:  # TE 1.x\n"
        "    from transformer_engine.pytorch.attention import apply_rotary_pos_emb")
count = 0
for p in root.rglob("*.py"):
    s = p.read_text()
    t = s.replace(OLD, NEW) if OLD in s else s.replace(OLD2, NEW2) if OLD2 + "\n" in s else s
    if t != s:
        p.write_text(t)
        count += 1
        print("patched", p.relative_to(root))
print(count, "files patched")

# The autoregressive (Pixtral prompt-upsampler) modules are imported by the diffusion
# pipeline but never run here (upsampler disabled). Their Transformer Engine 1.x private
# imports moved in TE 2.x: make each one optional (name -> None) so imports succeed.
import re  # noqa: E402

pat = re.compile(r"^from (transformer_engine[\w.]*) import (.+)$", re.M)
n2 = 0
for p in (root / "cosmos_predict1" / "autoregressive").rglob("*.py"):
    s = p.read_text()

    def repl(m):
        names = [x.strip() for x in m.group(2).split(",")]
        binds = [x.split(" as ")[-1].strip() for x in names]
        none = "\n".join(f"    {b} = None" for b in binds)
        return f"try:\n    from {m.group(1)} import {m.group(2)}\nexcept ImportError:  # TE 2.x moved it; unused at inference\n{none}"

    t = pat.sub(repl, s)
    if t != s:
        p.write_text(t)
        n2 += 1
print(n2, "autoregressive files made TE-optional")
