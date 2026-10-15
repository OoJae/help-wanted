import { describe, expect, it } from "vitest";
import {
  FUND_FEEDS_GAS_FLOOR,
  SLOT_HOLD_SECONDS,
  answerProblems,
  decideQuestions,
  slotHold,
  slotStart,
  verdictOf,
  type QuestionsSnapshot,
} from "../src/modules/questions.js";
import {
  BLOCK,
  FEED_ID,
  IMD,
  KEEPER,
  NOW,
  PAYROLL,
  QUESTIONS,
  REQUESTED_AT,
  SILENCE,
  completing,
  dueFeed,
  feed,
  message,
  pendingAt,
  pendingFeed,
  policy,
  questions,
  round,
  seen,
  signed,
} from "./factories.js";

const kinds = (snapshot: QuestionsSnapshot, p = policy()) =>
  decideQuestions(snapshot, p).actions.map((a) => `${a.kind}:${a.subject}`);
const waits = (snapshot: QuestionsSnapshot, p = policy()) => decideQuestions(snapshot, p).waiting;

describe("asking", () => {
  it("does nothing for a feed that is not due, and says when it will be", () => {
    const decision = decideQuestions(questions(), policy());
    expect(decision.actions).toEqual([]);
    expect(decision.waiting).toHaveLength(1);
    expect(decision.waiting[0]?.reason).toContain(`block ${BLOCK + 6_950n}`);
    // 6,950 blocks at twelve seconds.
    expect(decision.waiting[0]?.until).toBe(Number(NOW + 6_950n * 12n));
  });

  it("asks when canRequest says yes and the meter covers it, in a call to Questions.request", () => {
    const decision = decideQuestions(questions({ feeds: [dueFeed()] }), policy());
    expect(decision.actions).toHaveLength(1);
    const action = decision.actions[0];
    expect(action?.kind).toBe("request");
    expect(action?.call).toMatchObject({ address: QUESTIONS, functionName: "request", args: [FEED_ID] });
    expect(action?.reason).toContain("canRequest allows it");
    expect(decision.waiting).toEqual([]);
  });

  it("asks each due feed in its own action, in the order the feeds are kept", () => {
    const feeds = [
      dueFeed({ name: "payrolls", feedId: `0x${"01".repeat(32)}` }),
      dueFeed({ name: "hires", feedId: `0x${"02".repeat(32)}` }),
      feed({ name: "employers", feedId: `0x${"03".repeat(32)}` }),
    ];
    const decision = decideQuestions(questions({ feeds }), policy());
    expect(decision.actions.map((a) => a.label)).toEqual(["request payrolls", "request hires"]);
    // One feed per call: nothing batches two requests into one transaction.
    for (const action of decision.actions) expect(action.call.args).toHaveLength(1);
    expect(new Set(decision.actions.map((a) => JSON.stringify(a.call.args))).size).toBe(2);
  });

  it("does not ask when the contract says yes but the meter does not cover the cost", () => {
    const snapshot = questions({ feeds: [dueFeed({ meterBalance: IMD(0.55) - 1n })] });
    expect(kinds(snapshot)).toEqual([]);
    expect(waits(snapshot)[0]).toMatchObject({ attention: true });
    // Exactly the cost is enough.
    expect(kinds(questions({ feeds: [dueFeed({ meterBalance: IMD(0.55) })] }))).toEqual(["request:hires"]);
    // A cost of zero means no request can be bought at all.
    expect(kinds(questions({ feeds: [dueFeed({ cost: 0n })] }))).toEqual([]);
  });

  it("tops the meter up from Payroll first when the meter is too low and Payroll has budget for it", () => {
    const low = feed({
      meterBalance: IMD(0.3),
      canRequest: { ok: false, why: 9, price: IMD(0.5), fromBlock: 1n, toBlock: 2n },
      payrollTopUp: IMD(7.4),
    });
    const decision = decideQuestions(questions({ feeds: [low] }), policy());
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]?.call).toMatchObject({
      address: PAYROLL,
      functionName: "fundFeeds",
      args: [],
    });
    expect(decision.actions[0]?.gasFloor).toBe(FUND_FEEDS_GAS_FLOOR);
    expect(decision.actions[0]?.reason).toContain("less than a request costs");
    expect(decision.waiting[0]?.reason).toContain("the request follows");
  });

  it("does not call Payroll for a top-up that would still leave the meter short of one request", () => {
    const low = { canRequest: { ok: false, why: 9, price: IMD(0.5), fromBlock: 1n, toBlock: 2n } };
    // 0.3 on the meter, 0.25 on offer: exactly the 0.55 a request costs.
    const enough = questions({ feeds: [feed({ ...low, meterBalance: IMD(0.3), payrollTopUp: IMD(0.25) })] });
    expect(kinds(enough)).toEqual(["fundFeeds:hires"]);
    // One wei less on offer: the request would still be refused, so the call is not made.
    const short = questions({
      feeds: [feed({ ...low, meterBalance: IMD(0.3), payrollTopUp: IMD(0.25) - 1n })],
    });
    expect(kinds(short)).toEqual([]);
    expect(waits(short)[0]).toMatchObject({ attention: true });
  });

  it("asks for the meter to be funded when it is too low and Payroll cannot help", () => {
    const low = {
      meterBalance: IMD(0.3),
      canRequest: { ok: false, why: 9, price: IMD(0.5), fromBlock: 1n, toBlock: 2n },
    };
    for (const snapshot of [
      questions({ feeds: [feed({ ...low, payrollTopUp: 0n })] }), // Payroll has no budget
      questions({ feeds: [feed({ ...low, payrollTopUp: null })] }), // not one of Payroll's feeds
      questions({ payroll: null, feeds: [feed({ ...low, payrollTopUp: IMD(7) })] }), // Payroll not configured
    ]) {
      const decision = decideQuestions(snapshot, policy());
      expect(decision.actions).toEqual([]);
      expect(decision.waiting[0]).toMatchObject({ attention: true });
      expect(decision.waiting[0]?.reason).toContain("fund the meter");
    }
  });

  it("names what else stands in the way of a request, and asks for attention where an operator must act", () => {
    const blocked = (why: number) =>
      waits(
        questions({
          feeds: [feed({ canRequest: { ok: false, why, price: IMD(3), fromBlock: 0n, toBlock: 0n } })],
        }),
      )[0];
    expect(blocked(8)).toMatchObject({ attention: true });
    expect(blocked(8)?.reason).toContain("above the feed's cap");
    expect(blocked(7)).toMatchObject({ attention: true });
    expect(blocked(5)?.reason).toBe("canRequest says no: NoBlocks");
    expect(blocked(5)?.attention).toBeUndefined();
    expect(blocked(6)?.reason).toBe("canRequest says no: GateClosed");
    const missing = decideQuestions(questions({ feeds: [feed({ exists: false })] }), policy());
    expect(missing.actions).toEqual([]);
    expect(missing.waiting[0]?.reason).toContain("first-day");
  });

  it("says how failed rounds have lengthened the wait", () => {
    const wait = waits(questions({ feeds: [feed({ failStreak: 2 })] }))[0];
    expect(wait?.reason).toContain("2 failed rounds in a row");
  });
});

describe("asking at a time of day", () => {
  // 14:00 UTC. NOW is 2026-10-13 14:00:00 UTC.
  const at = 14 * 3600;
  const slot = NOW;
  const timed = policy({ requestAtUtc: at });

  it("finds the start of the slot a time falls in", () => {
    expect(slotStart(NOW, at)).toBe(NOW);
    expect(slotStart(NOW - 1n, at)).toBe(NOW - 86_400n);
    expect(slotStart(NOW + 86_399n, at)).toBe(NOW);
    expect(slotStart(NOW + 86_400n, at)).toBe(NOW + 86_400n);
    expect(slotStart(NOW, 0)).toBe(NOW - 14n * 3600n);
  });

  it("holds a feed that comes due before the slot: one second before it does not ask, at it it does", () => {
    // Asked yesterday at 14:00; due again since 13:20 today (23 h 20 min later).
    const asked = slot - 86_400n;
    const before = questions({ now: slot - 1n, feeds: [dueFeed({ lastRequestedAt: asked })] });
    expect(kinds(before, timed)).toEqual([]);
    expect(waits(before, timed)[0]?.until).toBe(Number(slot));
    const onTime = questions({ now: slot, feeds: [dueFeed({ lastRequestedAt: asked })] });
    expect(kinds(onTime, timed)).toEqual(["request:hires"]);
    // With no time of day set it is asked the moment it is due.
    expect(kinds(before)).toEqual(["request:hires"]);
  });

  it("asks once per slot: a feed asked exactly at the slot's start waits for the next one", () => {
    const again = questions({ now: slot + 80_000n, feeds: [dueFeed({ lastRequestedAt: slot })] });
    expect(kinds(again, timed)).toEqual([]);
    expect(waits(again, timed)[0]?.until).toBe(Number(slot + 86_400n));
    // Asked one second before the slot started, it belongs to the slot before.
    const earlier = questions({ now: slot + 80_000n, feeds: [dueFeed({ lastRequestedAt: slot - 1n })] });
    expect(kinds(earlier, timed)).toEqual(["request:hires"]);
  });

  it("holds a feed that comes due within ninety minutes before the slot, and not one second earlier than that", () => {
    expect(SLOT_HOLD_SECONDS).toBe(5_400n);
    // First asked at 13:50, ten minutes before the slot: due at 13:10 the next day, fifty minutes
    // before it. Held, so that from the second day on the feed is asked at 14:00.
    const firstDay = slot - 86_400n - 600n;
    const held = questions({ now: slot - 3_000n, feeds: [dueFeed({ lastRequestedAt: firstDay })] });
    expect(kinds(held, timed)).toEqual([]);
    expect(waits(held, timed)[0]).toMatchObject({ until: Number(slot) });
    expect(waits(held, timed)[0]?.reason).toContain("shortly before the daily slot");
    // Exactly ninety minutes before: held. One second more than that: asked now.
    const edge = questions({ now: slot - 5_400n, feeds: [dueFeed({ lastRequestedAt: firstDay })] });
    expect(kinds(edge, timed)).toEqual([]);
    const outside = questions({ now: slot - 5_401n, feeds: [dueFeed({ lastRequestedAt: firstDay })] });
    expect(kinds(outside, timed)).toEqual(["request:hires"]);
    expect(slotHold(slot - 5_401n, firstDay, at)).toBeNull();
  });

  it("asks a feed that is late for its slot at once: a late day is not made later", () => {
    // Asked yesterday at 16:00, so due at 15:20 today, well inside today's slot.
    const late = questions({
      now: slot + 4_800n,
      feeds: [dueFeed({ lastRequestedAt: slot - 86_400n + 7_200n })],
    });
    expect(kinds(late, timed)).toEqual(["request:hires"]);
  });

  it("asks a feed that has never been asked at once, whatever the time", () => {
    const fresh = questions({
      now: slot - 1n,
      feeds: [dueFeed({ rounds: 0n, latestRound: 0n, lastRequestedAt: 0n })],
    });
    expect(kinds(fresh, timed)).toEqual(["request:hires"]);
  });

  it("never asks a feed the contract says is not due, slot or no slot", () => {
    expect(kinds(questions({ now: slot }), timed)).toEqual([]);
  });
});

describe("handing an answer in", () => {
  const answer = signed();
  const open = { canSubmit: true, service: completing(answer) };

  it("does not hand it in one second before submit opens, and does at the second it opens", () => {
    // The contract opens submit thirty minutes after a request the Intake has not completed.
    const early = pendingAt(1_799n, { canSubmit: false, service: completing(answer) });
    expect(kinds(early)).toEqual([]);
    expect(waits(early)[0]?.until).toBe(Number(REQUESTED_AT + 1_800n));
    expect(waits(early)[0]?.reason).toContain("the signed answer is in hand");

    const decision = decideQuestions(pendingAt(1_800n, open), policy());
    expect(decision.actions).toHaveLength(1);
    const action = decision.actions[0];
    expect(action?.kind).toBe("submit");
    expect(action?.call).toMatchObject({ address: QUESTIONS, functionName: "submit" });
    expect(action?.call.args).toEqual([FEED_ID, answer.message, answer.signature]);
    expect(action?.reason).toContain("the Intake has not delivered");
  });

  it("hands it in at once when the Intake has completed the request and nothing was stored", () => {
    // The callback failed: no half hour to wait.
    const decision = decideQuestions(
      pendingAt(90n, { canSubmit: true, intakeCompleted: true, abandonStep: 1, service: completing(answer) }),
      policy(),
    );
    expect(decision.actions.map((a) => a.kind)).toEqual(["submit"]);
    expect(decision.actions[0]?.reason).toContain("the Intake completed the request");
  });

  it("prefers answering a round to closing it, even when closing is possible", () => {
    // Closable the short way: the Intake completed the request (its callback failed) and the
    // thirty minutes after that was seen are over. The answer is still good.
    const closable = pendingAt(5_400n, { ...open, intakeCompleted: true, abandonStep: 2 });
    expect(kinds(closable)).toEqual(["submit:hires"]);
    expect(kinds(closable, policy({ closeRoundsInProgress: true }))).toEqual(["submit:hires"]);
    // Closable the long way: the silence deadline has passed, and the oracle signed later than
    // the twelve hours the deadline allows it, so its answer is still valid.
    const late = signed({}, { issuedAt: REQUESTED_AT + 50_000n, expiresAt: REQUESTED_AT + 136_400n });
    const afterSilence = pendingAt(SILENCE, { canSubmit: true, abandonStep: 2, service: completing(late) });
    expect(kinds(afterSilence)).toEqual(["submit:hires"]);
    expect(kinds(afterSilence, policy({ closeRoundsInProgress: true }))).toEqual(["submit:hires"]);
  });

  it("at the silence deadline every answer signed within the twelve hours has expired", () => {
    // The deadline is twelve hours to sign, the answer's whole validity, the clock tolerance and a
    // second: an answer signed at the last allowed moment is no longer storable when it comes.
    const lastMoment = signed({}, { issuedAt: REQUESTED_AT + 43_200n, expiresAt: REQUESTED_AT + 129_600n });
    const snapshot = pendingAt(SILENCE, { canSubmit: true, abandonStep: 2, service: completing(lastMoment) });
    expect(kinds(snapshot)).toEqual([]);
    expect(waits(snapshot)[0]?.reason).toContain("cannot be stored");
    expect(kinds(snapshot, policy({ closeRoundsInProgress: true }))).toEqual(["abandon:hires"]);
  });

  it("does not close a round at twelve hours any more: the contract's deadline is the later one", () => {
    const unseen = {
      kind: "unseen",
      detail: "IdentityMD's service has not seen the transaction that made the request",
    } as const;
    // Twelve hours after the request the contract says wait, and so does the keeper's own count.
    const atTwelve = pendingAt(43_200n, { abandonStep: 0, service: unseen });
    expect(kinds(atTwelve)).toEqual([]);
    expect(waits(atTwelve)[0]?.until).toBe(Number(REQUESTED_AT + SILENCE));
    expect(waits(atTwelve)[0]?.reason).toContain("36 hours and 5 minutes after its request");
    // Even if a contract said closable at twelve hours, the keeper's own count would hold it.
    expect(kinds(pendingAt(43_200n, { abandonStep: 2, service: unseen }))).toEqual([]);
    expect(
      kinds(
        pendingAt(43_200n, { abandonStep: 2, service: completing() }),
        policy({ closeRoundsInProgress: true }),
      ),
    ).toEqual([]);
  });

  it("sends nothing when the contract and the keeper's reading of its rule disagree", () => {
    // By the rule submit is open; the contract says it is not.
    const one = decideQuestions(
      pendingAt(1_800n, { canSubmit: false, service: completing(answer) }),
      policy(),
    );
    expect(one.actions).toEqual([]);
    expect(one.waiting[0]).toMatchObject({ attention: true });
    expect(one.waiting[0]?.reason).toContain("nothing is sent");
    // The contract says open before the rule does.
    const two = decideQuestions(pendingAt(1_799n, open), policy());
    expect(two.actions).toEqual([]);
    expect(two.waiting[0]).toMatchObject({ attention: true });
  });

  it("never hands an answer in to a feed that submit is closed to", () => {
    // A panel-judged feed: only the Intake's callback can answer it.
    const snapshot = pendingAt(
      7_200n,
      { canSubmit: false, service: completing(answer) },
      { submitAllowed: false },
    );
    expect(kinds(snapshot)).toEqual([]);
    expect(waits(snapshot)[0]?.reason).toContain("only the Intake's callback can answer this feed");
  });

  it("waits when submit is open and no signed answer is served yet", () => {
    const snapshot = pendingAt(2_400n, { canSubmit: true, service: seen({ state: "admitted" }) });
    expect(kinds(snapshot)).toEqual([]);
    expect(waits(snapshot)[0]?.reason).toContain("no signed answer for this contract is served yet");
  });

  describe("only an answer the contract would accept", () => {
    const base = pendingAt(1_800n, open);
    const problems = (answerOver = {}, messageOver = {}, snapshot = base) => {
      const f = snapshot.feeds[0];
      if (!f?.pending || !f.rules) throw new Error("unreachable");
      return answerProblems(signed(answerOver, messageOver), f.pending, f.rules, snapshot, policy());
    };
    const refused = (answerOver = {}, messageOver = {}) => {
      const snapshot = pendingAt(1_800n, {
        canSubmit: true,
        service: completing(signed(answerOver, messageOver)),
      });
      return decideQuestions(snapshot, policy());
    };

    it("accepts the answer the round asked for", () => {
      expect(problems()).toEqual({ permanent: [], transient: [] });
    });

    it.each([
      [
        "signed for another contract",
        { signedFor: { chainId: 1, verifyingContract: PAYROLL } },
        {},
        "not for this contract",
      ],
      [
        "signed for another chain",
        { signedFor: { chainId: 4663, verifyingContract: QUESTIONS } },
        {},
        "not for this contract",
      ],
      ["signed by somebody else", { recoveredSigner: KEEPER }, {}, "not the oracle signer"],
      ["with a signature that recovers nobody", { recoveredSigner: null }, {}, "recovers nobody"],
      ["about another chain", {}, { chainId: 4663n }, "about chain 4663"],
      ["to another question", {}, { questionHash: `0x${"99".repeat(32)}` }, "question hash"],
      ["about another window", {}, { toBlock: BLOCK - 100n }, "window"],
      ["starting at another block", {}, { fromBlock: BLOCK - 7_099n }, "window"],
      ["of another type", {}, { answerType: 0 }, "answer type"],
      ["from a smaller panel", {}, { panelSize: 6 }, "panel"],
      ["with a lower quorum", {}, { quorum: 4, agreed: 4 }, "quorum"],
      ["with fewer agreeing than its own quorum", {}, { agreed: 4 }, "4 members agreed and the feed needs 5"],
      ["with another closing block hash", {}, { blockHash: `0x${"77".repeat(32)}` }, "closing block hash"],
      ["that is not one word", {}, { answer: "0x1234" }, "one 32-byte word"],
    ] as const)("refuses one %s", (_name, answerOver, messageOver, said) => {
      const found = problems(answerOver, messageOver);
      expect(found.permanent.join(" | ")).toContain(said);
      const decision = refused(answerOver, messageOver);
      expect(decision.actions).toEqual([]);
      expect(decision.waiting[0]?.reason).toContain("cannot be stored");
    });

    it("takes the panel's own agreement only: a larger quorum signed with the answer raises the bar", () => {
      // The feed's minAgreed equals its quorum, so the attestation's own quorum is what counts.
      expect(problems({}, { panelSize: 100, quorum: 67, agreed: 66 }).permanent.join()).toContain("needs 67");
      expect(problems({}, { panelSize: 100, quorum: 67, agreed: 67 }).permanent).toEqual([]);
    });

    it("lets a feed that set a lower floor take an answer the oracle's rerun settled", () => {
      const snapshot = pendingAt(1_800n, open, {
        rules: { chainId: 1n, answerType: 3, panelSize: 7, quorum: 5, minAgreed: 3 },
      });
      expect(problems({}, { agreed: 3 }, snapshot).permanent).toEqual([]);
      expect(problems({}, { agreed: 2 }, snapshot).permanent.join()).toContain("needs 3");
    });

    it("does not check the closing block hash when the round could not store one", () => {
      const snapshot = pendingAt(1_800n, { ...open, blockHash: `0x${"00".repeat(32)}` });
      expect(problems({}, { blockHash: `0x${"77".repeat(32)}` }, snapshot).permanent).toEqual([]);
    });

    it("hands in an answer with exactly the margin left before it expires, and not one second later", () => {
      // The contract refuses once block.timestamp is past expiresAt; the margin covers mining.
      const expiresAt = REQUESTED_AT + 1_800n + 120n;
      const atMargin = pendingAt(1_800n, { canSubmit: true, service: completing(signed({}, { expiresAt })) });
      expect(kinds(atMargin)).toEqual(["submit:hires"]);
      const late = pendingAt(1_801n, { canSubmit: true, service: completing(signed({}, { expiresAt })) });
      expect(kinds(late)).toEqual([]);
      expect(waits(late)[0]?.reason).toContain("too close to hand in");
      // With no margin it is handed in up to the last second.
      expect(kinds(late, policy({ expiryMarginSeconds: 0 }))).toEqual(["submit:hires"]);
    });

    it("waits for an answer issued further ahead of the chain's clock than the contract tolerates", () => {
      // `issuedAt > block.timestamp + 5 minutes` reverts.
      const now = REQUESTED_AT + 1_800n;
      const within = pendingAt(1_800n, {
        canSubmit: true,
        service: completing(signed({}, { issuedAt: now + 300n })),
      });
      expect(kinds(within)).toEqual(["submit:hires"]);
      const ahead = pendingAt(1_800n, {
        canSubmit: true,
        service: completing(signed({}, { issuedAt: now + 301n })),
      });
      expect(kinds(ahead)).toEqual([]);
      // That passes with time, so the round is not written off.
      expect(
        verdictOf(ahead.feeds[0] as never, round(ahead.feeds[0]?.pending ?? {}), ahead, policy()).kind,
      ).toBe("coming");
    });
  });
});

describe("closing a round", () => {
  const answer = signed();

  describe("the service shows the request as completing", () => {
    it("never closes it before the silence deadline, and not at it either unless configured to", () => {
      // A panel-judged feed whose answer is signed and whose callback has not come.
      const feedOver = { submitAllowed: false };
      const before = pendingAt(SILENCE - 1n, { abandonStep: 0, service: completing() }, feedOver);
      expect(kinds(before)).toEqual([]);
      expect(kinds(before, policy({ closeRoundsInProgress: true }))).toEqual([]);

      const at = pendingAt(SILENCE, { abandonStep: 2, service: completing() }, feedOver);
      const held = decideQuestions(at, policy());
      expect(held.actions).toEqual([]);
      expect(held.waiting[0]).toMatchObject({ attention: true });
      expect(held.waiting[0]?.reason).toContain("the keeper is not closing it");
      expect(held.waiting[0]?.reason).toContain("completing");

      const told = decideQuestions(at, policy({ closeRoundsInProgress: true }));
      expect(told.actions.map((a) => a.kind)).toEqual(["abandon"]);
      expect(told.actions[0]?.call).toMatchObject({
        address: QUESTIONS,
        functionName: "abandon",
        args: [FEED_ID],
      });
      expect(told.actions[0]?.reason).toContain("CLOSE_ROUNDS_IN_PROGRESS is set");
    });

    it("holds for every state that is not final: received, paid, admitted, completing, completed", () => {
      for (const state of ["received", "paid", "admitted", "completing", "completed", "something-new"]) {
        const snapshot = pendingAt(
          SILENCE + 6_800n,
          { abandonStep: 2, service: seen({ state }) },
          { submitAllowed: false },
        );
        expect(kinds(snapshot), state).toEqual([]);
        expect(kinds(snapshot, policy({ closeRoundsInProgress: true })), state).toEqual(["abandon:hires"]);
      }
    });

    it("does not close on the keeper's own clock: the contract must say the round is closable", () => {
      // Past the silence deadline by the keeper's arithmetic, and the contract still says wait.
      const snapshot = pendingAt(
        SILENCE,
        { abandonStep: 0, service: completing() },
        { submitAllowed: false },
      );
      expect(kinds(snapshot, policy({ closeRoundsInProgress: true }))).toEqual([]);
    });
  });

  describe("the service cannot be read", () => {
    const blind = { kind: "unreachable", detail: "IdentityMD's service could not be read (503)" } as const;

    it("does not close a round blind, and says so", () => {
      const snapshot = pendingAt(SILENCE + 6_800n, { abandonStep: 2, service: blind });
      const decision = decideQuestions(snapshot, policy());
      expect(decision.actions).toEqual([]);
      expect(decision.waiting[0]).toMatchObject({ attention: true });
      expect(decision.waiting[0]?.reason).toContain("could not be read");
      // The operator's switch covers it once the silence deadline has passed.
      expect(kinds(snapshot, policy({ closeRoundsInProgress: true }))).toEqual(["abandon:hires"]);
      expect(
        kinds(
          pendingAt(SILENCE - 1n, { abandonStep: 0, service: blind }),
          policy({ closeRoundsInProgress: true }),
        ),
      ).toEqual([]);
    });

    it("does not start the thirty minutes on a completed request it cannot explain", () => {
      const snapshot = pendingAt(600n, {
        intakeCompleted: true,
        canSubmit: true,
        abandonStep: 1,
        service: blind,
      });
      expect(kinds(snapshot)).toEqual([]);
      expect(waits(snapshot)[0]?.reason).toContain("a round is not closed blind");
    });

    it("still knows a panel feed's round is lost once the Intake has completed it", () => {
      // Only the Intake delivers to such a feed, it delivers once, and it has: the chain says so.
      const snapshot = pendingAt(
        600n,
        { intakeCompleted: true, abandonStep: 1, service: blind },
        { submitAllowed: false },
      );
      expect(kinds(snapshot)).toEqual(["abandon-start:hires"]);
    });
  });

  describe("the service never saw the request", () => {
    const unseen = {
      kind: "unseen",
      detail: "IdentityMD's service has not seen the transaction that made the request",
    } as const;

    it("closes it at the silence deadline, not one second before", () => {
      const before = pendingAt(SILENCE - 1n, { abandonStep: 0, service: unseen });
      expect(kinds(before)).toEqual([]);
      expect(waits(before)[0]?.until).toBe(Number(REQUESTED_AT + SILENCE));
      const at = decideQuestions(pendingAt(SILENCE, { abandonStep: 2, service: unseen }), policy());
      expect(at.actions.map((a) => a.kind)).toEqual(["abandon"]);
      expect(at.actions[0]?.reason).toContain(
        "the silence deadline (36 hours and 5 minutes after the request) has passed",
      );
    });

    it("needs both the contract's word and its own count of the silence deadline", () => {
      // The contract says closable ten minutes after the request, with the Intake's request not
      // completed: neither rule explains that, so nothing is sent.
      expect(kinds(pendingAt(600n, { abandonStep: 2, service: unseen }))).toEqual([]);
      // Past the deadline by the keeper's count, and the contract says wait: nothing is sent either.
      expect(kinds(pendingAt(SILENCE, { abandonStep: 0, service: unseen }))).toEqual([]);
    });

    it("says an unserved round of a submit feed can be rescued, and asks for attention once submit is open", () => {
      const early = waits(pendingAt(600n, { service: unseen }))[0];
      expect(early?.attention).toBe(false);
      const open = waits(pendingAt(1_800n, { canSubmit: true, service: unseen }))[0];
      expect(open?.attention).toBe(true);
      expect(open?.reason).toContain("the keeper does not buy answers");
    });
  });

  describe("the request ended without an answer", () => {
    const refused = seen({ state: "refused", reason: "body_refused", completionStatus: 1 });

    it("waits while the contract allows nothing, and names when it will", () => {
      // Refused on the plane; the writer has not written it, so only the silence deadline can close it.
      const decision = decideQuestions(pendingAt(3_600n, { abandonStep: 0, service: refused }), policy());
      expect(decision.actions).toEqual([]);
      expect(decision.waiting[0]?.reason).toContain("refused");
      expect(decision.waiting[0]?.until).toBe(Number(REQUESTED_AT + SILENCE));
    });

    it("makes the first call, which only starts thirty minutes, when the Intake has completed it", () => {
      const snapshot = pendingAt(3_600n, {
        intakeCompleted: true,
        canSubmit: true,
        abandonStep: 1,
        service: refused,
      });
      const decision = decideQuestions(snapshot, policy());
      expect(decision.actions.map((a) => a.kind)).toEqual(["abandon-start"]);
      expect(decision.actions[0]?.label).toContain("start the wait");
      expect(decision.actions[0]?.reason).toContain("body_refused");
    });

    it("makes the second call at the second the round becomes closable, not one second before", () => {
      const closableAt = REQUESTED_AT + 3_600n + 1_800n;
      const seenAlready = { intakeCompleted: true, canSubmit: true, closableAt, service: refused };
      const before = pendingAt(5_399n, { ...seenAlready, abandonStep: 0 });
      expect(kinds(before)).toEqual([]);
      expect(waits(before)[0]?.until).toBe(Number(closableAt));
      const at = pendingAt(5_400n, { ...seenAlready, abandonStep: 2 });
      expect(kinds(at)).toEqual(["abandon:hires"]);
    });

    it("closes a refused request the writer never wrote at the silence deadline", () => {
      expect(kinds(pendingAt(SILENCE - 1n, { abandonStep: 0, service: refused }))).toEqual([]);
      expect(kinds(pendingAt(SILENCE, { abandonStep: 2, service: refused }))).toEqual(["abandon:hires"]);
    });

    it("counts a panel that did not agree, and a failed request, the same way", () => {
      for (const service of [
        seen({
          state: "failed",
          completionStatus: 2,
          failure: "disagreed: the panel did not reach the quorum",
        }),
        seen({ state: "completed", completionStatus: 2 }),
      ]) {
        const snapshot = pendingAt(3_600n, {
          intakeCompleted: true,
          canSubmit: true,
          abandonStep: 1,
          service,
        });
        expect(kinds(snapshot)).toEqual(["abandon-start:hires"]);
      }
      const why = decideQuestions(
        pendingAt(3_600n, {
          intakeCompleted: true,
          canSubmit: true,
          abandonStep: 1,
          service: seen({
            state: "failed",
            completionStatus: 2,
            failure: "disagreed: the panel did not reach the quorum",
          }),
        }),
        policy(),
      ).actions[0]?.reason;
      expect(why).toContain("disagreed");
    });

    it("closes a round whose completed request left an answer that cannot be stored", () => {
      const forOther = signed({ signedFor: { chainId: 1, verifyingContract: PAYROLL } });
      const snapshot = pendingAt(600n, {
        intakeCompleted: true,
        canSubmit: true,
        abandonStep: 1,
        service: seen({ state: "completed", completionStatus: 0, delivered: false, answer: forOther }),
      });
      const decision = decideQuestions(snapshot, policy());
      expect(decision.actions.map((a) => a.kind)).toEqual(["abandon-start"]);
      expect(decision.actions[0]?.reason).toContain("not for this contract");
    });

    it("does not start the wait while a completed request's answer is unread", () => {
      const snapshot = pendingAt(600n, {
        intakeCompleted: true,
        canSubmit: true,
        abandonStep: 1,
        service: seen({
          state: "completed",
          completionStatus: 0,
          answer: { kind: "unreadable", detail: "timeout" },
        }),
      });
      expect(kinds(snapshot)).toEqual([]);
      expect(waits(snapshot)[0]?.attention).toBe(true);
    });
  });

  it("an answer in hand beats a closing that somebody else started", () => {
    // The thirty minutes after a seen completion are there so the answer can still be handed in.
    const snapshot = pendingAt(4_000n, {
      intakeCompleted: true,
      canSubmit: true,
      abandonStep: 2,
      service: seen({ state: "completed", completionStatus: 0, delivered: false, answer }),
    });
    expect(kinds(snapshot)).toEqual(["submit:hires"]);
  });
});

describe("which of the five things is true of a pending round", () => {
  const of = (roundOver = {}, feedOver = {}, age = 600n) => {
    const snapshot = pendingAt(age, roundOver, feedOver);
    const f = snapshot.feeds[0];
    if (!f?.pending) throw new Error("unreachable");
    return verdictOf(f, f.pending, snapshot, policy()).kind;
  };

  it("answer: a usable signed answer for a feed submit is open to", () => {
    expect(of({ service: completing(signed()) })).toBe("answer");
    expect(of({ service: completing(signed()) }, { submitAllowed: false })).toBe("coming");
  });

  it("coming: anything the service has not finished", () => {
    expect(of({ service: seen({ state: "received" }) })).toBe("coming");
    expect(of({ service: completing() })).toBe("coming");
    // The plane says completed and this block of the chain does not: the node is a block behind.
    expect(of({ service: seen({ state: "completed", completionStatus: 0, delivered: true }) })).toBe(
      "coming",
    );
  });

  it("none: a final refusal or failure, or a completed request nothing can answer any more", () => {
    expect(of({ service: seen({ state: "refused" }) })).toBe("none");
    expect(of({ service: seen({ state: "failed" }) })).toBe("none");
    expect(of({ intakeCompleted: true, service: completing() }, { submitAllowed: false })).toBe("none");
    expect(of({ intakeCompleted: true, service: seen({ state: "completed", completionStatus: 1 }) })).toBe(
      "none",
    );
  });

  it("unseen and unknown: the service does not know, or cannot be asked", () => {
    expect(of({ service: { kind: "unseen", detail: "" } })).toBe("unseen");
    expect(of({ service: { kind: "unreachable", detail: "" } })).toBe("unknown");
    // The chain says completed and the service lists nothing: that does not add up.
    expect(of({ intakeCompleted: true, service: { kind: "unseen", detail: "" } })).toBe("unknown");
    expect(of({ intakeCompleted: true, service: seen({ state: "completed", completionStatus: 0 }) })).toBe(
      "unknown",
    );
  });
});

describe("tips", () => {
  it("collects at the threshold and not one wei below it", () => {
    const below = questions({ tips: { earned: IMD(0.5) - 1n, pending: IMD(0.1) } });
    expect(kinds(below)).toEqual([]);
    const at = decideQuestions(questions({ tips: { earned: IMD(0.5), pending: 0n } }), policy());
    expect(at.actions.map((a) => a.kind)).toEqual(["collectTips"]);
    expect(at.actions[0]?.call).toMatchObject({ address: QUESTIONS, functionName: "collectTips", args: [] });
  });

  it("never counts tips set aside for rounds that are still pending", () => {
    expect(kinds(questions({ tips: { earned: 0n, pending: IMD(5) } }))).toEqual([]);
  });

  it("sends nothing for nothing, even with a threshold of zero, and nothing with no keeper address", () => {
    expect(kinds(questions({ tips: { earned: 0n, pending: 0n } }), policy({ tipCollectMin: 0n }))).toEqual(
      [],
    );
    expect(kinds(questions({ tips: { earned: 1n, pending: 0n } }), policy({ tipCollectMin: 0n }))).toEqual([
      "collectTips:tips",
    ]);
    expect(kinds(questions({ tips: null, keeper: null }))).toEqual([]);
  });
});

describe("the order of what is sent", () => {
  it("tops up first, then answers, then closings, then requests, then tips", () => {
    const id = (byte: string) => `0x${byte.repeat(32)}` as const;
    const feeds = [
      dueFeed({ name: "payrolls", feedId: id("01") }),
      pendingFeed(
        {
          intakeCompleted: true,
          canSubmit: true,
          abandonStep: 1,
          service: seen({ state: "refused", completionStatus: 1 }),
        },
        { name: "hires", feedId: id("02") },
      ),
      pendingFeed({ canSubmit: true, service: completing(signed()) }, { name: "extra", feedId: id("03") }),
      feed({
        name: "low",
        feedId: id("04"),
        canRequest: { ok: false, why: 9, price: IMD(0.5), fromBlock: 1n, toBlock: 2n },
        payrollTopUp: IMD(7),
      }),
    ];
    const snapshot = questions({ now: REQUESTED_AT + 1_800n, feeds, tips: { earned: IMD(1), pending: 0n } });
    expect(decideQuestions(snapshot, policy()).actions.map((a) => `${a.kind}:${a.subject}`)).toEqual([
      "fundFeeds:low",
      "submit:extra",
      "abandon-start:hires",
      "request:payrolls",
      "collectTips:tips",
    ]);
  });

  it("is a pure function: the same state gives the same decision, and the state is not touched", () => {
    const snapshot = pendingAt(1_800n, { canSubmit: true, service: completing(signed({}, message())) });
    const copy = structuredClone(snapshot);
    const one = decideQuestions(snapshot, policy());
    const two = decideQuestions(snapshot, policy());
    expect(one).toEqual(two);
    expect(snapshot).toEqual(copy);
  });
});
