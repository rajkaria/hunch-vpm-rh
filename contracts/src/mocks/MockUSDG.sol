// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev ERC-1271 smart-wallet signature check.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title  MockUSDG: a test double of Paxos USDG on Robinhood Chain
/// @notice Transfer-exact, 6 decimals, free mint. Reproduces the parts of USDG that HunchVPM
///         and the venue depend on, as verified on chain 4663:
///           * the EIP-712 domain {name "Global Dollar", version "1", chainId,
///             verifyingContract} (USDG has no `eip712Domain()`, so wallets hardcode it);
///           * EIP-3009 `receiveWithAuthorization` in both the `bytes` (0x88b7ab63) and the
///             `(v, r, s)` (0xef55bec6) forms, `transferWithAuthorization` (bytes form),
///             `cancelAuthorization` (bytes form), `authorizationState`, and
///             `CallerMustBePayee` when `to != msg.sender`;
///           * USDG's handling of a used or cancelled nonce, measured on a fork of chain 4663
///             (test/fork/ForkE2E.t.sol): no revert, it emits `AuthorizationAlreadyUsed` and
///             returns without moving funds and without checking the signature or the value.
///             Callers must check `authorizationState` (HunchVPM does, D5);
///           * ERC-1271 signatures for contract signers (the `bytes` form);
///           * Paxos's address freeze and global pause, so tests can show that a frozen
///             winner's claim fails alone and that no state is lost while the token is paused.
///         Errors named as on chain: `InvalidSignature` (0x8baa579f), `CallerMustBePayee`
///         (0x5454b17d). The time-window errors are this mock's own names. `setBrokenPulls`
///         simulates a faulty token (pulls that report success and move nothing), so tests can
///         show that the settler's balance check refuses them.
contract MockUSDG {
    // ERC-20 / EIP-712 metadata keeps its standard lower-case names
    // forge-lint: disable-start(screaming-snake-case-const)
    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    string public constant version = "1";
    uint8 public constant decimals = 6;
    // forge-lint: disable-end(screaming-snake-case-const)

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => bool) public isFrozen;
    bool public paused;
    /// @notice Test control: `transferFrom` and the authorizations report success and move nothing.
    bool public brokenPulls;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    /// @notice Real USDG on chain 4663 does not revert on a used or cancelled authorization: it
    ///         emits this and returns without moving funds or checking the signature (measured
    ///         with test/fork/ForkE2E.t.sol). The mock does the same, so callers must check.
    event AuthorizationAlreadyUsed(address indexed authorizer, bytes32 indexed nonce);

    error InvalidSignature();
    error CallerMustBePayee();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AddressFrozen();
    error TokenPaused();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    // ------------------------------------------------------------------ EIP-712

    /// @notice Recomputed per call, so a test that changes the chain id sees the new domain.
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)
            )
        );
    }

    // ------------------------------------------------------------------ test controls

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Paxos's asset-protection freeze (role-gated on chain; open here).
    function setFrozen(address account, bool frozen) external {
        isFrozen[account] = frozen;
    }

    /// @notice Paxos's global pause (role-gated on chain; open here).
    function setPaused(bool paused_) external {
        paused = paused_;
    }

    /// @notice A faulty token (a hypothetical bad upgrade): pulls report success, move nothing.
    function setBrokenPulls(bool broken) external {
        brokenPulls = broken;
    }

    // ------------------------------------------------------------------ ERC-20

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (isFrozen[msg.sender]) revert AddressFrozen(); // USDG also checks the spender
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        if (brokenPulls) return true;
        _transfer(from, to, amount);
        return true;
    }

    // ------------------------------------------------------------------ EIP-3009

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _authorize(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _authorize(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            abi.encodePacked(r, s, v)
        );
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _authorize(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    /// @notice Burn one of your own unused nonces (EIP-3009). Free, and open to anyone for
    ///         their own authorizations: which is why a used nonce must never book an entry.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        if (authorizationState[authorizer][nonce]) {
            emit AuthorizationAlreadyUsed(authorizer, nonce);
            return;
        }
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        if (!_validSignature(authorizer, digest, signature)) revert InvalidSignature();
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _authorize(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) {
            emit AuthorizationAlreadyUsed(from, nonce); // as USDG: no revert, no transfer, no signature check
            return;
        }
        bytes32 structHash = keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        if (!_validSignature(from, digest, signature)) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        if (brokenPulls) return;
        _transfer(from, to, value);
    }

    function _validSignature(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        // reject malleable (high-s) signatures, as OpenZeppelin's ECDSA does
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    // ------------------------------------------------------------------ internals

    function _transfer(address from, address to, uint256 amount) internal {
        if (paused) revert TokenPaused();
        if (isFrozen[from] || isFrozen[to]) revert AddressFrozen();
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
