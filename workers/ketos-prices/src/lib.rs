use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const SCALE: u128 = 100_000_000;
pub const MAX_ASSETS: usize = 12;
pub const MAX_INPUT_BYTES: usize = 1024;
pub const MAX_OUTPUT_BYTES: usize = 900;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;
pub const MAX_SOURCE_AGE_MS: u64 = 120_000;
pub const MAX_FUTURE_SKEW_MS: u64 = 5_000;

pub type Result<T, E = &'static str> = std::result::Result<T, E>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Asset {
    pub symbol: &'static str,
    pub kraken_pair: &'static str,
    kraken_legacy_key: &'static str,
}

// Kraken's request aliases and response keys are not interchangeable with
// exchange-independent symbols (notably BTC/XBT and DOGE/XDG).
pub const SUPPORTED_ASSETS: [Asset; 16] = [
    Asset {
        symbol: "BTC",
        kraken_pair: "XBTUSD",
        kraken_legacy_key: "XXBTZUSD",
    },
    Asset {
        symbol: "ETH",
        kraken_pair: "ETHUSD",
        kraken_legacy_key: "XETHZUSD",
    },
    Asset {
        symbol: "NEAR",
        kraken_pair: "NEARUSD",
        kraken_legacy_key: "NEARUSD",
    },
    Asset {
        symbol: "ZEC",
        kraken_pair: "ZECUSD",
        kraken_legacy_key: "XZECZUSD",
    },
    Asset {
        symbol: "SOL",
        kraken_pair: "SOLUSD",
        kraken_legacy_key: "SOLUSD",
    },
    Asset {
        symbol: "AURORA",
        kraken_pair: "AURORAUSD",
        kraken_legacy_key: "AURORAUSD",
    },
    Asset {
        symbol: "RHEA",
        kraken_pair: "RHEAUSD",
        kraken_legacy_key: "RHEAUSD",
    },
    Asset {
        symbol: "DOGE",
        kraken_pair: "XDGUSD",
        kraken_legacy_key: "XXDGZUSD",
    },
    Asset {
        symbol: "XRP",
        kraken_pair: "XRPUSD",
        kraken_legacy_key: "XXRPZUSD",
    },
    Asset {
        symbol: "LTC",
        kraken_pair: "LTCUSD",
        kraken_legacy_key: "XLTCZUSD",
    },
    Asset {
        symbol: "ADA",
        kraken_pair: "ADAUSD",
        kraken_legacy_key: "ADAUSD",
    },
    Asset {
        symbol: "SUI",
        kraken_pair: "SUIUSD",
        kraken_legacy_key: "SUIUSD",
    },
    Asset {
        symbol: "TRX",
        kraken_pair: "TRXUSD",
        kraken_legacy_key: "TRXUSD",
    },
    Asset {
        symbol: "BNB",
        kraken_pair: "BNBUSD",
        kraken_legacy_key: "BNBUSD",
    },
    Asset {
        symbol: "AVAX",
        kraken_pair: "AVAXUSD",
        kraken_legacy_key: "AVAXUSD",
    },
    Asset {
        symbol: "LINK",
        kraken_pair: "LINKUSD",
        kraken_legacy_key: "LINKUSD",
    },
];

pub const USDT_USD: Asset = Asset {
    symbol: "USDT",
    kraken_pair: "USDTUSD",
    kraken_legacy_key: "USDTZUSD",
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    assets: Vec<String>,
}

pub fn parse_input(bytes: &[u8]) -> Result<Vec<Asset>> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("input exceeds 1024 bytes");
    }
    let input: Input = serde_json::from_slice(bytes).map_err(|_| "invalid input JSON")?;
    if input.assets.is_empty() || input.assets.len() > MAX_ASSETS {
        return Err("assets must contain between 1 and 12 symbols");
    }
    let mut assets = Vec::with_capacity(input.assets.len());
    for symbol in input.assets {
        let asset = SUPPORTED_ASSETS
            .iter()
            .find(|asset| asset.symbol == symbol)
            .copied()
            .ok_or("unsupported asset symbol")?;
        if assets.contains(&asset) {
            return Err("duplicate asset symbol");
        }
        assets.push(asset);
    }
    Ok(assets)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Coinbase,
    Kraken,
    Binance,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Coinbase => "coinbase",
            Self::Kraken => "kraken",
            Self::Binance => "binance",
        }
    }

    pub fn url(self, asset: Asset) -> String {
        match self {
            Self::Coinbase => format!(
                "https://api.exchange.coinbase.com/products/{}-USD/ticker",
                asset.symbol
            ),
            Self::Kraken => format!(
                "https://api.kraken.com/0/public/Ticker?pair={}",
                asset.kraken_pair
            ),
            Self::Binance => format!(
                "https://api.binance.com/api/v3/ticker/price?symbol={}USDT",
                asset.symbol
            ),
        }
    }
}

/// Parse a positive decimal price, scaling by 1e8 and flooring excess fractional
/// digits. Validate every digit, including discarded digits, without using floats.
pub fn parse_price(value: &str) -> Result<u128> {
    if value.is_empty() || value.len() > 128 {
        return Err("invalid price length");
    }
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() => (whole, fraction),
        Some(_) => return Err("invalid decimal price"),
        None => (value, ""),
    };
    if whole.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|c| c.is_ascii_digit())
    {
        return Err("invalid decimal price");
    }
    let mut integer = 0u128;
    for digit in whole.bytes() {
        integer = integer
            .checked_mul(10)
            .and_then(|v| v.checked_add(u128::from(digit - b'0')))
            .ok_or("price overflow")?;
    }
    let mut fractional = 0u128;
    for digit in fraction.bytes().take(8) {
        fractional = fractional * 10 + u128::from(digit - b'0');
    }
    for _ in fraction.len().min(8)..8 {
        fractional *= 10;
    }
    let price = integer
        .checked_mul(SCALE)
        .and_then(|v| v.checked_add(fractional))
        .ok_or("price overflow")?;
    if price == 0 {
        return Err("price rounds to zero");
    }
    Ok(price)
}

#[derive(Deserialize)]
struct CoinbaseTicker {
    price: String,
    time: String,
}

#[derive(Deserialize)]
struct KrakenTicker {
    error: Vec<String>,
    result: BTreeMap<String, KrakenTrade>,
}

#[derive(Deserialize)]
struct KrakenTrade {
    c: Vec<String>,
}

#[derive(Deserialize)]
struct BinanceTicker {
    symbol: String,
    price: String,
}

pub fn parse_source(source: Source, asset: Asset, body: &[u8], now_ms: u64) -> Result<u128> {
    if body.len() > MAX_RESPONSE_BYTES {
        return Err("source response too large");
    }
    match source {
        Source::Coinbase => {
            let ticker: CoinbaseTicker =
                serde_json::from_slice(body).map_err(|_| "invalid Coinbase ticker")?;
            let timestamp = OffsetDateTime::parse(&ticker.time, &Rfc3339)
                .map_err(|_| "invalid Coinbase timestamp")?;
            let source_ms = u64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
                .map_err(|_| "invalid Coinbase timestamp")?;
            if source_ms > now_ms.saturating_add(MAX_FUTURE_SKEW_MS)
                || now_ms.saturating_sub(source_ms) > MAX_SOURCE_AGE_MS
            {
                return Err("Coinbase ticker is stale or in the future");
            }
            parse_price(&ticker.price)
        }
        Source::Kraken => {
            let ticker: KrakenTicker =
                serde_json::from_slice(body).map_err(|_| "invalid Kraken ticker")?;
            if !ticker.error.is_empty() || ticker.result.len() != 1 {
                return Err("Kraken error or unexpected pair count");
            }
            let (key, trade) = ticker
                .result
                .into_iter()
                .next()
                .ok_or("missing Kraken pair")?;
            if key != asset.kraken_pair && key != asset.kraken_legacy_key {
                return Err("unexpected Kraken pair");
            }
            // c = [last closed trade price, lot volume]; never use bid, ask or VWAP.
            if trade.c.len() != 2 {
                return Err("invalid Kraken last trade");
            }
            parse_price(&trade.c[0])
        }
        Source::Binance => {
            let ticker: BinanceTicker =
                serde_json::from_slice(body).map_err(|_| "invalid Binance ticker")?;
            if ticker.symbol.strip_suffix("USDT") != Some(asset.symbol) {
                return Err("unexpected Binance symbol");
            }
            // This result is USDT, not USD. Callers must convert before aggregation.
            parse_price(&ticker.price)
        }
    }
}

pub fn usdt_to_usd(price_usdt: u128, usd_per_usdt: u128) -> Result<u128> {
    if price_usdt == 0 || usd_per_usdt == 0 {
        return Err("zero conversion price");
    }
    let usd = price_usdt
        .checked_mul(usd_per_usdt)
        .ok_or("conversion overflow")?
        / SCALE;
    if usd == 0 {
        return Err("converted price rounds to zero");
    }
    Ok(usd)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Price(pub String, pub Vec<Source>);

/// All supplied venues must agree; never discard an outlier to manufacture quorum.
pub fn aggregate(observations: &[(Source, u128)]) -> Result<Price> {
    if !(2..=3).contains(&observations.len()) {
        return Err("at least two distinct sources are required");
    }
    let mut values = [0u128; 3];
    let mut sources = Vec::with_capacity(observations.len());
    for (index, &(source, price)) in observations.iter().enumerate() {
        if price == 0 || sources.contains(&source) {
            return Err("zero price or duplicate source");
        }
        sources.push(source);
        values[index] = price;
    }
    let values = &mut values[..observations.len()];
    values.sort_unstable();
    let min = values[0];
    let max = values[values.len() - 1];
    // (max - min) * 100 <= min, rearranged to avoid u128 overflow.
    if max - min > min / 100 {
        return Err("source spread exceeds one percent");
    }
    let middle = values.len() / 2;
    let median = if values.len() % 2 == 0 {
        values[middle - 1] + (values[middle] - values[middle - 1]) / 2
    } else {
        values[middle]
    };
    Ok(Price(median.to_string(), sources))
}

/// Fetch the two real USD venues first. Binance is only a missing-venue fallback,
/// never a tiebreaker for disagreement. The fetch callback returns USD prices.
pub fn collect_prices(
    assets: &[Asset],
    mut fetch: impl FnMut(Asset, Source) -> Option<u128>,
) -> BTreeMap<&'static str, Price> {
    let mut prices = BTreeMap::new();
    for &asset in assets {
        let mut observations = Vec::with_capacity(3);
        for source in [Source::Coinbase, Source::Kraken] {
            if let Some(price) = fetch(asset, source).filter(|&price| price > 0) {
                observations.push((source, price));
            }
        }
        if observations.len() == 1 {
            if let Some(price) = fetch(asset, Source::Binance).filter(|&price| price > 0) {
                observations.push((Source::Binance, price));
            }
        }
        if let Ok(price) = aggregate(&observations) {
            prices.insert(asset.symbol, price);
        }
    }
    prices
}

#[derive(Debug, Serialize)]
pub struct Output {
    pub timestamp_ms: u64,
    pub prices: BTreeMap<&'static str, Price>,
}

pub fn encode_output(output: &Output) -> Result<Vec<u8>> {
    let encoded = serde_json::to_vec(output).map_err(|_| "output serialization failed")?;
    if encoded.len() > MAX_OUTPUT_BYTES {
        return Err("output exceeds 900 bytes");
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asset(symbol: &str) -> Asset {
        *SUPPORTED_ASSETS
            .iter()
            .find(|asset| asset.symbol == symbol)
            .unwrap()
    }

    #[test]
    fn validates_explicit_supported_unique_assets() {
        let assets = parse_input(br#"{"assets":["BTC","DOGE","AURORA","RHEA"]}"#).unwrap();
        assert_eq!(assets.len(), 4);
        for input in [
            r#"{}"#,
            r#"null"#,
            r#"{"assets":[]}"#,
            r#"{"assets":["BTC","BTC"]}"#,
            r#"{"assets":["btc"]}"#,
            r#"{"assets":["USDT"]}"#,
            r#"{"assets":["https://evil.test"]}"#,
            r#"{"assets":["BTC"],"url":"https://evil.test"}"#,
            r#"{"assets":[1]}"#,
            r#"{"assets":["BTC"],"assets":["ETH"]}"#,
        ] {
            assert!(parse_input(input.as_bytes()).is_err(), "{input}");
        }
        let twelve = SUPPORTED_ASSETS[..12]
            .iter()
            .map(|a| a.symbol)
            .collect::<Vec<_>>();
        assert_eq!(
            parse_input(&serde_json::to_vec(&json!({"assets": twelve})).unwrap())
                .unwrap()
                .len(),
            12
        );
        let thirteen = SUPPORTED_ASSETS[..13]
            .iter()
            .map(|a| a.symbol)
            .collect::<Vec<_>>();
        assert!(parse_input(&serde_json::to_vec(&json!({"assets": thirteen})).unwrap()).is_err());
        assert!(parse_input(&vec![b' '; MAX_INPUT_BYTES + 1]).is_err());
    }

    #[test]
    fn parses_decimal_integers_and_floors_extra_precision() {
        for (value, expected) in [
            ("1", SCALE),
            ("123.45678901", 12_345_678_901),
            ("0.00000001", 1),
            ("0001.20", 120_000_000),
            ("0.123456789999", 12_345_678),
            ("1.000000009", SCALE),
        ] {
            assert_eq!(parse_price(value), Ok(expected), "{value}");
        }
        let max = format!("{}.{:08}", u128::MAX / SCALE, u128::MAX % SCALE);
        assert_eq!(parse_price(&max), Ok(u128::MAX));
    }

    #[test]
    fn rejects_zero_overflow_and_malformed_decimals() {
        for value in [
            "",
            "0",
            "0.00000000",
            "0.000000001",
            "-1",
            "+1",
            " 1",
            "1 ",
            ".5",
            "1.",
            "1..2",
            "1.00000000x",
            "1e3",
            "NaN",
            "Infinity",
            "１",
            "340282366920938463463374607431768211456",
            "3402823669209384634633746074318",
        ] {
            assert!(parse_price(value).is_err(), "{value}");
        }
        assert!(parse_price(&"1".repeat(129)).is_err());
        let max_plus_one = format!("{}.{:08}", u128::MAX / SCALE, u128::MAX % SCALE + 1);
        assert!(parse_price(&max_plus_one).is_err());
    }

    #[test]
    fn one_percent_threshold_is_inclusive_and_overflow_safe() {
        assert_eq!(
            aggregate(&[(Source::Coinbase, 10_000), (Source::Kraken, 10_100)])
                .unwrap()
                .0,
            "10050"
        );
        assert!(aggregate(&[(Source::Coinbase, 10_000), (Source::Kraken, 10_101)]).is_err());
        assert!(aggregate(&[(Source::Coinbase, 99), (Source::Kraken, 100)]).is_err());
        assert_eq!(
            aggregate(&[
                (Source::Kraken, u128::MAX),
                (Source::Coinbase, u128::MAX - 1)
            ])
            .unwrap()
            .0,
            (u128::MAX - 1).to_string()
        );
    }

    #[test]
    fn median_is_sorted_odd_or_even_and_midpoint_rounds_down() {
        assert_eq!(
            aggregate(&[
                (Source::Binance, 10_080),
                (Source::Coinbase, 10_000),
                (Source::Kraken, 10_030)
            ])
            .unwrap()
            .0,
            "10030"
        );
        assert_eq!(
            aggregate(&[(Source::Kraken, 10_003), (Source::Coinbase, 10_000)])
                .unwrap()
                .0,
            "10001"
        );
        assert!(aggregate(&[
            (Source::Coinbase, 10_000),
            (Source::Kraken, 10_001),
            (Source::Binance, 20_000)
        ])
        .is_err());
    }

    #[test]
    fn quorum_rejects_missing_duplicate_and_zero_sources() {
        assert!(aggregate(&[]).is_err());
        assert!(aggregate(&[(Source::Coinbase, SCALE)]).is_err());
        assert!(aggregate(&[(Source::Coinbase, SCALE), (Source::Coinbase, SCALE)]).is_err());
        assert!(aggregate(&[(Source::Coinbase, 0), (Source::Kraken, 1)]).is_err());
        assert!(aggregate(&[(Source::Coinbase, 1); 4]).is_err());
    }

    #[test]
    fn fallback_only_replaces_missing_venue_and_never_rescues_disagreement() {
        let mut calls = Vec::new();
        let prices = collect_prices(
            &[asset("BTC"), asset("ETH"), asset("NEAR"), asset("DOGE")],
            |asset, source| {
                calls.push((asset.symbol, source));
                match (asset.symbol, source) {
                    ("BTC", Source::Kraken) => None,
                    ("BTC", _) => Some(10_000),
                    ("ETH", Source::Coinbase) => Some(10_000),
                    ("ETH", Source::Kraken) => Some(10_101),
                    ("DOGE", Source::Coinbase) => Some(10_000),
                    _ => None,
                }
            },
        );
        assert_eq!(prices.len(), 1);
        assert_eq!(prices["BTC"].1, vec![Source::Coinbase, Source::Binance]);
        assert!(!calls.contains(&("ETH", Source::Binance)));
        assert!(!calls.contains(&("NEAR", Source::Binance)));
        assert!(calls.contains(&("DOGE", Source::Binance)));
        assert_eq!(calls.len(), 10);
    }

    #[test]
    fn parses_coinbase_timestamp_and_checks_both_freshness_boundaries() {
        let source_ms = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let body = br#"{"price":"12.345","time":"2026-01-01T00:00:00.000Z"}"#;
        assert_eq!(
            parse_source(Source::Coinbase, asset("BTC"), body, source_ms),
            Ok(1_234_500_000)
        );
        assert!(parse_source(
            Source::Coinbase,
            asset("BTC"),
            body,
            source_ms + MAX_SOURCE_AGE_MS
        )
        .is_ok());
        assert!(parse_source(
            Source::Coinbase,
            asset("BTC"),
            body,
            source_ms + MAX_SOURCE_AGE_MS + 1
        )
        .is_err());
        assert!(parse_source(
            Source::Coinbase,
            asset("BTC"),
            body,
            source_ms - MAX_FUTURE_SKEW_MS
        )
        .is_ok());
        assert!(parse_source(
            Source::Coinbase,
            asset("BTC"),
            body,
            source_ms - MAX_FUTURE_SKEW_MS - 1
        )
        .is_err());
        for bad in [
            br#"{"price":"1"}"#.as_slice(),
            br#"{"price":"1","time":"bad"}"#.as_slice(),
            br#"{"price":1,"time":"2026-01-01T00:00:00Z"}"#.as_slice(),
            br#"{"price":"1","time":"1969-01-01T00:00:00Z"}"#.as_slice(),
        ] {
            assert!(parse_source(Source::Coinbase, asset("BTC"), bad, source_ms).is_err());
        }
    }

    #[test]
    fn parses_kraken_fixed_pair_aliases_and_rejects_api_errors() {
        for (symbol, key) in [
            ("BTC", "XXBTZUSD"),
            ("ETH", "XETHZUSD"),
            ("DOGE", "XDGUSD"),
            ("DOGE", "XXDGZUSD"),
            ("LTC", "XLTCZUSD"),
        ] {
            let body = serde_json::to_vec(
                &json!({"error": [], "result": {key: {"c": ["2.125", "1"], "a": ["999"]}}}),
            )
            .unwrap();
            assert_eq!(
                parse_source(Source::Kraken, asset(symbol), &body, 0),
                Ok(212_500_000)
            );
        }
        for bad in [
            r#"{"error":["EQuery:Unknown asset pair"],"result":{}}"#,
            r#"{"error":[],"result":{}}"#,
            r#"{"error":[],"result":{"ETHUSD":{"c":["1","1"]}}}"#,
            r#"{"error":[],"result":{"XXBTZUSD":{"c":[]}}}"#,
            r#"{"error":[],"result":{"XXBTZUSD":{"c":["1"]}}}"#,
            r#"{"error":[],"result":{"XXBTZUSD":{"c":["0","1"]}}}"#,
            r#"{"error":[],"result":{"XXBTZUSD":{"c":["1","1"]},"XBTUSD":{"c":["1","1"]}}}"#,
            r#"{"result":{"XXBTZUSD":{"c":["1","1"]}}}"#,
        ] {
            assert!(
                parse_source(Source::Kraken, asset("BTC"), bad.as_bytes(), 0).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn parses_binance_and_converts_usdt_instead_of_assuming_peg() {
        let body = br#"{"symbol":"TRXUSDT","price":"0.12345678"}"#;
        let raw = parse_source(Source::Binance, asset("TRX"), body, 0).unwrap();
        assert_eq!(raw, 12_345_678);
        assert_eq!(usdt_to_usd(raw, 99_000_000), Ok(12_222_221));
        assert!(parse_source(Source::Binance, asset("BTC"), body, 0).is_err());
        assert!(parse_source(
            Source::Binance,
            asset("BTC"),
            br#"{"code":-1121,"msg":"Invalid symbol."}"#,
            0
        )
        .is_err());
        assert!(usdt_to_usd(u128::MAX, 2).is_err());
        assert!(usdt_to_usd(0, SCALE).is_err());
        assert!(usdt_to_usd(SCALE, 0).is_err());
        assert!(usdt_to_usd(1, 1).is_err());
        let fx = br#"{"error":[],"result":{"USDTZUSD":{"c":["0.99","1"]}}}"#;
        assert_eq!(
            parse_source(Source::Kraken, USDT_USD, fx, 0),
            Ok(99_000_000)
        );
    }

    #[test]
    fn fails_oversized_output_instead_of_truncating_json() {
        let mut prices = BTreeMap::new();
        for asset in &SUPPORTED_ASSETS[..12] {
            prices.insert(
                asset.symbol,
                Price(
                    u128::MAX.to_string(),
                    vec![Source::Coinbase, Source::Kraken],
                ),
            );
        }
        let output = Output {
            timestamp_ms: u64::MAX,
            prices,
        };
        assert!(serde_json::to_vec(&output).unwrap().len() > MAX_OUTPUT_BYTES);
        assert_eq!(encode_output(&output), Err("output exceeds 900 bytes"));
    }
}
