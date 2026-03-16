import os
import sys

# Add gen/ to sys.path so generated protobuf imports like
# "from opentrace.v1 import ..." resolve correctly.
_gen_dir = os.path.dirname(__file__)
if _gen_dir not in sys.path:
    sys.path.insert(0, _gen_dir)
