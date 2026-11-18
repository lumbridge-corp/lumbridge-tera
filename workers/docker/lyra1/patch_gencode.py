"""Point hard-coded nvcc -gencode targets in setup.py files at sm_121 (GB10).

Every "arch=compute_XX,code=sm_XX" string becomes "arch=compute_121,code=sm_121"
(duplicates are harmless to nvcc); the structure of setup.py is left untouched.
"""

import re
import sys

for path in sys.argv[1:]:
    s = open(path).read()
    s2, n = re.subn(r'"arch=compute_\d+a?,code=(?:sm|compute)_\d+a?"', '"arch=compute_121,code=sm_121"', s)
    if n == 0:
        raise SystemExit(f"{path}: no gencode strings found; upstream changed, patch by hand")
    open(path, "w").write(s2)
    print(f"{path}: {n} gencode entries -> sm_121")
