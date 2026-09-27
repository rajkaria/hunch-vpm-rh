// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Tiny JSON builder for the fixtures the TypeScript side imports. Every integer is
///         written as a decimal STRING (amounts exceed 2^53, and accumulators exceed 2^64),
///         so JavaScript reads them with BigInt and never loses a unit.
library Json {
    function quote(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    function num(uint256 v) internal pure returns (string memory) {
        return quote(dec(v));
    }

    function str(string memory key, string memory value) internal pure returns (string memory) {
        return string.concat(quote(key), ":", quote(value));
    }

    function uintField(string memory key, uint256 value) internal pure returns (string memory) {
        return string.concat(quote(key), ":", num(value));
    }

    function raw(string memory key, string memory json) internal pure returns (string memory) {
        return string.concat(quote(key), ":", json);
    }

    function obj(string[] memory fields) internal pure returns (string memory) {
        return string.concat("{", join(fields), "}");
    }

    function arr(string[] memory items) internal pure returns (string memory) {
        return string.concat("[", join(items), "]");
    }

    function join(string[] memory parts) internal pure returns (string memory out) {
        for (uint256 i = 0; i < parts.length; i++) {
            out = i == 0 ? parts[i] : string.concat(out, ",", parts[i]);
        }
    }

    function dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) {
            digits++;
        }
        bytes memory b = new bytes(digits);
        for (uint256 i = digits; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    /// @dev `v / 10^decimals` as a fixed-point decimal string, truncated (never rounded up).
    function fixedPoint(uint256 v, uint256 decimals) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        string memory frac = dec(v % unit);
        while (bytes(frac).length < decimals) frac = string.concat("0", frac);
        return decimals == 0 ? dec(v / unit) : string.concat(dec(v / unit), ".", frac);
    }
}
