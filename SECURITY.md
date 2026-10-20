# Security

## How to report a problem

If you find a way for HELP WANTED's contracts or bots to pay the wrong party, lose IMD, or stop
working, please tell the team privately first, and do not post the details in a public issue.

Report it through GitHub's private vulnerability reporting on this repository: on
<https://github.com/OoJae/help-wanted>, open the **Security** tab and choose **Report a
vulnerability**. Only the team and you can read the report.

That form exists only when the repository's owner has turned private vulnerability reporting on
(Settings, then Advanced Security, under "Security and quality"). On 15 October 2026, at about
20:50 UTC, GitHub's API said it was off for this repository. While it is off, open a public issue
that says only that you have a problem to report privately, with no details, so that the owner can
turn the form on.

If you cannot use either, send a direct message to the project's account on X,
<https://x.com/HELPWANTED_imd>, saying only that you have a problem to report privately.

Say which contract or bot, what you did, and what happened. A transaction hash or a test that shows
it helps most.

## Scope

The ten contracts of the three launches, all on Ethereum mainnet:

| Launch | Contract     | Address                                      |
| ------ | ------------ | -------------------------------------------- |
| A      | `Questions`  | `0xEECE4628ceb091C13393fc64056Be8b8501fD3F6` |
| A      | `JobsReport` | `0x58963B57E179f7fE4E95090C21E8e9D75353BCE4` |
| A      | `Payroll`    | `0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F` |
| B      | `WorkProof`  | `0xB268297dB06985ba0b806Ba97BcB90364b137469` |
| B      | `WorkOrders` | `0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2` |
| B      | `CrowdPots`  | `0x8C2FfCdcb103659aa05c772b8F2059868B496EB5` |
| B      | `Doorbell`   | `0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb` |
| C      | `Rules`      | `0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E` |
| C      | `Endowments` | `0xbE916A53b9Bbe634AF7E10E604E06b6069edEE76` |
| C      | `Zap`        | `0x51bF8c74bd9BD74Ad08cABDC90DaC7835C18B21A` |

Their source is in `launches/`, and `packages/shared/src/deployments.ts` is where their addresses
are recorded. The bots are in scope too: the keeper (`bots/keeper`) and the runner (`bots/runner`).

Each launch's `docs/THREATS.md` lists the limits the team already knows of. A report of one of them
is still welcome when it shows a way to lose more than that document says.

IdentityMD's own contracts and services (IMD, sIMD, the seats, the Intake, the oracle, the
WorkRegistry and its API) are not ours. A problem in them goes to IdentityMD.

## What a fix can be

No contract has an owner, an admin or a setter. Nothing can be paused or upgraded, so a fix to a
contract means new code in a new launch at new addresses, and the old contracts keep running as
they are. What the team can do at once is change or stop its own bots and say what it found.

## No bounty

There is no bounty. The team pays nothing for a report, and IdentityMD records no bounty for these
contracts.
