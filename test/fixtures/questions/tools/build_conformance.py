"""Write test/questions/OracleConsumerConformance.t.sol from the protocol's reference.

Usage: python3 -I build_conformance.py <REFERENCE.md> <out file> [--check]

The protocol's test is taken byte for byte from the `OracleConsumerConformance.t.sol` section and
changed in exactly three places, each an exact string replacement that must match once:
the imports, the type of the `consumer` variable, and `deployConsumer`. With --check the script
writes nothing and exits 1 unless the file on disk equals what it would write.

The reference this follows is the one delivered with version 2 of the Intake (13 October 2026).
Against the earlier text it differs in `deployConsumer` alone, where the example consumer now pins
the vector's question (`expectQuestion`); the vector constants and every test are unchanged.
"""

import sys

ref_path, out_path = sys.argv[1], sys.argv[2]
check = "--check" in sys.argv[3:]

raw = open(ref_path, "rb").read().decode("utf-8")
heading = "## `OracleConsumerConformance.t.sol`\n"
assert raw.count(heading) == 1
start = raw.index("\n```solidity\n", raw.index(heading)) + len("\n```solidity\n")
end = raw.index("\n```\n", start) + 1
source = raw[start:end]


def swap(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)


IMPORTS_OLD = """import {Test} from "forge-std/Test.sol";
import {OracleAttestation} from "../src/OracleAttestation.sol";
import {IntakeDelivery} from "../src/IntakeDelivery.sol";
import {OracleDeliveryReceiver} from "../src/examples/OracleDeliveryReceiver.sol";
"""
IMPORTS_NEW = """import {Test} from "forge-std/Test.sol";
import {OracleAttestation} from "../../src/questions/OracleAttestation.sol";
import {IntakeDelivery} from "./mocks/IntakeDelivery.sol";
import {QuestionsVectorHarness} from "./mocks/QuestionsVectorHarness.sol";

// HELP WANTED: this is the protocol's conformance test, copied by a script from the oracle-consumer
// reference (`OracleConsumerConformance.t.sol` in REFERENCE.md). Three things differ from the
// reference and nothing else, the vector constants least of all:
//   1. the imports above: this project's paths, a stand-in for IntakeDelivery, and the consumer;
//   2. the type of `consumer`;
//   3. `deployConsumer`, which deploys Questions at the vector address.
// Formatting is switched off below so the protocol's text stays as it was delivered.
// forgefmt: disable-start
"""

VAR_OLD = "    OracleDeliveryReceiver consumer;\n"
VAR_NEW = "    QuestionsVectorHarness consumer;\n"

DEPLOY_OLD = """    function deployConsumer() internal {
        deployCodeTo(
            "OracleDeliveryReceiver.sol:OracleDeliveryReceiver",
            abi.encode(address(this), caller(), SIGNER),
            VECTOR_CONSUMER
        );
        consumer = OracleDeliveryReceiver(VECTOR_CONSUMER);
        // Whatever your consumer needs to take the vector's question as its own; this one pins it.
        consumer.expectQuestion(vector().questionHash, true);
    }
"""
DEPLOY_NEW = """    function deployConsumer() internal {
        // Questions(intake, imd, oracleSigner): it trusts `caller()` as its Intake and `SIGNER` as
        // its oracle. The token is never touched here; any non-zero address will do.
        deployCodeTo(
            "QuestionsVectorHarness.sol:QuestionsVectorHarness",
            abi.encode(caller(), address(0x1D), SIGNER),
            VECTOR_CONSUMER
        );
        consumer = QuestionsVectorHarness(VECTOR_CONSUMER);
        // Whatever your consumer needs to take the vector's question as its own. The reference's
        // example pins the question hash here. Questions takes an answer only for a round it asked
        // for itself, and holds that round to the question hash it built when it asked, so the
        // vector's round is planted as pending, with the vector's question hash pinned, under each
        // request id the tests below deliver with.
        consumer.plant(keccak256("source request"), vector());
        consumer.plant(bytes32(0), vector());
    }
"""

out = swap(source, IMPORTS_OLD, IMPORTS_NEW)
out = swap(out, VAR_OLD, VAR_NEW)
out = swap(out, DEPLOY_OLD, DEPLOY_NEW)
assert out.endswith("}\n")
out += "// forgefmt: disable-end\n"

if check:
    same = open(out_path, encoding="utf-8").read() == out
    print("identical to the generated file" if same else "DIFFERENT from the generated file")
    sys.exit(0 if same else 1)
open(out_path, "w", encoding="utf-8").write(out)
print("wrote", out_path)
