#!/usr/bin/env node
// Prints HELP WANTED's deployments book as JSON, with nothing installed.
//
// The book is a TypeScript file, `packages/shared/src/deployments.ts`, which the bots, the indexer
// and the web app import. A script that must run on a fresh clone with only Foundry and Node (the
// reproducibility check, `scripts/repro.sh`) cannot import it, so this file reads the one object
// literal the book is made of, `DEPLOYMENT_BOOK`, as text. Nothing in that file is executed.
//
// Usage:
//   node scripts/lib/book.mjs             the whole book
//   node scripts/lib/book.mjs contracts   one line per launched contract:
//                                         <launch> <project> <Contract> <address> <launch block>
//   node scripts/lib/book.mjs chain-id    the chain the book is for
//
// A test (`scripts/evidence/test/book.test.ts`) holds what this prints against the book as
// TypeScript sees it, so the two cannot drift apart unnoticed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BOOK_PATH = "packages/shared/src/deployments.ts";
const MARKER = "export const DEPLOYMENT_BOOK";

/** The text of the object literal that follows `MARKER`, from its opening brace to the matching one. */
function literalAfterMarker(source) {
  const at = source.indexOf(MARKER);
  if (at < 0) throw new Error(`${BOOK_PATH}: ${MARKER} not found`);
  const equals = source.indexOf("=", at);
  const open = source.indexOf("{", equals);
  if (equals < 0 || open < 0) throw new Error(`${BOOK_PATH}: ${MARKER} is not followed by an object`);
  let depth = 0;
  let inString = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${BOOK_PATH}: the object after ${MARKER} is never closed`);
}

/**
 * Turns the literal into JSON: comments out, bare keys quoted, trailing commas dropped. It accepts
 * only what the book uses (double-quoted strings, numbers, null, nested objects); anything else
 * fails in `JSON.parse` instead of being guessed at.
 */
function literalToJson(literal) {
  let out = "";
  let inString = false;
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += literal[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && literal[i + 1] === "/") {
      while (i < literal.length && literal[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && literal[i + 1] === "*") {
      const end = literal.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`${BOOK_PATH}: a comment in the book is never closed`);
      i = end + 1;
    } else out += ch;
  }
  // Outside strings now: the book's strings hold addresses, hashes and paths, none of which looks
  // like `, word:`; if one ever does, JSON.parse below fails loudly.
  return out.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/,(\s*[}\]])/g, "$1");
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Checks the shape the rest of the scripts rely on. Throws a sentence that says what is wrong. */
function checkBook(book) {
  if (typeof book !== "object" || book === null) throw new Error("the book is not an object");
  if (!Number.isSafeInteger(book.chainId) || book.chainId <= 0) throw new Error("the book has no chainId");
  for (const key of ["a", "b", "c"]) {
    const launch = book[key];
    if (typeof launch !== "object" || launch === null) throw new Error(`the book has no launch ${key}`);
    if (typeof launch.project !== "string" || !/^launches\/[a-z0-9-]+$/.test(launch.project)) {
      throw new Error(`launch ${key}: project is not a path under launches/`);
    }
    if (typeof launch.contracts !== "object" || launch.contracts === null) {
      throw new Error(`launch ${key}: no contracts`);
    }
    for (const [name, address] of Object.entries(launch.contracts)) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new Error(`launch ${key}: odd contract name ${name}`);
      if (address !== null && !(typeof address === "string" && ADDRESS.test(address))) {
        throw new Error(`launch ${key}: ${name} is neither null nor an address`);
      }
    }
    if (
      launch.transaction !== null &&
      !(typeof launch.transaction === "string" && HASH.test(launch.transaction))
    ) {
      throw new Error(`launch ${key}: transaction is neither null nor a transaction hash`);
    }
    for (const field of ["block", "launchNumber"]) {
      if (launch[field] !== null && !(Number.isSafeInteger(launch[field]) && launch[field] > 0)) {
        throw new Error(`launch ${key}: ${field} is neither null nor a positive whole number`);
      }
    }
  }
  return book;
}

/** The book as `packages/shared/src/deployments.ts` holds it. `root` is the repository root. */
export function readBook(root = join(HERE, "..", "..")) {
  const source = readFileSync(join(root, BOOK_PATH), "utf8");
  return checkBook(JSON.parse(literalToJson(literalAfterMarker(source))));
}

/** `jobsReport` is the book's key; `JobsReport` is the Solidity contract and its artifact's name. */
export function solidityName(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Every contract the book holds an address for, in launch and manifest order. */
export function launchedContracts(book) {
  const rows = [];
  for (const key of ["a", "b", "c"]) {
    const launch = book[key];
    for (const [name, address] of Object.entries(launch.contracts)) {
      if (address === null) continue;
      rows.push({
        launch: key,
        project: launch.project,
        key: name,
        contract: solidityName(name),
        address,
        block: launch.block,
        transaction: launch.transaction,
      });
    }
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const book = readBook();
    if (process.argv[2] === "contracts") {
      for (const row of launchedContracts(book)) {
        console.log([row.launch, row.project, row.contract, row.address, row.block ?? "-"].join(" "));
      }
    } else if (process.argv[2] === "chain-id") {
      console.log(String(book.chainId));
    } else {
      console.log(JSON.stringify(book, null, 2));
    }
  } catch (error) {
    console.error(`book.mjs: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
