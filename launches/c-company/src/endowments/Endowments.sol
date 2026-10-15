// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ICrowdPots} from "../interfaces/ICrowdPots.sol";
import {IQuestions} from "../interfaces/IQuestions.sol";

/// @title Endowments: money whose yield pays for something, and which its owners can always take back
/// @notice An endowment is a pool of IMD whose yield, and only its yield, pays for one thing that is
/// fixed when the endowment is created: a Standing Questions meter, a crowd pot, or a plain recipient.
/// Anyone may deposit. Deposits are staked into sIMD, the IdentityMD staking vault, and every depositor
/// can take back exactly what they put in, to the wei. There are two exceptions, both set out below: in
/// a block where sIMD is holding this contract a withdrawal waits one block (or leaves as sIMD shares),
/// and if sIMD itself ever lost value the endowment's depositors would share that loss. Nobody else,
/// including whoever created the endowment, can move a depositor's principal anywhere. There is no
/// owner, no fee and no setter, and what an endowment funds can never be changed.
///
/// @dev How the money moves.
///
/// 1. `deposit` puts IMD in a buffer inside this contract and records it as the depositor's principal.
/// 2. `stake` (anyone, at most once every `STAKE_INTERVAL` blocks) moves the whole buffer into sIMD in one
///    deposit. Staking is batched because sIMD refuses to pay out to a holder in the same block it minted
///    shares to that holder: if each deposit were staked at once, any deposit would stop every withdrawal
///    in its block. Batched, that happens in at most one block in fifty.
/// 3. The shares of one batch are split between the endowments that had IMD in it, in proportion and
///    rounded down. The split is worked out the next time each endowment is touched, so `stake` costs the
///    same however many endowments there are.
/// 4. `withdraw` pays from the endowment's buffered IMD first and takes the rest out of sIMD. Buffered
///    IMD belongs to the endowment, not to whoever deposited it last: one depositor's withdrawal may be
///    paid with IMD another has just put in, whose principal is then backed by the shares instead.
/// 5. `harvest` (anyone) redeems only the shares an endowment holds beyond what its principal needs, and
///    sends the IMD to the endowment's target.
///
/// The rule every function keeps. An endowment is *covered* when its buffered IMD plus the IMD its
/// shares can be withdrawn for is at least its principal, and *whole* when it is covered with at least
/// `SPARE` share-wei left over. A withdrawal is paid in full only if the endowment is still covered
/// afterwards, and `harvest` takes nothing that would leave it with less than `MARGIN` share-wei left
/// over. Each depositor can take out at most their own recorded principal, so no depositor can reach
/// another's.
///
/// Rounding. Every sIMD conversion rounds against the caller by less than one share-wei (a share-wei is
/// worth about 0.000008 IMD-wei today). Two things absorb that so withdrawals stay exact: creating an
/// endowment costs a one-off `SEED` that is staked with the first batch and is nobody's principal, and
/// `harvest` always leaves `MARGIN` share-wei behind. A batch costs an endowment at most two share-wei
/// and a withdrawal at most one, so it would take hundreds of thousands of millions of them to wear an
/// endowment down from `MARGIN` to `SPARE`; yield refills it. These sizes assume a share-wei is worth
/// less than an IMD-wei, which holds until sIMD's price is more than a hundred thousand times today's.
///
/// If sIMD ever lost value. sIMD's price cannot fall by its own rules (its owner is the zero address, so
/// its pause and rescue functions are dead), but this contract does not rely on that.
/// - `stake` and `harvest` each read sIMD's price and record the highest they have seen in `priceMark`.
///   While the price is below that mark both refuse to run: no more IMD goes into a vault that has just
///   lost value, and yield that builds up again is kept as cover instead of being paid out. This only
///   sees a fall from a price one of the two functions was run at; a rise and fall between two such
///   runs goes unnoticed, and then the next rule is the only one that applies.
/// - An endowment that is not covered is *short*: it accepts no new deposits, `harvest` takes nothing
///   from it, `withdraw` reverts, and `exit` pays each leaver their proportional slice of what the
///   endowment holds, so the first to leave cannot take more than their part. The slice is of the
///   buffer as well as of the shares: a deposit still waiting to be staked shares in a loss on what
///   its endowment had already staked. Yield or a `donate` makes a short endowment whole again.
/// - Right after such a loss is made good an endowment can be covered with fewer than `SPARE`
///   share-wei left over. It then takes no deposits, and a withdrawal that would leave the others one
///   share-wei short is refused (`exit` pays it to within a few wei) until yield or a small `donate`
///   rebuilds the spare. The last depositor out is always paid in full.
///
/// What a depositor still relies on, stated plainly:
/// - sIMD and IMD themselves. A fault in either is outside this contract and would be shared pro rata.
///   sIMD gives Permit2 a standing allowance over every holder's shares; Permit2 moves tokens only with
///   the holder's own approval inside Permit2 or the holder's signature, and this contract can give
///   neither (it never calls Permit2 and has no signature check of its own).
/// - In a block where this contract staked, sIMD pays nothing out, so only buffered IMD can be withdrawn
///   as IMD. Anyone who deposits into sIMD in this contract's name, or mints sIMD and sends a share
///   here, causes the same hold for that one block. It gains them nothing and costs them one sIMD
///   deposit of gas for every block they keep it up; while it lasts, `harvest` cannot run and IMD
///   withdrawals that need sIMD wait. `exit` with `inKind` is never held: it hands over sIMD shares
///   worth the principal instead of IMD, and a share transfer cannot be stopped.
/// - Yield that has been harvested is gone to the target for good. A meter endowment's harvests become
///   meter shares that this contract never redeems, even if the feed stops asking. What a feed that
///   has stopped asking can absorb is bounded: a harvest never lifts a meter above the cost of
///   `METER_RUNWAY` requests, and yield beyond that stays staked, as extra cover for the principal,
///   until requests have been bought and the meter has room again. Anyone can fill that room with
///   IMD of their own (it is then their money that buys the feed's answers), and while Questions
///   states no cost for the feed there is no room at all. A pot endowment's fallback beneficiary
///   owns every chip made for it (so any refund or change the pot pays goes to them) and receives
///   the whole harvest whenever the pot is taking no chips at all.
/// - The endowment id. Ids are handed out in order, so a new endowment's id is only known once its
///   `Created` event exists. Deposit to the id read from that event, not to a predicted one.
/// - The recipient. Only the addresses this contract knows would strand IMD are refused; any other
///   contract that cannot move IMD on is accepted, and what is harvested to it is lost.
/// - IMD or sIMD sent straight to this contract, instead of through `deposit` or `donate`, belongs to no
///   endowment and stays here. So does the rounding dust of a batch split (under one share-wei per
///   endowment per batch).
contract Endowments is ReentrancyGuardTransient {
    // Every function that changes state holds the same transient lock, so no nested call can run in
    // between and reorder this contract's events. The lint cannot see the lock, and it counts the views
    // of sIMD and CrowdPots that come before an event as calls that could re-enter. `MeterFunded` and
    // `FallbackPaid` do follow a real call to the target: what they report is only known then.
    // forge-lint: disable-start(reentrancy-events)
    //
    // Slither's `reentrancy-balance` is switched off at `stake`, `_leaveVault` and `_forward` for the same
    // reason. Each reads a balance, calls sIMD or Questions, and compares the balance again: that is how
    // this contract checks that they did what they reported. With the lock held no call into this
    // contract can run in between, and tokens sent here by plain transfer are credited to nobody.

    using SafeERC20 for IERC20;

    /// @dev What an endowment's yield pays for. `None` marks an id that was never created.
    enum Kind {
        None,
        Meter,
        Pot,
        Recipient
    }

    struct Endowment {
        Kind kind;
        // Recipient: who receives the yield. Pot: who owns the chips and receives what the pot does not take.
        address beneficiary;
        // The batch `pending` is waiting for. Meaningful only while `pending` is not zero.
        uint64 pendingEpoch;
        // Meter: the feed id. Pot: the pot id. Recipient: zero.
        bytes32 target;
        // Everything depositors may take back.
        uint256 principal;
        // IMD waiting in the buffer, or, once its batch has been staked, the amount still to be turned
        // into `shares`.
        uint256 pending;
        // sIMD shares that belong to this endowment.
        uint256 shares;
        // IMD sent to the target or the fallback so far.
        uint256 harvested;
    }

    /// @dev One `stake` call: how much IMD went in and how many shares it was booked for.
    struct Epoch {
        uint256 assets;
        uint256 shares;
    }

    /// @dev How one withdrawal will be paid, worked out before anything is written.
    struct Plan {
        uint256 fromBuffer;
        uint256 shareCost;
        uint256 vaultOut;
        bool exact;
    }

    /// @notice The least number of blocks between two `stake` calls.
    uint256 public constant STAKE_INTERVAL = 50;

    /// @notice IMD-wei the creator of an endowment pays once. It is staked with the endowment's first
    /// batch, is nobody's principal, and is what keeps withdrawals exact when no yield has arrived yet.
    uint256 public constant SEED = 1e12;

    /// @notice sIMD share-wei that `harvest` always leaves on top of what the principal needs.
    uint256 public constant MARGIN = 1e12;

    /// @notice sIMD share-wei an endowment must hold on top of what its principal needs to count as
    /// whole. Half of `MARGIN`, so the withdrawals that follow a harvest cannot use it up.
    uint256 public constant SPARE = MARGIN / 2;

    /// @notice The least IMD a `harvest` is run for. Smaller amounts wait and keep earning.
    uint256 public constant MIN_HARVEST = 1e15;

    /// @notice How many requests' worth of IMD a meter may hold after a harvest. A meter endowment
    /// tops its meter up to this many requests at the feed's current cost (`IQuestions.costOf`) and
    /// no further; the rest of its yield stays staked until the meter has room.
    uint256 public constant METER_RUNWAY = 30;

    /// @notice Gas handed to `CrowdPots.chipInFor` when a pot endowment is harvested.
    uint256 public constant POT_CALL_GAS = 500_000;

    /// @notice Gas handed to `CrowdPots.remaining` when a pot endowment is harvested.
    uint256 public constant POT_VIEW_GAS = 50_000;

    /// @notice One whole sIMD, in share-wei. `priceMark` is the IMD-wei this many shares convert to.
    uint256 public constant PRICE_UNIT = 1e24;

    /// @dev `harvest` on a pot endowment must reach the pot call with this much gas, so the call really
    /// gets `POT_CALL_GAS` (a call can pass on at most 63/64 of what is left) and enough remains to pay
    /// the fallback afterwards. It is far more than `POT_VIEW_GAS` needs in the same way.
    uint256 private constant POT_GAS_FLOOR = POT_CALL_GAS + POT_CALL_GAS / 63 + 120_000;

    /// @notice The IMD token: what is deposited, withdrawn and harvested.
    IERC20 public immutable IMD;
    /// @notice The sIMD staking vault that holds the staked principal.
    IERC4626 public immutable SIMD;
    /// @notice The Standing Questions contract whose meters `Kind.Meter` endowments fund.
    IQuestions public immutable QUESTIONS;
    /// @notice The CrowdPots contract `Kind.Pot` endowments chip into.
    ICrowdPots public immutable CROWD_POTS;

    /// @notice How many endowments exist. Ids count from 1.
    uint256 public endowmentCount;

    /// @notice IMD in the buffer: everything deposited or donated since the last `stake`, less what has
    /// been withdrawn from it.
    uint256 public pendingTotal;

    /// @notice The batch that buffered IMD is waiting for. Counts from 1; each `stake` closes one.
    uint64 public epoch;

    /// @notice The block of the last `stake`. sIMD pays nothing out to this contract in that block.
    uint256 public lastStakeBlock;

    /// @notice The highest sIMD price `stake` or `harvest` has seen: the IMD-wei that `PRICE_UNIT`
    /// share-wei converted to. Zero until the first of them runs. Both refuse to run below it.
    uint256 public priceMark;

    /// @notice What `account` may take back from endowment `id`.
    mapping(uint256 id => mapping(address account => uint256)) public principalOf;

    mapping(uint256 id => Endowment) private _endowments;
    mapping(uint256 epoch => Epoch) private _epochs;

    event Created(uint256 indexed id, Kind kind, bytes32 target, address beneficiary, address indexed creator);
    event Deposited(uint256 indexed id, address indexed depositor, uint256 amount);
    event Donated(uint256 indexed id, address indexed donor, uint256 amount);
    /// @dev `shares` is what the batch was booked for; the vault minted at least that.
    event Staked(uint256 indexed epoch, uint256 assets, uint256 shares);
    /// @dev An endowment's part of a staked batch was turned into shares.
    event Settled(uint256 indexed id, uint256 indexed epoch, uint256 assets, uint256 shares);
    /// @dev `principal` is what the depositor gave up; `imdOut` and `sharesOut` are what they were sent.
    event Withdrawn(
        uint256 indexed id, address indexed depositor, uint256 principal, uint256 imdOut, uint256 sharesOut
    );
    event Harvested(uint256 indexed id, address indexed caller, uint256 shares, uint256 assets);
    /// @dev A meter took a harvest and minted `meterShares` of the meter to this contract. Those shares
    /// are never redeemed: nothing here calls `defund`, so the yield stays with the feed.
    event MeterFunded(uint256 indexed id, bytes32 indexed feedId, uint256 amount, uint256 meterShares);
    /// @dev A pot did not take all of a harvest; the rest went to the endowment's fallback beneficiary.
    event FallbackPaid(uint256 indexed id, address indexed beneficiary, uint256 amount);
    /// @dev `stake` or `harvest` saw sIMD at a new highest price.
    event PriceMarked(uint256 price);

    error ZeroAddress();
    error ZeroAmount();
    /// @dev A zero feed id, or a recipient or fallback beneficiary where harvested IMD would be lost.
    error BadTarget();
    /// @dev Questions states no cost for this feed: it does not exist, or the Intake is not selling the
    /// feed's action for IMD right now.
    error FeedNotLive(bytes32 feedId);
    /// @dev CrowdPots has opened no pot or series with this id.
    error UnknownPot(uint256 potId);
    error UnknownEndowment();
    /// @dev The caller asked for more than their own principal, which is `have`.
    error OverPrincipal(uint256 have);
    /// @dev The endowment is not whole (see `isWhole`), so it takes no new deposits.
    error EndowmentShort();
    /// @dev The withdrawal would pay `out`, less than the `minOut` the caller insists on.
    error BelowMinimum(uint256 out, uint256 minOut);
    /// @dev This contract staked in this block and sIMD pays nothing out until the next one.
    error HoldActive();
    /// @dev sIMD's price is below the highest price this contract has recorded.
    error PriceFell(uint256 price, uint256 mark);
    error TooSoon(uint256 nextBlock);
    error NothingToStake();
    error NothingToHarvest();
    /// @dev IMD did not arrive in full from the caller.
    error TransferMismatch();
    /// @dev The address given as sIMD is not a vault over IMD.
    error WrongVault();
    /// @dev sIMD did not do what its own preview said it would.
    error VaultMismatch();
    /// @dev The meter did not take exactly what it was sent, or the pot took more than it was offered.
    error TargetMismatch();
    /// @dev Not enough gas to give the pot a fair chance to take the harvest.
    error LowGas();

    /// @param imd The IMD token.
    /// @param simd The sIMD staking vault (ERC-4626 over IMD).
    /// @param questions The Standing Questions contract whose meters `Kind.Meter` endowments fund.
    /// @param crowdPots The CrowdPots contract `Kind.Pot` endowments chip into.
    /// @dev Stores the four addresses and nothing else, and calls none of them: each is checked by the
    /// function that first needs it (`stake` checks the vault, `createForMeter` the feed,
    /// `createForPot` the pot). They are literals in the launch manifest, where anyone can check them
    /// against the protocol's published addresses before depositing.
    constructor(address imd, address simd, address questions, address crowdPots) {
        if (imd == address(0) || simd == address(0) || questions == address(0) || crowdPots == address(0)) {
            revert ZeroAddress();
        }
        IMD = IERC20(imd);
        SIMD = IERC4626(simd);
        QUESTIONS = IQuestions(questions);
        CROWD_POTS = ICrowdPots(crowdPots);
        epoch = 1;
    }

    // ------------------------------------------------------------------------------------------
    // Creating
    // ------------------------------------------------------------------------------------------

    /// @notice Creates an endowment whose yield tops up one Standing Questions meter.
    /// @dev Anyone may call. Pulls `SEED` IMD from the caller, which is not refundable. The feed must be
    /// one Questions can ask today: reverts `FeedNotLive` when `Questions.costOf` is zero, which is the
    /// case for an id that is not a feed (a feed id is a hash, so a mistyped one never becomes a feed)
    /// and while the Intake is not selling the feed's action. Without this check the yield of such an
    /// endowment could never leave: a meter endowment has no fallback, and `Questions.fund` reverts for
    /// an unknown feed. A feed that exists is funded for good, whether or not it is still being asked,
    /// but never beyond `METER_RUNWAY` requests at a time (see `harvest`).
    /// @param feedId The feed whose meter receives the yield. Fixed for good.
    /// @return id The new endowment's id. Read it from `Created`; do not predict it.
    function createForMeter(bytes32 feedId) external nonReentrant returns (uint256 id) {
        if (feedId == bytes32(0)) revert BadTarget();
        if (QUESTIONS.costOf(feedId) == 0) revert FeedNotLive(feedId);
        id = _create(Kind.Meter, feedId, address(0));
    }

    /// @notice Creates an endowment whose yield chips into one crowd pot or pot series.
    /// @dev Anyone may call. Pulls `SEED` IMD from the caller, which is not refundable. Chips are made
    /// in `fallbackBeneficiary`'s name, so every refund or change the pot pays goes to them, and so does
    /// the whole harvest whenever the pot is taking no chips (it is full, closed or reverts). Depositors
    /// should know who that is. Reverts `UnknownPot` unless the pot or series already exists, so nobody
    /// else can open the pot that an announced endowment would then fund. Reverts `BadTarget` for a
    /// beneficiary where a plain IMD transfer would be lost (see `createForRecipient`).
    /// @param potId The pot or series that is offered the yield. Fixed for good.
    /// @param fallbackBeneficiary Who owns the chips and gets the yield the pot does not take. Fixed for good.
    /// @return id The new endowment's id. Read it from `Created`; do not predict it.
    function createForPot(uint256 potId, address fallbackBeneficiary) external nonReentrant returns (uint256 id) {
        if (_strands(fallbackBeneficiary)) revert BadTarget();
        if (potId == 0 || potId > CROWD_POTS.potCount()) revert UnknownPot(potId);
        id = _create(Kind.Pot, bytes32(potId), fallbackBeneficiary);
    }

    /// @notice Creates an endowment whose yield is sent to one address by plain transfer.
    /// @dev Anyone may call. Pulls `SEED` IMD from the caller, which is not refundable. Reverts
    /// `BadTarget` for the zero address and for the five addresses where IMD sent by plain transfer
    /// would be lost or misdirected: this contract, the IMD token, Questions, CrowdPots and sIMD. sIMD
    /// is refused because a harvest arrives as one lump, and whoever staked a block earlier and called
    /// `harvest` themselves would collect a share of it without having staked for longer than a block.
    /// To pay stakers, name a contract that passes on what it receives as a slow stream, the way Payroll
    /// does with the stakers' part of its income. Any other contract is accepted, including one that
    /// cannot move IMD on.
    /// @param recipient Who receives the yield. Fixed for good.
    /// @return id The new endowment's id. Read it from `Created`; do not predict it.
    function createForRecipient(address recipient) external nonReentrant returns (uint256 id) {
        if (_strands(recipient)) revert BadTarget();
        id = _create(Kind.Recipient, bytes32(0), recipient);
    }

    // ------------------------------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------------------------------

    /// @notice Adds `amount` IMD to an endowment as the caller's principal.
    /// @dev Pulls the IMD from the caller, who must have approved this contract. The IMD waits in the
    /// endowment's buffer until the next `stake`. The principal can be withdrawn from then on, with two
    /// limits: once the buffer has been staked or used to pay another depositor, a withdrawal needs
    /// sIMD and so waits out a hold block; and if sIMD loses value before or after the stake, this
    /// deposit shares the endowment's loss like every other (see `exit`). Reverts `EndowmentShort`
    /// unless the endowment is whole (see `isWhole`), so that nobody deposits into a loss that was
    /// already there or into an endowment with no share-wei to spare for rounding.
    function deposit(uint256 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Endowment storage e = _settle(id);
        if (!_whole(e.principal, e.pending, e.shares)) revert EndowmentShort();

        principalOf[id][msg.sender] += amount;
        e.principal += amount;
        _buffer(e, amount);
        emit Deposited(id, msg.sender, amount);

        _pull(amount);
    }

    /// @notice Gives `amount` IMD to an endowment without becoming a depositor.
    /// @dev The gift is nobody's principal. It first makes good any shortfall, and what is left over is
    /// paid to the endowment's target by later harvests. It cannot be taken back.
    function donate(uint256 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Endowment storage e = _settle(id);

        _buffer(e, amount);
        emit Donated(id, msg.sender, amount);

        _pull(amount);
    }

    /// @notice Moves all buffered IMD into sIMD. Anyone may call, at most once every `STAKE_INTERVAL` blocks.
    /// @dev Reverts `TooSoon` inside the interval, `NothingToStake` with an empty buffer, `WrongVault` if
    /// the vault's asset is not IMD, and `PriceFell` while sIMD's price is below `priceMark` (the buffer
    /// then simply stays IMD, and can be withdrawn as such). For the rest of this block sIMD pays
    /// nothing out to this contract, so withdrawals that need sIMD wait one block (or use `exit` with
    /// `inKind`). The batch is booked at what `previewDeposit` promises; the call reverts if the vault
    /// then mints fewer shares than that.
    /// @return shares The shares the batch was booked for.
    // slither-disable-next-line reentrancy-balance
    function stake() external nonReentrant returns (uint256 shares) {
        uint256 next = lastStakeBlock + STAKE_INTERVAL;
        if (block.number < next) revert TooSoon(next);
        uint256 assets = pendingTotal;
        if (assets == 0) revert NothingToStake();
        // The constructor could not ask. A wrong address here would otherwise only show as a revert
        // somewhere inside the deposit below.
        if (SIMD.asset() != address(IMD)) revert WrongVault();
        _checkPrice();
        shares = SIMD.previewDeposit(assets);
        // A batch that mints nothing would turn the buffer into no shares at all.
        if (shares == 0) revert VaultMismatch();

        uint64 closing = epoch;
        _epochs[closing] = Epoch({assets: assets, shares: shares});
        epoch = closing + 1;
        lastStakeBlock = block.number;
        pendingTotal = 0;
        emit Staked(closing, assets, shares);

        uint256 sharesBefore = SIMD.balanceOf(address(this));
        IMD.forceApprove(address(SIMD), assets);
        uint256 minted = SIMD.deposit(assets, address(this));
        if (minted < shares || SIMD.balanceOf(address(this)) < sharesBefore + shares) revert VaultMismatch();
    }

    // ------------------------------------------------------------------------------------------
    // Money out
    // ------------------------------------------------------------------------------------------

    /// @notice Takes back `amount` of the caller's own principal as exactly `amount` IMD.
    /// @dev Pays from the endowment's buffered IMD first and takes the rest out of sIMD. It never pays
    /// less than `amount`; it reverts instead:
    /// - `OverPrincipal` if `amount` is more than the caller's principal in this endowment;
    /// - `HoldActive` if sIMD is needed and this contract staked in this block (wait one block, or use
    ///   `exit` with `inKind`);
    /// - `BelowMinimum` if the endowment is short (see `exit` for leaving at a loss), or if it is
    ///   covered with no share-wei to spare and paying `amount` in full would leave the other
    ///   depositors a share-wei short. Neither happens while `isWhole` is true;
    /// - with sIMD's own error if someone else caused a hold on this contract in this block.
    function withdraw(uint256 id, uint256 amount) external nonReentrant {
        _exit(id, amount, amount, false);
    }

    /// @notice The long form of `withdraw`: lets the caller accept less than `amount` when the endowment
    /// is short, and lets them take sIMD shares instead of waiting for sIMD to pay out.
    /// @dev Gives up `amount` of the caller's principal. If the endowment stays covered, the caller gets
    /// the full `amount`. If it would not, they get the same fraction of the endowment's buffered IMD
    /// and of its shares as `amount` is of its principal, rounded down, and the rest of that principal is
    /// written off: nothing is owed for it later.
    /// @param minOut The least value the caller accepts, in IMD-wei. Shares count at what sIMD says they
    /// convert to. Pass `amount` to refuse any loss.
    /// @param inKind False: everything is paid in IMD. True: the part that is staked is paid as sIMD
    /// shares (for a covered endowment, the number of shares sIMD would burn to pay that part out).
    /// Shares can be handed over in any block, including one where sIMD is holding this contract; the
    /// receiver can redeem them with sIMD from the next block on.
    /// @return imdOut IMD sent to the caller.
    /// @return sharesOut sIMD shares sent to the caller.
    function exit(uint256 id, uint256 amount, uint256 minOut, bool inKind)
        external
        nonReentrant
        returns (uint256 imdOut, uint256 sharesOut)
    {
        return _exit(id, amount, minOut, inKind);
    }

    /// @notice Sends an endowment's yield to its target. Anyone may call.
    /// @dev Takes only shares the endowment holds beyond what its principal needs plus `MARGIN`, so it
    /// cannot touch principal, and it takes nothing from a short endowment. Reverts:
    /// - `NothingToHarvest` when that is worth less than `MIN_HARVEST`;
    /// - `HoldActive` in a block where this contract staked, and with sIMD's own error in a block where
    ///   someone else caused a hold on this contract;
    /// - `PriceFell` while sIMD's price is below `priceMark`: after a fall, yield stays as cover until
    ///   the price is back.
    ///
    /// Where the IMD goes. A recipient endowment transfers it. A meter endowment first reads what
    /// the meter has room for: the cost of `METER_RUNWAY` requests (`Questions.costOf` times the
    /// runway) less what the meter holds (`Questions.meterOf`). The harvest takes out no more than
    /// that and calls `Questions.fund`; the rest of the yield stays staked as extra cover until
    /// requests have been bought. With room for less than `MIN_HARVEST` (a full meter, or a feed
    /// Questions states no cost for) it reverts `NothingToHarvest`. If Questions cannot be read or
    /// `fund` reverts, so does the harvest, and the yield stays staked. A pot
    /// endowment first asks the pot what it still needs (`CrowdPots.remaining`). If the pot needs
    /// something, the harvest takes out no more than that and the rest stays staked for the pot's
    /// later needs (for a series, its next round). If the pot needs nothing, cannot be read, or does
    /// not take what it said it needed, the remainder goes to the fallback beneficiary. Chips are made
    /// in that beneficiary's name.
    ///
    /// A pot harvest reverts `LowGas` unless it is sent with enough gas for the pot to be handed its whole
    /// allowance: today that takes a gas limit of a little over 800,000, and 850,000 is a safe figure.
    /// Most of it is only reserved for the pot and comes back unused. Without this rule a caller could
    /// push the yield to the fallback by starving either call to the pot.
    /// @return assets The IMD that left for the target or the fallback.
    function harvest(uint256 id) external nonReentrant returns (uint256 assets) {
        Endowment storage e = _settle(id);
        // Checked again right before the chip. Here it makes sure the pot can answer what it needs:
        // that answer decides how much is taken out of the vault.
        if (e.kind == Kind.Pot && gasleft() < POT_GAS_FLOOR) revert LowGas();
        uint256 shares = e.shares;
        uint256 cost;
        bool byAssets;
        (cost, assets, byAssets) = _harvestPlan(e, e.pending, shares);
        if (assets == 0) revert NothingToHarvest();
        // `lastStakeBlock` is never in the future, so this is true only in the stake block itself.
        if (block.number <= lastStakeBlock) revert HoldActive();
        _checkPrice();

        e.shares = shares - cost;
        e.harvested += assets;
        emit Harvested(id, msg.sender, cost, assets);

        _leaveVault(byAssets, assets, cost);
        _forward(id, e, assets);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @notice An endowment as it stands now.
    /// @return kind What the yield pays for. `Kind.None` (and zeros) for an id that does not exist.
    /// @return target The feed id (meter) or pot id (pot); zero for a recipient endowment.
    /// @return beneficiary The recipient, or the pot endowment's fallback beneficiary; zero for a meter.
    /// @return principal Everything its depositors may take back.
    /// @return buffered Its IMD still waiting in this contract to be staked.
    /// @return shares Its sIMD shares, including its part of a batch that is staked but not yet booked.
    /// @return harvested IMD it has sent to its target or fallback so far.
    function endowment(uint256 id)
        external
        view
        returns (
            Kind kind,
            bytes32 target,
            address beneficiary,
            uint256 principal,
            uint256 buffered,
            uint256 shares,
            uint256 harvested
        )
    {
        Endowment storage e = _endowments[id];
        (buffered, shares) = _peek(e);
        return (e.kind, e.target, e.beneficiary, e.principal, buffered, shares, e.harvested);
    }

    /// @notice What an endowment holds, in IMD: its buffered IMD plus what sIMD says its shares convert to.
    function backingOf(uint256 id) external view returns (uint256) {
        (uint256 buffered, uint256 shares) = _peek(_endowments[id]);
        return buffered + (shares == 0 ? 0 : SIMD.convertToAssets(shares));
    }

    /// @notice True when the endowment's holdings cover its principal with at least `SPARE` share-wei
    /// left over (always, while nothing of its principal is staked).
    /// @dev While true the endowment takes deposits, and any part of a depositor's principal is paid in
    /// full by `withdraw` outside a hold. False means short, or covered with too little to spare: see
    /// the contract notes. An id that does not exist reads true and holds nothing.
    function isWhole(uint256 id) external view returns (bool) {
        Endowment storage e = _endowments[id];
        (uint256 buffered, uint256 shares) = _peek(e);
        return _whole(e.principal, buffered, shares);
    }

    /// @notice What `harvest(id)` would send right now. Zero when it would revert `NothingToHarvest` or
    /// `PriceFell`.
    /// @dev Does not look at the hold: in a block where sIMD is holding this contract, `harvest` reverts
    /// anyway. For a pot endowment it is what the pot still needs, when that is less than the yield.
    /// For a meter endowment it is what the meter has room for under `METER_RUNWAY`, when that is
    /// less than the yield, and zero when that is less than `MIN_HARVEST`; the call reverts if
    /// Questions cannot be read, and the harvest can still revert inside `Questions.fund`.
    function harvestable(uint256 id) external view returns (uint256 assets) {
        Endowment storage e = _endowments[id];
        (uint256 buffered, uint256 shares) = _peek(e);
        (, assets,) = _harvestPlan(e, buffered, shares);
        if (assets != 0 && SIMD.convertToAssets(PRICE_UNIT) < priceMark) assets = 0;
    }

    /// @notice What giving up `amount` of principal in endowment `id` would pay right now.
    /// @dev The same arithmetic `withdraw` and `exit` use. It does not check whose principal it is and
    /// does not look at the hold. All zeros when `amount` is zero or more than the endowment's principal.
    /// @return imdOut IMD that would be sent.
    /// @return sharesOut sIMD shares that would be sent (only with `inKind`).
    /// @return exact True when the endowment stays covered, so the payment is worth the full `amount`.
    function quote(uint256 id, uint256 amount, bool inKind)
        external
        view
        returns (uint256 imdOut, uint256 sharesOut, bool exact)
    {
        Endowment storage e = _endowments[id];
        if (amount != 0 && amount <= e.principal) {
            (uint256 buffered, uint256 shares) = _peek(e);
            Plan memory p = _plan(e.principal, buffered, shares, amount, inKind);
            exact = p.exact;
            if (inKind) {
                imdOut = p.fromBuffer;
                sharesOut = p.shareCost;
            } else {
                imdOut = p.fromBuffer + p.vaultOut;
            }
        }
    }

    /// @notice The first block in which `stake` can be called again.
    function nextStakeBlock() external view returns (uint256) {
        return lastStakeBlock + STAKE_INTERVAL;
    }

    /// @notice True when sIMD will pay nothing out to this contract in this block: this contract staked
    /// in it, or someone deposited into sIMD in its name or sent it sIMD that was minted in it.
    /// @dev While true, `withdraw` pays only what the endowment's buffer covers and `harvest` reverts;
    /// `exit` with `inKind` is not affected. It asks the vault itself, so it also reports a hold this
    /// contract did not cause.
    function vaultHold() external view returns (bool) {
        return SIMD.maxRedeem(address(this)) < SIMD.balanceOf(address(this));
    }

    /// @notice True when sIMD's price is below `priceMark`, so `stake` and `harvest` refuse to run.
    function priceBelowMark() external view returns (bool) {
        return SIMD.convertToAssets(PRICE_UNIT) < priceMark;
    }

    /// @notice A closed batch: the IMD that was staked and the shares it was booked for.
    function epochs(uint256 number) external view returns (uint256 assets, uint256 shares) {
        Epoch storage r = _epochs[number];
        return (r.assets, r.shares);
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    /// @dev True for an address where IMD arriving by plain transfer would be stuck for good, and for
    /// sIMD, where it would be shared with whoever staked a block before the harvest.
    function _strands(address to) private view returns (bool) {
        return to == address(0) || to == address(this) || to == address(IMD) || to == address(SIMD)
            || to == address(QUESTIONS) || to == address(CROWD_POTS);
    }

    function _create(Kind kind, bytes32 target, address beneficiary) private returns (uint256 id) {
        id = ++endowmentCount;
        Endowment storage e = _endowments[id];
        e.kind = kind;
        e.target = target;
        e.beneficiary = beneficiary;
        _buffer(e, SEED);
        emit Created(id, kind, target, beneficiary, msg.sender);

        _pull(SEED);
    }

    /// @dev Loads an endowment and, if a batch holding its IMD has been staked since it was last
    /// touched, turns that IMD into its part of the batch's shares. Rounded down: the dust stays in this
    /// contract and belongs to no endowment, so the endowments' shares never add up to more than this
    /// contract holds.
    function _settle(uint256 id) private returns (Endowment storage e) {
        e = _endowments[id];
        if (e.kind == Kind.None) revert UnknownEndowment();
        uint256 pending = e.pending;
        if (pending != 0) {
            uint64 pendingEpoch = e.pendingEpoch;
            if (pendingEpoch < epoch) {
                Epoch storage r = _epochs[pendingEpoch];
                uint256 minted = Math.mulDiv(pending, r.shares, r.assets);
                e.shares += minted;
                e.pending = 0;
                emit Settled(id, pendingEpoch, pending, minted);
            }
        }
    }

    /// @dev What `_settle` would leave, without writing it.
    function _peek(Endowment storage e) private view returns (uint256 buffered, uint256 shares) {
        buffered = e.pending;
        shares = e.shares;
        if (buffered != 0) {
            uint64 pendingEpoch = e.pendingEpoch;
            if (pendingEpoch < epoch) {
                Epoch storage r = _epochs[pendingEpoch];
                shares += Math.mulDiv(buffered, r.shares, r.assets);
                buffered = 0;
            }
        }
    }

    /// @dev Adds IMD to a settled endowment's buffer.
    function _buffer(Endowment storage e, uint256 amount) private {
        e.pending += amount;
        e.pendingEpoch = epoch;
        pendingTotal += amount;
    }

    /// @dev Pulls IMD from the caller and insists that all of it arrived, so the buffer never claims
    /// more IMD than this contract holds.
    function _pull(uint256 amount) private {
        uint256 before = IMD.balanceOf(address(this));
        IMD.safeTransferFrom(msg.sender, address(this), amount);
        if (IMD.balanceOf(address(this)) < before + amount) revert TransferMismatch();
    }

    /// @dev Reads sIMD's price. Below the highest price recorded so far it reverts; above it, it records
    /// the new one. sIMD rounds every deposit and withdrawal in its own favour, so its price only ever
    /// rises unless it loses IMD.
    function _checkPrice() private {
        uint256 price = SIMD.convertToAssets(PRICE_UNIT);
        uint256 mark = priceMark;
        if (price < mark) revert PriceFell(price, mark);
        if (price > mark) {
            priceMark = price;
            emit PriceMarked(price);
        }
    }

    /// @dev Whether the endowment is whole: buffered IMD plus what the shares can be withdrawn for
    /// covers the principal, with `SPARE` share-wei left over. The spare is what lets a deposit that
    /// passes this test be staked (a batch costs up to two share-wei) and withdrawn again in pieces (one
    /// share-wei each) without ever leaving the endowment short.
    function _whole(uint256 principal, uint256 buffered, uint256 shares) private view returns (bool) {
        if (principal <= buffered) return true;
        return shares >= SIMD.previewWithdraw(principal - buffered) + SPARE;
    }

    /// @dev The shares `harvest` must leave: what the staked part of the principal needs, plus the margin.
    function _keep(uint256 principal, uint256 buffered) private view returns (uint256) {
        return MARGIN + (principal > buffered ? SIMD.previewWithdraw(principal - buffered) : 0);
    }

    /// @dev What a harvest would take out of the vault right now: `cost` shares for `assets` IMD. All
    /// zero when the yield is worth less than `MIN_HARVEST`, or when a meter has room for less than
    /// that. `byAssets` says the amount was cut to what the meter has room for or the pot still needs,
    /// so it is taken as an exact number of IMD instead of an exact number of shares.
    function _harvestPlan(Endowment storage e, uint256 buffered, uint256 shares)
        private
        view
        returns (uint256 cost, uint256 assets, bool byAssets)
    {
        uint256 keep = _keep(e.principal, buffered);
        if (shares <= keep) return (cost, assets, byAssets);
        uint256 excess = shares - keep;
        uint256 worth = SIMD.previewRedeem(excess);
        if (worth < MIN_HARVEST) return (cost, assets, byAssets);
        cost = excess;
        assets = worth;

        if (e.kind == Kind.Meter) {
            uint256 room = _meterRoom(e.target);
            if (room < worth) {
                // A meter that is full, or nearly so, takes nothing: the yield waits and keeps earning.
                uint256 part = room < MIN_HARVEST ? 0 : SIMD.previewWithdraw(room);
                // `room` is less than the excess is worth, so it costs no more shares than the excess.
                // A vault whose previews do not agree on that is not acted on.
                if (part == 0 || part > excess) {
                    cost = 0;
                    assets = 0;
                } else {
                    cost = part;
                    assets = room;
                    byAssets = true;
                }
            }
            return (cost, assets, byAssets);
        }

        if (e.kind == Kind.Pot) {
            uint256 room = _potRoom(uint256(e.target));
            if (room != 0 && room < worth) {
                uint256 part = SIMD.previewWithdraw(room);
                // Only ever fewer shares than the full harvest: what is left on top of `keep` stays
                // staked. (Not fewer only if a share-wei were worth more than an IMD-wei; then the
                // full harvest is offered and the pot takes what it needs.)
                if (part != 0 && part < excess) {
                    cost = part;
                    assets = room;
                    byAssets = true;
                }
            }
        }
    }

    /// @dev How much IMD the feed's meter can take before it holds more than `METER_RUNWAY` requests
    /// cost today. Zero when the meter already holds that much, and zero while Questions states no
    /// cost for the feed (the Intake is not selling its action, or asks more than the feed's limit):
    /// a meter that cannot spend is not topped up. The cost is the live one, so the room moves with
    /// the Intake's price.
    function _meterRoom(bytes32 feedId) private view returns (uint256) {
        uint256 cost = QUESTIONS.costOf(feedId);
        if (cost == 0) return 0;
        // Of the two figures `meterOf` reports, only the meter's unspent IMD is needed here.
        // slither-disable-start unused-return
        // forge-lint: disable-next-line(unused-return)
        (uint256 held,) = QUESTIONS.meterOf(feedId);
        // slither-disable-end unused-return
        return Math.saturatingSub(Math.saturatingMul(cost, METER_RUNWAY), held);
    }

    /// @dev What the pot says it still needs, or zero if it cannot be read. A capped, static call whose
    /// answer is read only if the call succeeded and a whole word came back: a pot that reverts, burns
    /// its gas, has no code or returns something else cannot stop a harvest. On zero the pot is offered
    /// the whole harvest and the fallback beneficiary gets what the pot leaves.
    function _potRoom(uint256 potId) private view returns (uint256 room) {
        bytes memory data = abi.encodeCall(ICrowdPots.remaining, (potId));
        address pots = address(CROWD_POTS);
        uint256 viewGas = POT_VIEW_GAS;
        assembly ("memory-safe") {
            let ok := staticcall(viewGas, pots, add(data, 0x20), mload(data), 0x00, 0x20)
            if and(ok, gt(returndatasize(), 0x1f)) { room := mload(0x00) }
        }
    }

    /// @dev Decides how giving up `amount` of principal is paid.
    ///
    /// Covered: buffered IMD first, then `previewWithdraw` shares for the rest, but only if the shares
    /// left behind still cover the principal left behind. That check is what stops one depositor's
    /// rounding from ever landing on another.
    ///
    /// Otherwise: the same fraction of the buffer and of the shares as `amount` is of the principal,
    /// both rounded down, so those who stay are never worse off for someone leaving.
    function _plan(uint256 principal, uint256 buffered, uint256 shares, uint256 amount, bool inKind)
        private
        view
        returns (Plan memory p)
    {
        p.fromBuffer = Math.min(amount, buffered);
        p.vaultOut = amount - p.fromBuffer;
        p.exact = true;
        if (principal > buffered) {
            uint256 staked = principal - buffered;
            if (p.vaultOut != 0) {
                p.shareCost = SIMD.previewWithdraw(p.vaultOut);
                // IMD cannot leave the vault for no shares; a preview that says so is not to be acted on.
                if (p.shareCost == 0) revert VaultMismatch();
            }
            uint256 keep = staked == p.vaultOut ? 0 : SIMD.previewWithdraw(staked - p.vaultOut);
            p.exact = shares >= p.shareCost + keep;
        }
        if (!p.exact) {
            p.fromBuffer = Math.mulDiv(buffered, amount, principal);
            p.shareCost = Math.mulDiv(shares, amount, principal);
            p.vaultOut = 0;
            if (!inKind && p.shareCost != 0) {
                p.vaultOut = SIMD.previewRedeem(p.shareCost);
                // Shares too few to be worth one IMD-wei stay with the endowment instead of being burned.
                if (p.vaultOut == 0) p.shareCost = 0;
            }
        }
    }

    function _exit(uint256 id, uint256 amount, uint256 minOut, bool inKind)
        private
        returns (uint256 imdOut, uint256 sharesOut)
    {
        if (amount == 0) revert ZeroAmount();
        Endowment storage e = _settle(id);
        uint256 mine = principalOf[id][msg.sender];
        if (amount > mine) revert OverPrincipal(mine);

        uint256 principal = e.principal;
        uint256 buffered = e.pending;
        uint256 shares = e.shares;
        Plan memory p = _plan(principal, buffered, shares, amount, inKind);

        imdOut = p.fromBuffer;
        if (p.shareCost != 0) {
            if (inKind) {
                sharesOut = p.shareCost;
            } else {
                // As in `harvest`: true only in the stake block itself.
                if (block.number <= lastStakeBlock) revert HoldActive();
                imdOut += p.vaultOut;
            }
        }
        uint256 value = imdOut + (sharesOut == 0 ? 0 : SIMD.convertToAssets(sharesOut));
        if (value < minOut) revert BelowMinimum(value, minOut);

        principalOf[id][msg.sender] = mine - amount;
        e.principal = principal - amount;
        if (p.fromBuffer != 0) {
            e.pending = buffered - p.fromBuffer;
            pendingTotal -= p.fromBuffer;
        }
        if (p.shareCost != 0) e.shares = shares - p.shareCost;
        emit Withdrawn(id, msg.sender, amount, imdOut, sharesOut);

        if (sharesOut != 0) {
            IERC20(address(SIMD)).safeTransfer(msg.sender, sharesOut);
        } else if (p.shareCost != 0) {
            _leaveVault(p.exact, p.vaultOut, p.shareCost);
        }
        if (imdOut != 0) IMD.safeTransfer(msg.sender, imdOut);
    }

    /// @dev Takes IMD out of sIMD into this contract: `withdraw` for an exact amount of IMD, `redeem` for
    /// an exact number of shares. Either way at least `assets` IMD must arrive and at most `shares`
    /// shares may go, both by what the vault reports and by what the balances show afterwards. The share
    /// check is what keeps the endowments' shares within what this contract really holds.
    // slither-disable-next-line reentrancy-balance
    function _leaveVault(bool byAssets, uint256 assets, uint256 shares) private {
        uint256 imdBefore = IMD.balanceOf(address(this));
        uint256 sharesBefore = SIMD.balanceOf(address(this));
        bool agrees;
        if (byAssets) {
            agrees = SIMD.withdraw(assets, address(this), address(this)) <= shares;
        } else {
            agrees = SIMD.redeem(shares, address(this), address(this)) >= assets;
        }
        if (
            !agrees || IMD.balanceOf(address(this)) < imdBefore + assets
                || SIMD.balanceOf(address(this)) + shares < sharesBefore
        ) revert VaultMismatch();
    }

    /// @dev Sends harvested IMD on its way. Nothing here can leave IMD stranded in this contract: either
    /// all of `amount` goes out or the whole harvest reverts.
    // slither-disable-next-line reentrancy-balance
    function _forward(uint256 id, Endowment storage e, uint256 amount) private {
        Kind kind = e.kind;
        address beneficiary = e.beneficiary;
        if (kind == Kind.Recipient) {
            IMD.safeTransfer(beneficiary, amount);
            return;
        }

        uint256 before = IMD.balanceOf(address(this));
        if (kind == Kind.Meter) {
            IMD.forceApprove(address(QUESTIONS), amount);
            uint256 meterShares = QUESTIONS.fund(e.target, amount);
            // The meter must have pulled all of it; a remainder would have nowhere to go.
            if (IMD.balanceOf(address(this)) + amount > before) revert TargetMismatch();
            emit MeterFunded(id, e.target, amount, meterShares);
            return;
        }

        if (gasleft() < POT_GAS_FLOOR) revert LowGas();
        IMD.forceApprove(address(CROWD_POTS), amount);
        // A bare call with a fixed gas allowance whose return data is never copied: a pot that reverts,
        // burns its gas, has no code or returns something huge cannot stop the harvest. What the pot
        // took is read from the balance.
        bytes memory data = abi.encodeCall(ICrowdPots.chipInFor, (uint256(e.target), amount, beneficiary));
        address pots = address(CROWD_POTS);
        uint256 potGas = POT_CALL_GAS;
        bool ok;
        assembly ("memory-safe") {
            ok := call(potGas, pots, 0, add(data, 0x20), mload(data), 0, 0)
        }
        uint256 taken = 0;
        if (ok) {
            uint256 left = IMD.balanceOf(address(this));
            if (left < before) taken = before - left;
        }
        // More than was offered could only have come out of the depositors' buffer.
        if (taken > amount) revert TargetMismatch();
        if (taken < amount) {
            uint256 rest = amount - taken;
            IMD.forceApprove(address(CROWD_POTS), 0);
            IMD.safeTransfer(beneficiary, rest);
            emit FallbackPaid(id, beneficiary, rest);
        }
    }

    // forge-lint: disable-end(reentrancy-events)
}
