//! Which contracts to index, passed as a module parameter rather than baked into the
//! manifest.
//!
//! Nothing is deployed on Arc yet, so a hard-coded address would be a lie that compiles.
//! Parameters also let the same `.spkg` run against testnet and mainnet, and let a
//! developer point a local run at a fork without rebuilding the wasm.
//!
//! Format is query-string style: `vested=0x..&classic=0x..&factory=0x..&resolver=0x..`.
//! Every key is optional; a key left out means that contract is not indexed. An unknown
//! key is an error rather than a silent no-op, because a typo in an address key would
//! otherwise look exactly like a chain with no activity on it.

use crate::pb::hunch_vpm_v1::SettlementRule;

/// A 20-byte EVM address.
pub type Address = [u8; 20];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Contracts {
    /// The vested settler, the mechanism this project is about.
    pub vested: Option<Address>,
    /// The classic settler, deployed alongside it so the two rules can be compared on
    /// the same market. Optional: a deployment may run only the vested rule.
    pub classic: Option<Address>,
    /// MarketFactory, which links a market to its resolution spec atomically.
    pub factory: Option<Address>,
    /// FeedResolver, which resolves from a price feed or voids on a stale one.
    pub resolver: Option<Address>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParamError {
    MissingEquals(String),
    UnknownKey(String),
    BadAddress { key: String, value: String },
    Duplicate(String),
}

impl std::fmt::Display for ParamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParamError::MissingEquals(pair) => {
                write!(f, "parameter {pair:?} is not a key=value pair")
            }
            ParamError::UnknownKey(key) => write!(
                f,
                "unknown parameter key {key:?}; expected one of vested, classic, factory, resolver"
            ),
            ParamError::BadAddress { key, value } => {
                write!(f, "parameter {key}={value:?} is not a 20-byte 0x address")
            }
            ParamError::Duplicate(key) => write!(f, "parameter {key:?} given twice"),
        }
    }
}

impl std::error::Error for ParamError {}

impl Contracts {
    pub fn parse(params: &str) -> Result<Self, ParamError> {
        let mut out = Contracts::default();

        for pair in params.split('&') {
            let pair = pair.trim();
            if pair.is_empty() {
                continue;
            }
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| ParamError::MissingEquals(pair.to_string()))?;
            let key = key.trim();
            let value = value.trim();

            // An empty value means "not deployed yet"; the placeholder zero address in
            // the manifest reaches here as a real address and is treated as one, which
            // is correct: it matches no log, so the module yields nothing.
            let slot = match key {
                "vested" => &mut out.vested,
                "classic" => &mut out.classic,
                "factory" => &mut out.factory,
                "resolver" => &mut out.resolver,
                other => return Err(ParamError::UnknownKey(other.to_string())),
            };
            if slot.is_some() {
                return Err(ParamError::Duplicate(key.to_string()));
            }
            if value.is_empty() {
                continue;
            }
            *slot = Some(parse_address(value).ok_or_else(|| ParamError::BadAddress {
                key: key.to_string(),
                value: value.to_string(),
            })?);
        }

        Ok(out)
    }

    /// Which settlement rule a log from `address` was emitted under, if any.
    pub fn settler_rule(&self, address: &[u8]) -> Option<SettlementRule> {
        if matches(&self.vested, address) {
            Some(SettlementRule::Vested)
        } else if matches(&self.classic, address) {
            Some(SettlementRule::Classic)
        } else {
            None
        }
    }

    pub fn is_factory(&self, address: &[u8]) -> bool {
        matches(&self.factory, address)
    }

    pub fn is_resolver(&self, address: &[u8]) -> bool {
        matches(&self.resolver, address)
    }

    /// True when no contract at all is configured, i.e. the module can only ever be
    /// empty. Callers log this once per block rather than silently producing nothing.
    pub fn is_empty(&self) -> bool {
        self.vested.is_none()
            && self.classic.is_none()
            && self.factory.is_none()
            && self.resolver.is_none()
    }
}

fn matches(slot: &Option<Address>, address: &[u8]) -> bool {
    slot.is_some_and(|want| want == address)
}

fn parse_address(value: &str) -> Option<Address> {
    let hex_part = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))?;
    if hex_part.len() != 40 {
        return None;
    }
    let bytes = hex::decode(hex_part).ok()?;
    bytes.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0x1111111111111111111111111111111111111111";
    const B: &str = "0x2222222222222222222222222222222222222222";

    fn addr(byte: u8) -> Address {
        [byte; 20]
    }

    #[test]
    fn parses_every_key() {
        let got =
            Contracts::parse(&format!("vested={A}&classic={B}&factory={A}&resolver={B}")).unwrap();
        assert_eq!(got.vested, Some(addr(0x11)));
        assert_eq!(got.classic, Some(addr(0x22)));
        assert_eq!(got.factory, Some(addr(0x11)));
        assert_eq!(got.resolver, Some(addr(0x22)));
        assert!(!got.is_empty());
    }

    #[test]
    fn empty_params_index_nothing() {
        let got = Contracts::parse("").unwrap();
        assert_eq!(got, Contracts::default());
        assert!(got.is_empty());
        assert_eq!(got.settler_rule(&addr(0x11)), None);
    }

    #[test]
    fn an_empty_value_leaves_the_slot_unset() {
        let got = Contracts::parse(&format!("vested={A}&classic=")).unwrap();
        assert_eq!(got.vested, Some(addr(0x11)));
        assert_eq!(got.classic, None);
    }

    #[test]
    fn the_placeholder_zero_address_parses_and_matches_nothing_real() {
        let zero = "0x0000000000000000000000000000000000000000";
        let got = Contracts::parse(&format!("vested={zero}")).unwrap();
        assert_eq!(got.vested, Some([0u8; 20]));
        assert_eq!(got.settler_rule(&addr(0x11)), None);
    }

    #[test]
    fn rules_are_assigned_by_emitting_address() {
        let got = Contracts::parse(&format!("vested={A}&classic={B}")).unwrap();
        assert_eq!(got.settler_rule(&addr(0x11)), Some(SettlementRule::Vested));
        assert_eq!(got.settler_rule(&addr(0x22)), Some(SettlementRule::Classic));
        assert_eq!(got.settler_rule(&addr(0x33)), None);
    }

    #[test]
    fn whitespace_and_stray_separators_are_tolerated() {
        let got = Contracts::parse(&format!(" vested = {A} && resolver={B} ")).unwrap();
        assert_eq!(got.vested, Some(addr(0x11)));
        assert_eq!(got.resolver, Some(addr(0x22)));
    }

    #[test]
    fn a_typo_in_a_key_is_an_error_not_a_silent_no_op() {
        let err = Contracts::parse(&format!("vestd={A}")).unwrap_err();
        assert_eq!(err, ParamError::UnknownKey("vestd".into()));
    }

    #[test]
    fn rejects_malformed_addresses() {
        for bad in ["0x1234", "1111111111111111111111111111111111111111", "0xzz"] {
            assert!(
                matches!(
                    Contracts::parse(&format!("vested={bad}")),
                    Err(ParamError::BadAddress { .. })
                ),
                "expected {bad} to be rejected"
            );
        }
    }

    #[test]
    fn rejects_a_pair_without_an_equals() {
        assert_eq!(
            Contracts::parse("vested").unwrap_err(),
            ParamError::MissingEquals("vested".into())
        );
    }

    #[test]
    fn rejects_a_repeated_key() {
        assert_eq!(
            Contracts::parse(&format!("vested={A}&vested={B}")).unwrap_err(),
            ParamError::Duplicate("vested".into())
        );
    }
}
