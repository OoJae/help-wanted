/**
 * A spec problem in the words a form shows. The rule itself (`checkSpec`) and its problem codes are
 * the shared package's, which mirrors the desk's `SpecText`; only the sentences are this site's.
 */
import { SPEC_MAX_BYTES, type SpecProblem } from "@help-wanted/shared";

export function specProblemWords(problem: SpecProblem): string {
  switch (problem.code) {
    case "empty":
      return "The job text is empty.";
    case "too_long":
      return `The job text is ${problem.bytes} bytes; the limit is ${SPEC_MAX_BYTES}.`;
    case "leading_space":
      return "The job text starts with a space.";
    case "trailing_space":
      return "The job text ends with a space.";
    case "bad_byte": {
      const what =
        problem.byte === 0x0a || problem.byte === 0x0d
          ? "a line break"
          : problem.byte === 0x22
            ? "a double quote"
            : problem.byte === 0x5c
              ? "a backslash"
              : problem.byte === 0x09
                ? "a tab"
                : problem.byte > 0x7e
                  ? "a character outside plain ASCII"
                  : "a control character";
      return `Character ${problem.at + 1} is ${what}. The job text is one line of plain ASCII without double quotes or backslashes.`;
    }
  }
}
