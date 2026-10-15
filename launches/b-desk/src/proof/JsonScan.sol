// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWorkProof} from "../interfaces/IWorkProof.sol";

/// @title JsonScan: reads the top level of an IdentityMD work record without parsing the rest
/// @notice An internal library (it is compiled into `WorkProof`; nothing is linked and nothing is
/// called). It finds six top-level members of a work record, `jobId`, `kind`, `objective`, `schema`,
/// `signals` and `state`, and steps over everything else by structure alone.
///
/// @dev WHAT IT ACCEPTS. Only the canonical form IdentityMD's writer produces: one object, no
/// whitespace, members in ascending key order, strings exactly as `JSON.stringify` writes them. The
/// rules it enforces at the top level are:
///   1. byte 0 is `{` and the last byte is `}`;
///   2. a member is `"key":value`, members are separated by one `,`;
///   3. a key is 1 to 31 bytes, each in the range 0x20 to 0x7F (ASCII from the space upward, which
///      the writer copies into a key unchanged), with no `"` and no `\`;
///   4. each key is strictly greater than the one before it (so no key can appear twice);
///   5. a value is a string, an object, an array, or a bare literal made of letters, digits and `+-.`;
///   6. `schema` is exactly `identitymd-work-v1`, and `jobId` is a lowercase 8-4-4-4-12 UUID.
/// It stops at `state`. The members after it (`submissions`, `verification`: nine tenths of an audit
/// record) are covered by the record hash but are never walked, which is what keeps a large record
/// affordable. Nested values are skipped, not validated: the scanner follows their strings and
/// brackets and nothing else.
///
/// WHAT THAT STRICTNESS COSTS. Rules 3 and 6 are narrower than JSON, on purpose: they make one text
/// per record and one order per key set. All 41 records examined have the same 24 top-level keys, the
/// longest 15 ASCII bytes. But this code cannot be changed once it is deployed. Should the writer one
/// day put a longer or non-ASCII key ahead of `state`, or change the form of the job id, while keeping
/// the schema string, every record written from then on is `Malformed` here, and proving those jobs
/// takes a newly deployed verifier.
///
/// WHY A JOB PARTICIPANT CANNOT FORGE A TOP-LEVEL MEMBER. The people around a job (whoever wrote the
/// objective, the agents that wrote findings, file names and reports) control text, and that text
/// reaches the record only as the contents of JSON strings, or as values the writer nests under its
/// own keys. The writer emits every string through `JSON.stringify`, which turns each `"` into `\"`
/// and each `\` into `\\`. So in a record the writer produced, a `"` byte is either a real string
/// delimiter or it follows an odd run of backslashes. This scanner uses the same rule from the other
/// side: inside a string it stops at the first `"` that is not escaped, and a `\` always consumes the
/// byte after it. The two therefore agree, byte for byte, on where every string begins and ends.
/// Text inside a string can look like `","state":"completed"` as much as it likes: the quotes in it
/// are escaped, so the scanner is still inside the string when it passes them. Brackets are counted
/// only outside strings, so nothing inside a nested value can be read at depth 1 either. UTF-8 does
/// not open a side door: every byte of a multi-byte character is 0x80 or above, so it can never be
/// mistaken for `"` (0x22) or `\` (0x5C). What is left at depth 1 is exactly what the writer put
/// there, in the writer's own key order, and rule 4 means there is one of each.
///
/// The scan is not a substitute for the hash check. It says where the members are in the bytes it
/// was given; `WorkProof.prove` is what ties those bytes to the registry.
library JsonScan {
    /// @dev The captured members as memory locations inside the scanned buffer. A pointer addresses
    /// the first byte of a string's contents (after the opening quote); `signalsPtr` addresses the
    /// array's opening bracket and `signalsLen` runs through its closing bracket.
    struct Spans {
        bytes16 jobId;
        uint256 kindPtr;
        uint256 kindLen;
        uint256 objectivePtr;
        uint256 objectiveLen;
        /// @dev Both zero when `signals` is absent or is not an array.
        uint256 signalsPtr;
        uint256 signalsLen;
        uint256 statePtr;
        uint256 stateLen;
    }

    /// @dev The most agent ids `agentIds` returns.
    uint256 internal constant MAX_AGENTS = 16;

    // One copy of a byte in each of the 32 lanes of a word, for the word-at-a-time tests. A lane is
    // one byte of the word; lane 0 is the last byte read from memory and lane 31 the first.
    //
    // A note for whoever edits this file. With 200 optimizer runs the compiler replaces any 32-byte
    // constant that is pushed four or more times in the contract with a routine that copies it out
    // of the code (about 35 gas a use instead of 3), and it undoes any attempt to hold the constant
    // in a variable. The lane tests below are therefore written so that none of these constants is
    // pushed more than three times in the compiled contract (`ONES` and `BACKSLASHES` are at three).
    // `test_gas_noConstantIsCopiedOutOfTheCode` fails if that slips.
    uint256 private constant ONES = 0x0101010101010101010101010101010101010101010101010101010101010101;
    uint256 private constant LOW7 = 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f;
    uint256 private constant HIGH = 0x8080808080808080808080808080808080808080808080808080808080808080;
    uint256 private constant QUOTES = 0x2222222222222222222222222222222222222222222222222222222222222222;
    uint256 private constant BACKSLASHES = 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c;
    uint256 private constant SPACES = 0x2020202020202020202020202020202020202020202020202020202020202020;
    uint256 private constant SIXTIES = 0x6060606060606060606060606060606060606060606060606060606060606060;
    // `LOW7` and `HIGH` without lane 31, for the one test that has no use for a word's first byte
    // (and, being other constants, they do not count against the limit described above).
    uint256 private constant LOW7_BELOW_31 = 0x007f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f;
    uint256 private constant HIGH_BELOW_31 = 0x0080808080808080808080808080808080808080808080808080808080808080;
    // The top bit of every even-numbered lane, and of every odd-numbered one.
    uint256 private constant HIGH_EVEN = 0x0080008000800080008000800080008000800080008000800080008000800080;
    uint256 private constant HIGH_ODD = 0x8000800080008000800080008000800080008000800080008000800080008000;
    // The bottom bit of every even-numbered lane, and of every odd-numbered one.
    uint256 private constant LOW_EVEN = 0x0001000100010001000100010001000100010001000100010001000100010001;
    uint256 private constant LOW_ODD = 0x0100010001000100010001000100010001000100010001000100010001000100;

    // The captured keys as left-aligned, zero-padded words. Because a key is at most 31 bytes and
    // holds no zero byte, comparing two such words as numbers is comparing the keys byte by byte.
    // (The casts below turn short string literals into words; nothing can be cut off.)
    // forge-lint: disable-start(unsafe-typecast)
    uint256 private constant KEY_JOB_ID = uint256(bytes32("jobId"));
    uint256 private constant KEY_KIND = uint256(bytes32("kind"));
    uint256 private constant KEY_OBJECTIVE = uint256(bytes32("objective"));
    uint256 private constant KEY_SCHEMA = uint256(bytes32("schema"));
    uint256 private constant KEY_SIGNALS = uint256(bytes32("signals"));
    uint256 private constant KEY_STATE = uint256(bytes32("state"));

    uint256 private constant SCHEMA = uint256(bytes32("identitymd-work-v1"));
    // forge-lint: disable-end(unsafe-typecast)
    uint256 private constant SCHEMA_LEN = 18;
    uint256 private constant UUID_LEN = 36;

    /// @dev `{"agentId":"`, the 12 bytes every `signals` element starts with (its keys are sorted and
    /// `agentId` sorts first), right-aligned for comparison with the top 12 bytes of a word.
    uint256 private constant AGENT_PREFIX = 0x7b226167656e744964223a22;
    uint256 private constant AGENT_PREFIX_LEN = 12;
    /// @dev 77 decimal digits always fit a uint256 (10**77 < 2**256); 78 might not.
    uint256 private constant MAX_ID_DIGITS = 77;
    /// @dev `,"value":0}`, the 11 bytes a `signals` element ends with when it records a submission
    /// that verification rejected (`value` sorts last among the element's keys), right-aligned for
    /// comparison with the top 11 bytes of a word.
    uint256 private constant REJECTED_SUFFIX = 0x2c2276616c7565223a307d;
    uint256 private constant REJECTED_SUFFIX_LEN = 11;

    /// @dev Bytes a bare literal may hold, as a bitmap indexed by byte value: `+ - .` (0x2B, 0x2D,
    /// 0x2E), the digits (0x30 to 0x39) and the ASCII letters (0x41 to 0x5A, 0x61 to 0x7A). That covers
    /// `null`, `true`, `false` and every number, and leaves out all structure and all whitespace.
    /// It equals `(1<<0x2b)|(1<<0x2d)|(1<<0x2e)|(0x3ff<<0x30)|(0x3ffffff<<0x41)|(0x3ffffff<<0x61)`;
    /// a test checks every byte value against that description.
    uint256 private constant LITERAL_BYTES = 0x7fffffe07fffffe03ff680000000000;

    uint256 private constant QUOTE = 0x22; // "
    uint256 private constant COMMA = 0x2c; // ,
    uint256 private constant COLON = 0x3a; // :
    uint256 private constant OPEN_BRACKET = 0x5b; // [
    uint256 private constant CLOSE_BRACKET = 0x5d; // ]
    uint256 private constant OPEN_BRACE = 0x7b; // {
    uint256 private constant CLOSE_BRACE = 0x7d; // }

    /// @notice Finds the captured members of `record`.
    /// @dev Reverts `Malformed(pos)` with the offset in `record` where the canonical form was broken,
    /// `MissingKey` when the top level ends, or passes `state`, without all five required members
    /// (`jobId`, `kind`, `objective`, `schema`, `state`), and `WrongSchema` when `schema` is another
    /// string. `signals` is optional here: a record without it simply names no agents.
    ///
    /// Bytes after the `state` member are not examined, apart from the last one. A caller that needs
    /// those bytes to be the genuine record must check the record hash, as `WorkProof.prove` does.
    ///
    /// The loop below reverts from inside: it is a parser, and refusing the input at the byte where
    /// it goes wrong is its job. It runs once per top-level member and holds no state to strand.
    // forge-lint: disable-start(require-revert-in-loop)
    function scan(bytes memory record) internal pure returns (Spans memory s) {
        uint256 base;
        uint256 end;
        assembly ("memory-safe") {
            base := add(record, 0x20)
            end := add(base, mload(record))
        }
        // Pointer arithmetic below stays within [base, end + 32]; none of it can overflow.
        unchecked {
            if (base == end || _at(base) != OPEN_BRACE) revert IWorkProof.Malformed(0);
            // A canonical record is one object, so it ends with its closing brace. This is what turns
            // away a file saved with a trailing newline before anyone hashes it by mistake.
            if (_at(end - 1) != CLOSE_BRACE) revert IWorkProof.Malformed(end - 1 - base);

            uint256 p = base + 1;
            // With at least two bytes and the last one `}`, `p < end` holds here.
            if (_at(p) == CLOSE_BRACE) revert IWorkProof.MissingKey();

            uint256 prev = 0; // the previous key; zero sorts below every valid key
            uint256 seen = 0; // bit 0 jobId, bit 1 kind, bit 2 objective, bit 3 schema
            while (true) {
                // --- key ---
                if (p >= end || _at(p) != QUOTE) revert IWorkProof.Malformed(p - base);
                uint256 next = _skipValue(p, end);
                // An unterminated or invalid key reads as zero, which is never above `prev`.
                uint256 key = next == 0 ? 0 : _keyWord(p + 1, next - p - 2);
                if (key <= prev) revert IWorkProof.Malformed(p - base);
                // Keys only rise, so once one sorts after `state` the member cannot still be coming.
                // Stopping here also keeps a record without `state` from costing a full walk.
                if (key > KEY_STATE) revert IWorkProof.MissingKey();
                prev = key;

                p = next;
                if (p >= end || _at(p) != COLON) revert IWorkProof.Malformed(p - base);
                ++p;
                if (p >= end) revert IWorkProof.Malformed(end - base);

                // --- value ---
                uint256 v = p;
                uint256 c = _at(p);
                if (c == QUOTE || c == OPEN_BRACE || c == OPEN_BRACKET) {
                    p = _skipValue(p, end);
                    if (p == 0) revert IWorkProof.Malformed(end - base);
                } else {
                    p = _skipLiteral(p);
                    if (p == v) revert IWorkProof.Malformed(v - base);
                }

                // --- capture ---
                if (key >= KEY_JOB_ID) {
                    if (key == KEY_SIGNALS) {
                        // Soft by design: anything but an array leaves the span empty.
                        if (c == OPEN_BRACKET) {
                            s.signalsPtr = v;
                            s.signalsLen = p - v;
                        }
                    } else if (
                        key == KEY_JOB_ID || key == KEY_KIND || key == KEY_OBJECTIVE || key == KEY_SCHEMA
                            || key == KEY_STATE
                    ) {
                        if (c != QUOTE) revert IWorkProof.Malformed(v - base);
                        // A string value occupies [v, p): its contents sit between the two quotes.
                        uint256 ptr = v + 1;
                        uint256 len = p - v - 2;
                        if (key == KEY_JOB_ID) {
                            bool ok = false;
                            if (len == UUID_LEN) (s.jobId, ok) = _uuid(ptr);
                            if (!ok) revert IWorkProof.Malformed(v - base);
                            seen |= 1;
                        } else if (key == KEY_KIND) {
                            s.kindPtr = ptr;
                            s.kindLen = len;
                            seen |= 2;
                        } else if (key == KEY_OBJECTIVE) {
                            s.objectivePtr = ptr;
                            s.objectiveLen = len;
                            seen |= 4;
                        } else if (key == KEY_SCHEMA) {
                            if (len != SCHEMA_LEN || _head(ptr, SCHEMA_LEN) != SCHEMA) revert IWorkProof.WrongSchema();
                            seen |= 8;
                        } else {
                            // `state`: the last member this scanner needs.
                            if (seen != 15) revert IWorkProof.MissingKey();
                            s.statePtr = ptr;
                            s.stateLen = len;
                            return s;
                        }
                    }
                }

                // --- separator ---
                if (p >= end) revert IWorkProof.Malformed(end - base);
                c = _at(p);
                if (c == CLOSE_BRACE) revert IWorkProof.MissingKey(); // the top level ended before `state`
                if (c != COMMA) revert IWorkProof.Malformed(p - base);
                ++p;
            }
        }
    }

    // forge-lint: disable-end(require-revert-in-loop)

    /// @notice Reads the agent ids out of a `signals` array located by `scan`.
    /// @dev Never reverts. Each element must begin `{"agentId":"<1 to 77 digits>"`; the rest of the
    /// element is skipped by structure. The result holds each id once, in order of first appearance,
    /// and stops at `MAX_AGENTS` ids (elements after the sixteenth distinct id are not read). If any
    /// element that is read has another shape, the result is empty: a partial list would pay some
    /// workers and silently drop others, and an empty one sends the tip to the general seat pool.
    ///
    /// REJECTED SUBMISSIONS ARE LEFT OUT. The writer adds a signal for each submission it verified
    /// or reviewed, with `value` 1 when the submission was accepted and 0 when it was rejected (in
    /// the 41 records examined, 101 signals and 3; each of the 3 matches a `rejected` entry in the
    /// record's own `verification` list). An element whose last member is `"value":0` is therefore
    /// read and then not counted, so an agent appears only if at least one of its signals is not a
    /// rejection. The test is on the element's last 11 bytes, `,"value":0}`, and no text inside the
    /// element can stage it. The final `}` is the element's own closing brace, found by the same walk
    /// that found every other boundary. The `0` and the `:` in front of it are outside any string,
    /// because a string holding them would have to close before that brace and no quote follows
    /// them. So the quote in front of the colon closes a string, and the quote six bytes before it,
    /// which follows a comma and not a backslash, is the one that opened it: `value` is a whole key,
    /// and its member is the last one of the element itself. If the writer ever adds a key that
    /// sorts after `value`, the test stops matching and rejected submissions count again, as they did
    /// before this rule: it fails toward naming more agents, never toward dropping one that was
    /// accepted.
    /// @param ptr `Spans.signalsPtr`: the array's opening bracket, or zero.
    /// @param len `Spans.signalsLen`: through the closing bracket, as `scan` measured it.
    function agentIds(uint256 ptr, uint256 len) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](MAX_AGENTS);
        uint256 n = 0;
        // `scan` has already walked [ptr, ptr + len) as one balanced array, so the walk below cannot
        // leave it: every element skip is bounded by `end`, and the digit loop stops at the first byte
        // that is not a digit, which at the latest is the closing quote of the id string.
        unchecked {
            uint256 end = ptr + len;
            uint256 p = ptr + 1;
            // `len < 3` is "no array" (0) or the empty array `[]` (2).
            while (len > 2) {
                if (end - p < AGENT_PREFIX_LEN || _head(p, AGENT_PREFIX_LEN) >> 160 != AGENT_PREFIX) {
                    n = 0;
                    break;
                }
                // The element's end; its closing brace must leave room for the array's own bracket.
                uint256 next = _skipValue(p, end);
                if (next == 0 || next >= end) {
                    n = 0;
                    break;
                }
                p += AGENT_PREFIX_LEN;
                uint256 id = 0;
                uint256 digits = 0;
                while (true) {
                    uint256 d = _at(p) - 0x30;
                    if (d > 9) break;
                    if (digits == MAX_ID_DIGITS) {
                        digits = 0;
                        break;
                    }
                    id = id * 10 + d;
                    ++digits;
                    ++p;
                }
                if (digits == 0 || _at(p) != QUOTE) {
                    n = 0;
                    break;
                }
                // `p` is on the id's closing quote and `next` is just past the element's closing
                // brace. The suffix counts only if it lies wholly after the id. (Digits and the id's
                // quotes could not spell it anyway; the length test says so without an argument.)
                if (
                    next - p <= REJECTED_SUFFIX_LEN
                        || _head(next - REJECTED_SUFFIX_LEN, REJECTED_SUFFIX_LEN) >> 168 != REJECTED_SUFFIX
                ) {
                    uint256 i = 0;
                    while (i < n && ids[i] != id) ++i;
                    if (i == n) {
                        ids[n] = id;
                        ++n;
                        if (n == MAX_AGENTS) break;
                    }
                }
                uint256 c = _at(next);
                if (c == CLOSE_BRACKET && next + 1 == end) break;
                if (c != COMMA) {
                    n = 0;
                    break;
                }
                p = next + 1;
            }
        }
        assembly ("memory-safe") {
            mstore(ids, n) // shrink to the ids found; the unused tail stays allocated and unreferenced
        }
    }

    /// @dev The byte at memory position `p`.
    function _at(uint256 p) private pure returns (uint256 c) {
        assembly ("memory-safe") {
            c := byte(0, mload(p))
        }
    }

    /// @dev The first `len` (1 to 32) bytes at `p`, left-aligned, the rest zero.
    function _head(uint256 p, uint256 len) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := and(mload(p), not(shr(shl(3, len), not(0))))
        }
    }

    /// @dev Turns the `len` bytes at `p` (the text between a top-level key's quotes) into a word.
    /// @return key The key left-aligned and zero-padded, or zero when it is not a valid key: empty,
    /// longer than 31 bytes, or holding a backslash or a byte outside 0x20 to 0x7F. Canonical JSON
    /// never needs an escape inside the keys IdentityMD writes, so a backslash in a key is refused
    /// instead of interpreted; and with only ASCII allowed, byte order here is the same as the UTF-16
    /// order `Object.keys().sort()` uses. A valid key is never zero, since none of its bytes is.
    function _keyWord(uint256 p, uint256 len) private pure returns (uint256 key) {
        assembly ("memory-safe") {
            if and(gt(len, 0), lt(len, 32)) {
                let tail := shr(shl(3, len), not(0)) // ones over the lanes after the key
                let k := and(mload(p), not(tail))
                // Pad the unused lanes with spaces so that all 32 can be tested at once.
                let t := or(k, and(SPACES, tail))
                // Range: a lane is 0x20 to 0x7F exactly when its own top bit is clear and adding 0x60
                // sets it. `or(not(add(..)), t)` has a top bit set wherever either half fails. (A lane
                // with its top bit set can carry into its neighbour, but it has already failed.)
                // Backslash: `x` has a zero lane where `t` holds one, and `(x - 1s) & ~x` has a top
                // bit set if and only if `x` has a zero lane somewhere.
                let x := xor(t, BACKSLASHES)
                if iszero(and(or(or(not(add(t, SIXTIES)), t), and(sub(x, ONES), not(x))), HIGH)) { key := k }
            }
        }
    }

    /// @dev Steps over the value that begins at `p`, which must be a string (`"`), an object (`{`) or
    /// an array (`[`). The caller checks that first byte.
    /// @return next The position just past the value's last byte (its closing quote or its matching
    /// closing bracket), or zero when the buffer ends first.
    ///
    /// Two things are tracked and nothing else: whether the walk is inside a string, and how many
    /// brackets are open. Outside strings it reads a byte at a time, since in canonical JSON the gaps
    /// between strings are one or two bytes long. Inside a string it reads 32 bytes at a time.
    ///
    /// HOW A STRING'S END IS FOUND. The JSON rule is: a string ends at the first `"` that is not
    /// escaped, and a `\` escapes exactly the one byte after it (`\"`, `\\`, `\n`, and `\uXXXX`, whose
    /// four hex digits are ordinary content). Read left to right, the contents are therefore a chain
    /// of units, each either one byte that is not a backslash or a backslash plus the byte it escapes.
    /// This routine does not walk the units. It looks for quotes only, and for each one it meets asks
    /// how many backslashes stand directly in front of it. That run starts on a unit boundary: the
    /// byte before the run is not a backslash (it is ordinary content, an escaped byte, or the
    /// string's own opening quote), so a new unit begins with the run's first backslash, and the
    /// backslashes then pair off two by two. An even run uses itself up and the quote is the closing
    /// one; an odd run leaves one backslash to escape the quote, which is then content. The answer is
    /// the same as walking unit by unit, and escapes that are not in front of a quote (the many `\n`
    /// of a long text) cost nothing at all.
    ///
    /// LOOKING AHEAD AFTER AN ESCAPED QUOTE. Text that quotes a great deal (source code, JSON inside a
    /// string) would cost a full search step per quote if each were taken singly, and a job
    /// participant chooses that text. So when a quote proves to be escaped, the 31 bytes after it are
    /// examined together, on the word that starts at the escaped quote (lane 31) and holds those
    /// bytes in lanes 30 down to 0. Picture a second word with 0xFF in each lane where the first has a
    /// backslash and 0x00 elsewhere, and add 1 to the lane just before each quote ("before" in
    /// reading order is the next more significant lane, which is the way a carry travels). A lane at
    /// 0xFF rolls over to 0x00 and carries on, so the 1 ripples back through the whole run of
    /// backslashes in front of that quote and comes to rest in the first lane that is not a
    /// backslash. From the quote to its resting lane is the run length plus one, so the quote is
    /// unescaped (even run) exactly when quote and resting lane have numbers of different parity.
    /// Quotes on even lanes and quotes on odd lanes go through two separate additions, so that each
    /// resting lane can be judged by its own parity alone.
    /// Why the additions cannot mislead: the run in front of a quote is made of backslashes only and
    /// ends at the nearest earlier byte that is not one. Lane 31 is a quote, so every run ends inside
    /// the word and no carry leaves it; and a run cannot reach past the quote before it, so two
    /// ripples never share a lane and a lane that is not a backslash receives at most one carry.
    /// Every unescaped quote among the 31 bytes thus has a resting lane marked as such, and lies
    /// after it.
    /// What is done with the answer. If no resting lane is marked, the 31 bytes hold no string end
    /// and the search resumes after them. Otherwise it resumes at the byte after the earliest marked
    /// resting lane. Every unescaped quote lies after its own resting lane, and none of those lanes
    /// is earlier than that one, so every unescaped quote is at or after the byte where the search
    /// resumes: nothing that could end the string is passed over. The look-ahead never accepts a
    /// quote. Wherever the search resumes, the next quote it meets is judged, like every other, by
    /// counting the backslashes in front of it.
    ///
    /// A word may reach past `end`; a quote found there is treated as the buffer ending, so bytes
    /// outside the buffer never count. (In the look-ahead they can only add quotes and so add marked
    /// resting lanes, which can only make the search resume earlier: what stands after a quote has no
    /// part in how that quote is judged.) There is no recursion and no depth limit: cost is linear in
    /// the bytes walked however deep the value nests. The kind of bracket is not matched and the
    /// contents are not validated; that is the canonical writer's job, and the record hash is what
    /// vouches for the writer.
    ///
    /// WHAT THE WALK COSTS, measured on the compiled contract with copying and hashing included.
    /// Through a string: about 4 gas a byte for plain text and under 20 whatever the text holds
    /// (quotation marks, backslashes, or both in any pattern), plus a few hundred gas once where the
    /// string ends. Between strings the walk is a byte at a time: about 355 gas for each short string,
    /// about 115 a byte for numbers and literals, about 175 a byte for bare brackets, and just under
    /// 200 a byte for the costliest shape found, a run of five-byte strings that each hold one
    /// escaped quotation mark. So the shape of a record, which only the writer decides, sets the cost
    /// of walking it, and its text, which job participants write, does not.
    /// `test/proof/WorkProof.gas.t.sol` pins each of these figures.
    function _skipValue(uint256 p, uint256 end) private pure returns (uint256 next) {
        assembly ("memory-safe") {
            // The top bit of every lane of `x` that is zero, lane 31 left out. Exact, by the argument
            // given at the quote search below.
            function zeroLanesBelow31(x) -> marks {
                marks := and(not(or(add(and(x, LOW7_BELOW_31), LOW7_BELOW_31), x)), HIGH_BELOW_31)
            }
            function skip(at, limit) -> result {
                let depth := 0
                for {} lt(at, limit) {} {
                    let c := byte(0, mload(at))
                    at := add(at, 1)
                    if eq(c, 0x22) {
                        // One string, or several in a row. `at` is on the first byte of the contents.
                        for {} 1 {} {
                            // Quote by quote, to the one that closes this string.
                            for {} 1 {} {
                                let m := 0
                                // 32 bytes at a time, to the first that hold a quote. This loop is
                                // kept to itself because nearly all of a long text is spent in it.
                                for {} 1 {} {
                                    // Mark the lanes that hold a quote. A lane of `x` is zero there,
                                    // and `((lane & 0x7f) + 0x7f) | lane` has its top bit clear for a
                                    // zero lane only. No lane can carry into the next, so the marks
                                    // are exact.
                                    let x := xor(mload(at), QUOTES)
                                    m := and(not(or(add(and(x, LOW7), LOW7), x)), HIGH)
                                    if m { break }
                                    at := add(at, 32)
                                    if iszero(lt(at, limit)) { leave } // the buffer ended inside a string
                                }
                                // Move to the first marked lane. Spreading every mark down over the
                                // lanes after it leaves 32 - index lanes marked; multiplying their
                                // low bits by a word of ones adds them up in the top byte.
                                m := or(m, shr(8, m))
                                m := or(m, shr(16, m))
                                m := or(m, shr(32, m))
                                m := or(m, shr(64, m))
                                m := or(m, shr(128, m))
                                at := add(at, sub(32, shr(248, mul(shr(7, m), ONES))))
                                // `at` is on a quote. It ends the string unless it is escaped, and it
                                // is escaped exactly when the run of backslashes right before it has
                                // odd length (see the function comment). Nearly always there is none.
                                if iszero(eq(byte(0, mload(sub(at, 1))), 0x5c)) { break }
                                // Count that run, 32 bytes at a time, backward from the quote. `e` gets
                                // a zero lane wherever those bytes hold a backslash. `e & -e` is its
                                // lowest set bit, and one less than that has every lower bit set, so
                                // the lanes filled up to their top bit are exactly the zero lanes at
                                // the low end: the backslashes nearest the quote. Thirty-two
                                // backslashes in a row give zero, and the count moves on to the 32
                                // bytes before them. It cannot pass the string's opening quote.
                                let run := 0
                                let e := 0
                                for {} 1 {} {
                                    e := xor(mload(sub(at, add(run, 32))), BACKSLASHES)
                                    if e {
                                        e := and(sub(and(e, sub(0, e)), 1), HIGH)
                                        run := add(run, shr(248, mul(shr(7, e), ONES)))
                                        break
                                    }
                                    run := add(run, 32)
                                }
                                if iszero(and(run, 1)) { break }
                                // This quote is escaped, so it is content. Look at the 31 bytes after
                                // it all at once (LOOKING AHEAD in the function comment). In `w` the
                                // escaped quote sits in lane 31 and those bytes in lanes 30 to 0; `m`
                                // marks their quotes and `e` holds 0xFF in each backslash lane. After
                                // the two additions `m` has the bottom bit of every resting lane that
                                // belongs to an unescaped quote.
                                let w := mload(at)
                                m := zeroLanesBelow31(xor(w, QUOTES))
                                e := mul(shr(7, zeroLanesBelow31(xor(w, BACKSLASHES))), 0xff)
                                w := not(e)
                                m := or(
                                    and(and(add(e, shl(1, and(m, HIGH_EVEN))), w), LOW_ODD),
                                    and(and(add(e, shl(1, and(m, HIGH_ODD))), w), LOW_EVEN)
                                )
                                if iszero(m) {
                                    // No unescaped quote: all 31 bytes are content. Go on after them.
                                    at := add(at, 32)
                                    if lt(at, limit) { continue }
                                    leave // the buffer ended inside a string
                                }
                                // Go on from the byte after the highest such lane. Spread downward
                                // and added up as before, the marks count that lane and all below it.
                                m := or(m, shr(8, m))
                                m := or(m, shr(16, m))
                                m := or(m, shr(32, m))
                                m := or(m, shr(64, m))
                                m := or(m, shr(128, m))
                                at := add(at, sub(33, shr(248, mul(m, ONES))))
                            }
                            if iszero(lt(at, limit)) { leave } // that quote lies beyond the buffer
                            at := add(at, 1)
                            if iszero(depth) {
                                result := at // the value was this one string
                                leave
                            }
                            // Inside an object or array a string is nearly always followed by `:"` or
                            // `,"`, which opens the next string. Going straight there saves two turns
                            // of the outer loop and changes nothing else: neither pair touches depth.
                            let pair := shr(240, mload(at))
                            if iszero(or(eq(pair, 0x3a22), eq(pair, 0x2c22))) { break }
                            at := add(at, 2)
                        }
                        continue
                    }
                    // `[` is 0x5B and `{` is 0x7B, `]` is 0x5D and `}` is 0x7D: setting bit 0x20 folds
                    // the square pair onto the curly pair, and no other byte lands on either value.
                    let k := or(c, 0x20)
                    if gt(k, 0x7a) {
                        if eq(k, 0x7b) {
                            depth := add(depth, 1)
                            continue
                        }
                        if eq(k, 0x7d) {
                            // The caller starts this walk on a quote or an opener, so in a balanced
                            // value `depth` is at least 1 whenever a closer is reached.
                            depth := sub(depth, 1)
                            if iszero(depth) {
                                result := at
                                leave
                            }
                        }
                    }
                }
            }
            next := skip(p, end)
        }
    }

    /// @dev Steps over a bare literal (`null`, `true`, `false`, a number) starting at `p`.
    /// @return next The first position holding a byte a literal cannot contain. Needs no bound: the
    /// caller has checked that the buffer's last byte is `}`, which stops the walk.
    function _skipLiteral(uint256 p) private pure returns (uint256 next) {
        assembly ("memory-safe") {
            for {} and(shr(byte(0, mload(p)), LITERAL_BYTES), 1) {} { p := add(p, 1) }
            next := p
        }
    }

    /// @dev Parses 36 bytes at `p` as a lowercase UUID, `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
    /// Uppercase is refused: the canonical writer never produces it, and accepting two spellings of
    /// one id would give one job two valid texts.
    function _uuid(uint256 p) private pure returns (bytes16 id, bool ok) {
        assembly ("memory-safe") {
            let acc := 0
            ok := 1
            for { let i := 0 } lt(i, 36) { i := add(i, 1) } {
                let c := byte(0, mload(add(p, i)))
                switch or(or(eq(i, 8), eq(i, 13)), or(eq(i, 18), eq(i, 23)))
                case 1 { if iszero(eq(c, 0x2d)) { ok := 0 } }
                default {
                    let d := sub(c, 0x30) // '0'..'9' become 0..9; anything below wraps to a huge value
                    if gt(d, 9) {
                        d := sub(c, 0x57) // 'a'..'f' become 10..15
                        if or(lt(d, 10), gt(d, 15)) { ok := 0 }
                    }
                    acc := or(shl(4, acc), and(d, 0x0f))
                }
            }
            id := shl(128, acc)
        }
    }
}
