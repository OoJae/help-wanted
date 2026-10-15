// Builds the cases of the scanner's differential run, deterministically.
//
//   node gen-cases.mjs <out dir>
//
// Writes <out dir>/cases.json: {cases: hex[], heads: number[], handWritten, mutatedSmall, mutatedReal}.
// The cases are record bytes with a head length each: well-formed records, hand-written edge cases
// for every rule of `JsonScan` (keys, separators, strings and their escapes, nesting, the job id, the
// schema, the agent ids and the signals of rejected submissions), and 5,700 random mutations of small
// records and of two real ones, drawn from a fixed seed. `Diff.t.sol` runs the contract over them;
// `../python/make_scan_vectors.py` keeps a sample with the contract's answers as golden vectors.
// See `run.sh` for the whole procedure.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node gen-cases.mjs <out dir>");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "work-records");

// deterministic PRNG
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
};
const ri = (n) => Math.floor(rnd() * n);
const enc = new TextEncoder();

const uuid = "e9efec16-56f3-40d3-9243-52c453effc7d";
const header = "[help-wanted order " + "ab".repeat(32) + "] ";
const bases = [
  `{"jobId":"${uuid}","kind":"audit","objective":"${header}Do the thing.","schema":"identitymd-work-v1","signals":[{"agentId":"52211","x":1}],"state":"completed","submissions":[]}`,
  `{"assessments":[{"a":"q\\"uote","b":[1,2,{"c":"}]"}]}],"deployments":null,"fuzz":false,"identity":{"x":"y\\\\"},"interpretation":"t\\u00e9xt \\n","jobId":"${uuid}","kind":"skill:research-report","nodes":[],"objective":"${header}Line one\\nLine \\"two\\" \\\\ end","parentJobId":null,"planHash":"0xabc","previousHash":"0x00","projectId":null,"publication":{},"receiptIdentity":{"k":-1.5e+3},"registry":"0xb6","research":null,"schema":"identitymd-work-v1","signals":[{"agentId":"1"},{"agentId":"22","tag":"}"},{"agentId":"1"}],"site":null,"snapshotHash":"0x1","state":"blocked","submissions":[{"z":"\\""}],"verification":{}}`,
  `{"jobId":"${uuid}","kind":"k","objective":"o","schema":"identitymd-work-v1","state":"s"}`,
  `{"jobId":"${uuid}","kind":"","objective":"","schema":"identitymd-work-v1","signals":[],"state":""}`,
];
const real = [
  `${FIXTURES}/a28927265e95c209bdc7ccdba4c0c28724137eab6444fc03849a66cb376f43dc.json`,
  `${FIXTURES}/c31895f6240944599210ed0ca59137dc9573673fb61f2aa0c91f047ed8cb7851.json`,
].map((p) => new Uint8Array(readFileSync(p)));

const interesting = [
  0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x3a, 0x20, 0x00, 0x0a, 0x7f, 0x80, 0xff, 0xef, 0xbb, 0xbf, 0x30,
  0x39, 0x61, 0x7a, 0x41, 0x2b, 0x2d, 0x2e, 0x2f, 0x1f, 0x21,
];
function mutate(b) {
  let a = Array.from(b);
  const rounds = 1 + ri(3);
  for (let r = 0; r < rounds; r++) {
    const op = ri(8);
    const at = ri(a.length + 1);
    const byte = rnd() < 0.8 ? interesting[ri(interesting.length)] : ri(256);
    if (op === 0 && a.length) a[Math.min(at, a.length - 1)] = byte;
    else if (op === 1 && a.length) a.splice(Math.min(at, a.length - 1), 1);
    else if (op === 2) a.splice(at, 0, byte);
    else if (op === 3) a = a.slice(0, at);
    else if (op === 4) a.push(byte);
    else if (op === 5) {
      const len = 1 + ri(12);
      const from = ri(Math.max(1, a.length - len));
      a.splice(at, 0, ...a.slice(from, from + len));
    } else if (op === 6) {
      const len = 1 + ri(40);
      a.splice(Math.min(at, a.length), len);
    } else if (op === 7) {
      // swap two bytes
      if (a.length > 1) {
        const i = ri(a.length),
          j = ri(a.length);
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
    }
  }
  return new Uint8Array(a);
}

const cases = [];
const heads = [];
const push = (b, h = 85) => {
  cases.push(typeof b === "string" ? enc.encode(b) : b);
  heads.push(h);
};

// straight
for (const s of bases) for (const h of [0, 1, 85, 86, 98, 99, 100, 200, 100000]) push(s, h);
for (const r of real) for (const h of [0, 85, 100000]) push(r, h);
// targeted
const T = (s, h = 0) => push(s, h);
const rec = (members) => `{${members}}`;
const core = (o = {}) => {
  const m = {
    jobId: `"${uuid}"`,
    kind: `"audit"`,
    objective: `"${header}x"`,
    schema: `"identitymd-work-v1"`,
    state: `"completed"`,
    ...o,
  };
  return rec(
    Object.keys(m)
      .sort()
      .map((k) => `"${k}":${m[k]}`)
      .join(","),
  );
};
T("");
T("{");
T("}");
T("{}");
T("[]");
T(" {}");
T("{} ");
T("{}\n");
T(core() + "\n");
T(core() + "}");
T("{" + core());
T(core({ jobId: `"${uuid.toUpperCase()}"` }));
T(core({ jobId: `"${uuid}0"` }));
T(core({ jobId: `"${uuid.slice(1)}"` }));
T(core({ jobId: `"${uuid.replace(/-/g, "_")}"` }));
T(core({ jobId: `"\u{feff}${uuid}"` }));
T(core({ schema: `"\u{feff}identitymd-work-v1"` }));
T(core({ state: `"\u{feff}completed"` }));
T(core({ state: `"\\u0063ompleted"` }));
T(core({ jobId: `null` }));
T(core({ kind: `1` }));
T(core({ objective: `["x"]` }));
T(core({ schema: `"identitymd-work-v2"` }));
T(core({ schema: `"identitymd-work-v1 "` }));
T(core({ state: `{}` }));
T(core({ state: `true` }));
T(core({ signals: `{}` }));
T(core({ signals: `"x"` }));
T(core({ signals: `null` }));
T(core({ signals: `[]` }));
T(core({ signals: `[[]]` }));
T(core({ signals: `[{}]` }));
T(core({ signals: `[{"agentId":"1"}]` }));
T(core({ signals: `[{"agentId":"1"},{"agentId":"1"}]` }));
T(core({ signals: `[{"agentId":"01"},{"agentId":"1"}]` }));
T(core({ signals: `[{"agentId":""}]` }));
T(core({ signals: `[{"agentId":"1a"}]` }));
T(core({ signals: `[{"agentId":"1"} ]` }));
T(core({ signals: `[{"agentId":"1"},]` }));
T(core({ signals: `[{"agentId":"1"}{"agentId":"2"}]` }));
T(core({ signals: `[{"agentId":1}]` }));
T(core({ signals: `[{"agentid":"1"}]` }));
T(core({ signals: `[{"agentId":"${"9".repeat(77)}"}]` }));
T(core({ signals: `[{"agentId":"${"9".repeat(78)}"}]` }));
T(core({ signals: `[{"agentId":"${"1".repeat(77)}"},{"agentId":"${"1".repeat(77)}"}]` }));
T(core({ signals: `[${Array.from({ length: 16 }, (_, i) => `{"agentId":"${i}"}`).join(",")}]` }));
T(core({ signals: `[${Array.from({ length: 17 }, (_, i) => `{"agentId":"${i}"}`).join(",")}]` }));
T(core({ signals: `[${Array.from({ length: 17 }, (_, i) => `{"agentId":"${i}"}`).join(",")},garbage]` }));
T(core({ signals: `[${Array.from({ length: 16 }, (_, i) => `{"agentId":"${i}"}`).join(",")},{"bad":1}]` }));
T(core({ signals: `[${Array.from({ length: 15 }, (_, i) => `{"agentId":"${i}"}`).join(",")},{"bad":1}]` }));
T(core({ signals: `[{"agentId":"5","n":{"a":[1,{"b":"]}"}]}},{"agentId":"6"}]` }));
T(core({ signals: `[{"agentId":"5"},{"agentId":"6"}]]` }));
T(core({ signals: `[{"agentId":"5"}],[{"agentId":"6"}]` }));
for (const k of [
  "a".repeat(31),
  "a".repeat(32),
  "a".repeat(33),
  "\u007f",
  "\u0080",
  "a\\\\b",
  'a\\"b',
  "",
  " ",
  "st",
  "stat",
  "statf",
  "state ",
  "statea",
  "t",
  "jobI",
  "jobId ",
  "jobIe",
])
  (T(rec(`"${k}":1,` + core().slice(1, -1))), T(rec(core().slice(1, -1) + `,"${k}":1`)), T(rec(`"${k}":1`)));
T(
  rec(
    `"jobId":"${uuid}","jobId":"${uuid}","kind":"a","objective":"o","schema":"identitymd-work-v1","state":"s"`,
  ),
);
T(rec(`"kind":"a","jobId":"${uuid}","objective":"o","schema":"identitymd-work-v1","state":"s"`));
T(rec(`"jobId":"${uuid}","kind":"a","objective":"o","schema":"identitymd-work-v1","state":"s","state":"t"`));
T(rec(`"jobId":"${uuid}","kind":"a","objective":"o","state":"s"`));
T(rec(`"jobId":"${uuid}","kind":"a","objective":"o","schema":"identitymd-work-v1"`));
T(rec(`"jobId":"${uuid}","kind":"a","objective":"o","schema":"identitymd-work-v1","state":"s"`) + "garbage}");
T(rec(`"jobId":"${uuid}","kind":"a","objective":"o","schema":"identitymd-work-v1","state":"s`));
T(rec(`"jobId":"${uuid}","kind":"a","objective":"o","schema":"identitymd-work-v1","state":"s\\"`));
T(rec(`"a":tru e,` + core().slice(1, -1)));
T(rec(`"a":,` + core().slice(1, -1)));
T(rec(`"a":-1.5E+10,` + core().slice(1, -1)));
T(rec(`"a":nul/,` + core().slice(1, -1)));
T(rec(`"a":1 ,` + core().slice(1, -1)));
T(rec(`"a": 1,` + core().slice(1, -1)));
T(rec(`"a" :1,` + core().slice(1, -1)));
T(rec(`"a":1,,` + core().slice(1, -1)));
T(rec(`"a":[}],` + core().slice(1, -1)));
T(rec(`"a":{]},` + core().slice(1, -1)));
T(rec(`"a":[[[[{"b":"\\\\\\""}]]]],` + core().slice(1, -1)));
T(rec(`"a":"\\\\\\\\",` + core().slice(1, -1)));
T(rec(`"a":"\\\\\\",` + core().slice(1, -1)));
T(rec(`"a":"${"x".repeat(31)}\\"",` + core().slice(1, -1)));
T(rec(`"a":"${"x".repeat(30)}\\\\",` + core().slice(1, -1)));
T(rec(`"a":"${"x".repeat(63)}\\"y",` + core().slice(1, -1)));
T(rec(`"a":"${"\\\\".repeat(40)}",` + core().slice(1, -1)));
T(rec(`"a":"${"\\\\".repeat(40)}\\"",` + core().slice(1, -1)));

const handBefore = cases.length;

// ---- added on 11 Oct 2026, with the rule for rejected submissions and the faster walk over escapes
const el = (id, rest = "") => `{"agentId":"${id}"${rest}}`;
const added = [];
const A = (s, h = 0) => added.push([s, h]);
const sig = (list) => A(core({ signals: `[${list.join(",")}]` }));
// --- a signal that records a rejected submission ends `,"value":0}` and names nobody
sig([el(1, ',"value":0')]);
sig([el(1, ',"value":1')]);
sig([el(1, ',"value":0'), el(2, ',"value":1')]);
sig([el(1, ',"value":1'), el(2, ',"value":0')]);
sig([el(1, ',"value":0'), el(1, ',"value":1')]);
sig([el(1, ',"value":1'), el(1, ',"value":0')]);
sig([el(1, ',"value":00')]);
sig([el(1, ',"value":0 ')]);
sig([el(1, ',"value": 0')]);
sig([el(1, ',"value":-0')]);
sig([el(1, ',"value":10')]);
sig([el(1, ',"value":0.0')]);
sig([el(1, ',"Value":0')]);
sig([el(1, ',"xvalue":0')]);
sig([el(1, ',"x":{"value":0}')]);
sig([el(1, ',"x":[{"value":0}]')]);
sig([el(1, ',"note":",\\"value\\":0}"')]);
sig([el(1, ',"note":"\\\\","value":0')]);
sig([el(1, ',"value":0,"zeta":1')]);
sig([el(1, ',"tag1":"a","value":0')]);
sig([el(0, ',"value":0')]);
sig([el("12345678901", ',"value":0')]);
sig([el("9".repeat(77), ',"value":0')]);
sig([el("9".repeat(78), ',"value":0')]);
sig([`{"agentId":"","value":0}`]);
sig([`{"agentId":"1x","value":0}`]);
sig([`{"agentId":"1""value":0}`]);
sig([el(1, ',"value":0'), "garbage"]);
sig([el(1, ',"value":0'), `{"bad":1}`]);
sig(["garbage", el(1, ',"value":0')]);
sig([
  el(
    52211,
    ',"feedbackHash":"0xab","nodeKey":"impl","submissionHash":"0xcd","tag1":"t","tag2":"u","value":0',
  ),
]);
sig([
  el(
    52211,
    ',"feedbackHash":"0xab","nodeKey":"impl","submissionHash":"0xcd","tag1":"t","tag2":"u","value":1',
  ),
]);
// sixteen accepted after some rejected: the rejected ones do not use up the sixteen places
sig([
  ...[1, 2, 3].map((i) => el(i, ',"value":0')),
  ...Array.from({ length: 16 }, (_, i) => el(100 + i, ',"value":1')),
  "garbage",
]);
sig([...Array.from({ length: 15 }, (_, i) => el(100 + i, ',"value":1')), el(900, ',"value":0'), "garbage"]);
sig([
  ...Array.from({ length: 15 }, (_, i) => el(100 + i, ',"value":1')),
  el(900, ',"value":0'),
  el(901, ',"value":1'),
  "garbage",
]);
sig(Array.from({ length: 20 }, (_, i) => el(100 + i, `,"value":${i % 2}`)));
sig(Array.from({ length: 40 }, (_, i) => el(100 + (i % 7), `,"value":${i % 3 === 0 ? 0 : 1}`)));
// --- strings full of escapes, in a skipped member and in the objective
const filler = (text) => A("{" + `"a":"${text}",` + core().slice(1));
for (const n of [1, 2, 3, 15, 16, 17, 30, 31, 32, 33, 34, 62, 63, 64, 65, 66, 96, 97, 128, 129]) {
  filler("\\".repeat(n));
  filler("x" + "\\".repeat(n));
  filler("\\".repeat(n) + '"');
  filler("\\".repeat(n) + '"y');
}
for (const k of [1, 2, 15, 16, 17, 31, 32, 33, 40, 100]) {
  filler('\\"'.repeat(k));
  filler('\\"x'.repeat(k));
  filler(("\\\\" + '\\"').repeat(k));
  filler('\\"'.repeat(k) + "\\\\");
  A(core({ objective: `"${header}${'\\"'.repeat(k)}"` }), 85);
  A(core({ objective: `"${header}${'q\\"'.repeat(k)}\\n"` }), 85);
}
for (const pad of [0, 1, 2, 29, 30, 31, 32, 33]) {
  filler("p".repeat(pad) + '\\"' + "z".repeat(40));
  filler("p".repeat(pad) + '\\"' + "z".repeat(29) + '\\"' + "w");
  filler("p".repeat(pad) + '\\"' + "z".repeat(30) + '"' + ',"b":"');
  filler("p".repeat(pad) + '\\\\"' + "z".repeat(30));
}
for (const [text, head] of added) push(text, head);
const handWritten = cases.length;

// random mutations
for (let i = 0; i < 5200; i++) {
  const base = enc.encode(bases[ri(bases.length)]);
  push(mutate(base), [0, 85, 85, 85, 12, 99, 1000][ri(7)]);
}
for (let i = 0; i < 500; i++) push(mutate(real[ri(real.length)]), [0, 85, 5000][ri(3)]);

const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
writeFileSync(
  join(OUT, "cases.json"),
  JSON.stringify({ cases: cases.map(hex), heads, handWritten, mutatedSmall: 5200, mutatedReal: 500 }),
);
console.log(
  "cases",
  cases.length,
  "hand-written",
  handWritten,
  "of which added later",
  handWritten - handBefore,
);
