/**
 * Writes `src/generated/houseFeeds.ts` from launch A's feed fixtures.
 *
 *   pnpm --filter @help-wanted/shared feeds:gen
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  FEED_FIXTURES_REL,
  HOUSE_FEEDS_FILE,
  feedFixturesPresent,
  renderHouseFeedsFile,
} from "./house-feeds-build.js";

if (!feedFixturesPresent()) {
  console.error(`${FEED_FIXTURES_REL} does not hold the three feed fixtures; nothing was written`);
  process.exit(1);
}
mkdirSync(dirname(HOUSE_FEEDS_FILE), { recursive: true });
writeFileSync(HOUSE_FEEDS_FILE, renderHouseFeedsFile());
console.log(`wrote ${HOUSE_FEEDS_FILE}`);
