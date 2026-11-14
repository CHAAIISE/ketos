use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[cfg(test)]
mod tests_bitstamp;

pub const SCALE: u128 = 100_000_000;
pub const MAX_ASSETS: usize = 12;
pub const MAX_INPUT_BYTES: usize = 1024;
pub const MAX_OUTPUT_BYTES: usize = 900;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;
pub const PRICE_DOMAIN: &str = "ketos:prices:v1";
pub const MAX_SIGNED_PAYLOAD_BYTES: usize = 3072;
pub const MAX_SIGNED_OUTPUT_BYTES: usize = 4096;
pub const MAX_SOURCE_AGE_MS: u64 = 120_000;
/// Leaves delivery and inclusion time inside the contract's 15-second signed-price window.
pub const MAX_COLLECTION_AGE_MS: u64 = 8_000;
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
pub const SUPPORTED_ASSETS: [Asset; 21] = [
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
    Asset {
        symbol: "UNI",
        kraken_pair: "UNIUSD",
        kraken_legacy_key: "UNIUSD",
    },
    Asset {
        symbol: "AAVE",
        kraken_pair: "AAVEUSD",
        kraken_legacy_key: "AAVEUSD",
    },
    Asset {
        symbol: "BCH",
        kraken_pair: "BCHUSD",
        kraken_legacy_key: "BCHUSD",
    },
    Asset {
        symbol: "APT",
        kraken_pair: "APTUSD",
        kraken_legacy_key: "APTUSD",
    },
    Asset {
        symbol: "ARB",
        kraken_pair: "ARBUSD",
        kraken_legacy_key: "ARBUSD",
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

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum CommandInput {
    SignedPrices { assets: Vec<String> },
    GetPublicKey {},
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireInput {
    Unsigned(Input),
    Command(CommandInput),
}

#[derive(Debug, Eq, PartialEq)]
pub enum Request {
    Unsigned(Vec<Asset>),
    SignedPrices(Vec<Asset>),
    GetPublicKey,
}

pub fn parse_request(bytes: &[u8]) -> Result<Request> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("input exceeds 1024 bytes");
    }
    match serde_json::from_slice(bytes).map_err(|_| "invalid input JSON")? {
        WireInput::Unsigned(input) => validate_assets(input.assets).map(Request::Unsigned),
        WireInput::Command(CommandInput::SignedPrices { assets }) => {
            validate_assets(assets).map(Request::SignedPrices)
        }
        WireInput::Command(CommandInput::GetPublicKey {}) => Ok(Request::GetPublicKey),
    }
}

pub fn parse_input(bytes: &[u8]) -> Result<Vec<Asset>> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("input exceeds 1024 bytes");
    }
    let input: Input = serde_json::from_slice(bytes).map_err(|_| "invalid input JSON")?;
    validate_assets(input.assets)
}

fn validate_assets(symbols: Vec<String>) -> Result<Vec<Asset>> {
    if symbols.is_empty() || symbols.len() > MAX_ASSETS {
        return Err("assets must contain between 1 and 12 symbols");
    }
    let mut assets = Vec::with_capacity(symbols.len());
    for symbol in symbols {
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
    Bitstamp,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Coinbase => "coinbase",
            Self::Kraken => "kraken",
            Self::Binance => "binance",
            Self::Bitstamp => "bitstamp",
        }
    }

    pub fn url(self, asset: Asset) -> String {
        match self {
            Self::Coinbase => format!(
                "https://api.exchange.coinbase.com/products/{}-USD/book?level=1",
                asset.symbol
            ),
            Self::Kraken => format!(
                "https://api.kraken.com/0/public/Trades?pair={}&count=1",
                asset.kraken_pair
            ),
            Self::Binance => format!(
                "https://api.binance.com/api/v3/trades?symbol={}USDT&limit=1",
                asset.symbol
            ),
            Self::Bitstamp => format!(
                "https://www.bitstamp.net/api/v2/ticker/{}usd/",
                asset.symbol.to_ascii_lowercase()
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
struct CoinbaseBook {
    bids: [(String, String, u64); 1],
    asks: [(String, String, u64); 1],
    auction_mode: bool,
    time: String,
}

#[derive(Deserialize)]
struct KrakenTrades {
    error: Vec<String>,
    result: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct BinanceTrade {
    price: String,
    time: u64,
}

#[derive(Deserialize)]
struct BitstampTicker {
    bid: String,
    ask: String,
    timestamp: String,
    market_type: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Observation {
    pub price: u128,
    pub timestamp_ms: u64,
}

fn observation(price: u128, timestamp_ms: u64, now_ms: u64) -> Result<Observation> {
    if timestamp_ms == 0 || timestamp_ms > now_ms.saturating_add(MAX_FUTURE_SKEW_MS)
        || now_ms.saturating_sub(timestamp_ms) > MAX_SOURCE_AGE_MS
    {
        return Err("source trade is stale or in the future");
    }
    Ok(Observation { price, timestamp_ms })
}

pub fn parse_source(source: Source, asset: Asset, body: &[u8], now_ms: u64) -> Result<Observation> {
    if body.len() > MAX_RESPONSE_BYTES {
        return Err("source response too large");
    }
    match source {
        Source::Coinbase => {
            let book: CoinbaseBook =
                serde_json::from_slice(body).map_err(|_| "invalid Coinbase L1 book")?;
            if book.auction_mode || book.bids[0].2 == 0 || book.asks[0].2 == 0 {
                return Err("Coinbase book is indicative or has no orders");
            }
            parse_price(&book.bids[0].1)?;
            parse_price(&book.asks[0].1)?;
            let bid = parse_price(&book.bids[0].0)?;
            let ask = parse_price(&book.asks[0].0)?;
            if ask < bid || ask - bid > bid / 100 {
                return Err("Coinbase book is crossed or spread exceeds one percent");
            }
            let timestamp = OffsetDateTime::parse(&book.time, &Rfc3339)
                .map_err(|_| "invalid Coinbase timestamp")?;
            let source_ms = u64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
                .map_err(|_| "invalid Coinbase timestamp")?;
            observation(bid + (ask - bid) / 2, source_ms, now_ms)
        }
        Source::Kraken => {
            let mut trades: KrakenTrades =
                serde_json::from_slice(body).map_err(|_| "invalid Kraken trades")?;
            trades.result.remove("last");
            if !trades.error.is_empty() || trades.result.len() != 1 {
                return Err("Kraken error or unexpected pair count");
            }
            let (key, value) = trades.result.into_iter().next().ok_or("missing Kraken pair")?;
            if key != asset.kraken_pair && key != asset.kraken_legacy_key {
                return Err("unexpected Kraken pair");
            }
            let rows = value.as_array().ok_or("invalid Kraken trades")?;
            if rows.len() != 1 { return Err("unexpected Kraken trade count"); }
            let trade = rows[0].as_array().ok_or("invalid Kraken trade")?;
            let price = trade.first().and_then(|v| v.as_str()).ok_or("missing Kraken price")?;
            let seconds = trade.get(2).and_then(|v| v.as_f64()).ok_or("missing Kraken trade time")?;
            if !seconds.is_finite() || seconds <= 0.0 || seconds * 1000.0 >= u64::MAX as f64 {
                return Err("invalid Kraken trade time");
            }
            observation(parse_price(price)?, (seconds * 1000.0).floor() as u64, now_ms)
        }
        Source::Binance => {
            // Identity is bound to the fixed requested symbol URL; this API returns no symbol.
            let trades: Vec<BinanceTrade> =
                serde_json::from_slice(body).map_err(|_| "invalid Binance trades")?;
            if trades.len() != 1 { return Err("unexpected Binance trade count"); }
            observation(parse_price(&trades[0].price)?, trades[0].time, now_ms)
        }
        Source::Bitstamp => {
            let ticker: BitstampTicker =
                serde_json::from_slice(body).map_err(|_| "invalid Bitstamp ticker")?;
            if ticker.market_type != "SPOT" {
                return Err("Bitstamp market is not spot");
            }
            let bid = parse_price(&ticker.bid)?;
            let ask = parse_price(&ticker.ask)?;
            if ask < bid || ask - bid > bid / 100 {
                return Err("Bitstamp book is crossed or spread exceeds one percent");
            }
            if ticker.timestamp.is_empty() || !ticker.timestamp.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("invalid Bitstamp timestamp");
            }
            let timestamp_ms = ticker.timestamp.parse::<u64>().ok()
                .and_then(|seconds| seconds.checked_mul(1_000))
                .ok_or("invalid Bitstamp timestamp")?;
            // Timestamp belongs to the venue's bid/ask snapshot, not its last trade.
            observation(bid + (ask - bid) / 2, timestamp_ms, now_ms)
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
pub struct Price(pub String, pub Vec<Source>, #[serde(skip)] pub u64);

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
    Ok(Price(median.to_string(), sources, 0))
}

/// Fetch a USD book and trade venue first, then a timestamped USD quote if one is missing.
/// Converted Binance is the final missing-venue fallback, never a disagreement tiebreaker.
pub fn collect_prices(
    assets: &[Asset],
    mut now_ms: impl FnMut() -> u64,
    mut fetch: impl FnMut(Asset, Source) -> Option<Observation>,
) -> BTreeMap<&'static str, Price> {
    let mut prices = BTreeMap::new();
    let fresh = |price: &Observation, now: u64| {
        price.price > 0 && price.timestamp_ms > 0 && price.timestamp_ms <= now
            && now - price.timestamp_ms <= MAX_COLLECTION_AGE_MS
    };
    for &asset in assets {
        let mut observations = Vec::with_capacity(3);
        for source in [Source::Coinbase, Source::Kraken] {
            if let Some(price) = fetch(asset, source).filter(|price| fresh(price, now_ms())) {
                observations.push((source, price));
            }
        }
        let observed_at = now_ms();
        observations.retain(|(_, price)| fresh(price, observed_at));
        if observations.len() == 1 {
            for source in [Source::Bitstamp, Source::Binance] {
                if let Some(price) = fetch(asset, source).filter(|price| fresh(price, now_ms())) {
                    observations.push((source, price));
                    break;
                }
            }
        }
        let completed_at = now_ms();
        observations.retain(|(_, price)| fresh(price, completed_at));
        let values: [(Source, u128); 3] = std::array::from_fn(|i| {
            observations.get(i).map(|(source, value)| (*source, value.price)).unwrap_or((Source::Coinbase, 0))
        });
        if let Ok(mut price) = aggregate(&values[..observations.len()]) {
            price.2 = observations.iter().map(|(_, value)| value.timestamp_ms).min().unwrap_or(0);
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

#[derive(Debug, Serialize)]
struct SignedPrice<'a> {
    price: &'a str,
    publish_time: u64,
    sources: &'a [Source],
}

#[derive(Serialize)]
struct PricesPayload<'a> {
    domain: &'static str,
    prices: BTreeMap<&'static str, SignedPrice<'a>>,
}

/// Sign the oldest contributing observation time, including conversion legs.
pub fn encode_prices_payload(output: &Output) -> Result<String> {
    if output.prices.len() > MAX_ASSETS {
        return Err("signed prices exceed 12 assets");
    }
    let mut prices = BTreeMap::new();
    for (&symbol, Price(price, sources, timestamp_ms)) in &output.prices {
        if !SUPPORTED_ASSETS.iter().any(|asset| asset.symbol == symbol) {
            return Err("unsupported signed asset");
        }
        let value = price.parse::<u128>().map_err(|_| "invalid signed price")?;
        if value == 0 || price.bytes().any(|byte| !byte.is_ascii_digit()) {
            return Err("invalid signed price");
        }
        if *timestamp_ms == 0 || !(2..=3).contains(&sources.len())
            || sources.iter().enumerate().any(|(i, source)| sources[..i].contains(source))
        {
            return Err("signed prices require distinct source quorum");
        }
        prices.insert(symbol, SignedPrice {
            price,
            publish_time: timestamp_ms / 1000,
            sources,
        });
    }
    let payload = serde_json::to_string(&PricesPayload { domain: PRICE_DOMAIN, prices })
        .map_err(|_| "signed payload serialization failed")?;
    if payload.len() > MAX_SIGNED_PAYLOAD_BYTES {
        return Err("signed payload exceeds 3072 bytes");
    }
    Ok(payload)
}

#[derive(Debug, Serialize)]
pub struct SignedPrices {
    pub payload: String,
    pub signature: String,
    pub public_key: String,
}

pub fn encode_signed_output(envelope: &SignedPrices) -> Result<Vec<u8>> {
    let encoded = serde_json::to_vec(envelope).map_err(|_| "signed output serialization failed")?;
    if encoded.len() > MAX_SIGNED_OUTPUT_BYTES {
        return Err("signed output exceeds 4096 bytes");
    }
    Ok(encoded)
}

// Actual signing is available only inside the WASI worker. Native compilation
// enables it solely for deterministic test vectors, never for live prices.
#[cfg(any(test, all(target_arch = "wasm32", target_os = "wasi", target_env = "p2")))]
mod signing {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use zeroize::Zeroizing;

    pub struct ProtectedPriceSigner(SigningKey);

    impl ProtectedPriceSigner {
        /// OutLayer's ed25519_seed generation type is exactly 32 hex bytes.
        /// Reject other encodings without ever including secret data in errors.
        pub fn from_protected_seed(encoded: &str) -> Result<Self> {
            if encoded.len() != 64 || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("invalid protected price seed");
            }
            let mut seed = Zeroizing::new([0u8; 32]);
            for (i, byte) in seed.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&encoded[i * 2..i * 2 + 2], 16)
                    .map_err(|_| "invalid protected price seed")?;
            }
            Ok(Self(SigningKey::from_bytes(&seed)))
        }

        pub fn public_key(&self) -> String {
            format!("ed25519:{}", bs58::encode(self.0.verifying_key().as_bytes()).into_string())
        }

        pub fn sign_prices(&self, output: &Output) -> Result<SignedPrices> {
            let payload = encode_prices_payload(output)?;
            let signature = STANDARD.encode(self.0.sign(payload.as_bytes()).to_bytes());
            Ok(SignedPrices { payload, signature, public_key: self.public_key() })
        }
    }
}

#[cfg(any(test, all(target_arch = "wasm32", target_os = "wasi", target_env = "p2")))]
pub use signing::ProtectedPriceSigner;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signed_commands_are_bounded_and_never_accept_caller_payloads() {
        assert_eq!(
            parse_request(br#"{"assets":["ETH"]}"#),
            Ok(Request::Unsigned(vec![asset("ETH")]))
        );
        assert_eq!(
            parse_request(br#"{"command":"signed_prices","assets":["ETH","BTC"]}"#),
            Ok(Request::SignedPrices(vec![asset("ETH"), asset("BTC")]))
        );
        assert_eq!(
            parse_request(br#"{"command":"get_public_key"}"#),
            Ok(Request::GetPublicKey)
        );
        for invalid in [
            r#"{"command":"sign","payload":"arbitrary"}"#,
            r#"{"command":"signed_prices","assets":["ETH"],"payload":"arbitrary"}"#,
            r#"{"command":"signed_prices","assets":["ETH"],"publish_time":1}"#,
            r#"{"command":"signed_prices","assets":[]}"#,
            r#"{"command":"signed_prices","assets":["ETH","ETH"]}"#,
            r#"{"command":"signed_prices","assets":["usdt"]}"#,
            r#"{"command":"get_public_key","assets":["ETH"]}"#,
            r#"{"command":"get_public_key","secret":"other"}"#,
            r#"{"command":null,"assets":["ETH"]}"#,
        ] {
            assert!(parse_request(invalid.as_bytes()).is_err(), "{invalid}");
        }
        for count in [12, 13] {
            let symbols: Vec<_> = SUPPORTED_ASSETS[..count].iter().map(|a| a.symbol).collect();
            let input = serde_json::to_vec(&json!({
                "command": "signed_prices", "assets": symbols,
            })).unwrap();
            assert_eq!(parse_request(&input).is_ok(), count == MAX_ASSETS);
        }
        let mut oversized = br#"{"command":"get_public_key"}"#.to_vec();
        oversized.resize(MAX_INPUT_BYTES + 1, b' ');
        assert_eq!(parse_request(&oversized), Err("input exceeds 1024 bytes"));
    }

    fn signed_fixture() -> Output {
        Output {
            timestamp_ms: 1_790_000_000_999,
            prices: BTreeMap::from([
                ("ETH", Price("12300000000".to_string(), vec![Source::Coinbase, Source::Kraken], 1_790_000_000_999)),
                ("BTC", Price("45600000000".to_string(), vec![Source::Kraken, Source::Binance], 1_790_000_000_999)),
            ]),
        }
    }

    #[test]
    fn signed_payload_is_exact_utf8_sorted_json_with_original_seconds_and_sources() {
        assert_eq!(
            encode_prices_payload(&signed_fixture()).unwrap(),
            r#"{"domain":"ketos:prices:v1","prices":{"BTC":{"price":"45600000000","publish_time":1790000000,"sources":["kraken","binance"]},"ETH":{"price":"12300000000","publish_time":1790000000,"sources":["coinbase","kraken"]}}}"#
        );
        let output = Output { timestamp_ms: 1_790_000_000_999, prices: BTreeMap::new() };
        assert_eq!(
            encode_prices_payload(&output).unwrap(),
            r#"{"domain":"ketos:prices:v1","prices":{}}"#
        );
    }

    #[test]
    fn signed_payload_rejects_invalid_prices_sources_and_symbols() {
        for price in ["0", "-1", "+1", "1.2", "1e8", " 1", "340282366920938463463374607431768211456"] {
            let mut output = signed_fixture();
            output.prices.get_mut("ETH").unwrap().0 = price.to_string();
            assert!(encode_prices_payload(&output).is_err(), "{price}");
        }
        for sources in [
            vec![],
            vec![Source::Coinbase],
            vec![Source::Coinbase, Source::Coinbase],
            vec![Source::Coinbase, Source::Kraken, Source::Binance, Source::Kraken],
        ] {
            let mut output = signed_fixture();
            output.prices.get_mut("ETH").unwrap().1 = sources;
            assert!(encode_prices_payload(&output).is_err());
        }
        let mut output = signed_fixture();
        output.prices.insert("USDT", Price("1".to_string(), vec![Source::Coinbase, Source::Kraken], 1));
        assert_eq!(encode_prices_payload(&output), Err("unsupported signed asset"));
        output.prices = SUPPORTED_ASSETS[..13].iter().map(|asset| (
            asset.symbol, Price("1".to_string(), vec![Source::Coinbase, Source::Kraken], 1)
        )).collect();
        assert_eq!(encode_prices_payload(&output), Err("signed prices exceed 12 assets"));
    }

    #[test]
    fn twelve_maximum_prices_and_three_sources_fit_signed_wire_bounds() {
        let output = Output {
            timestamp_ms: u64::MAX,
            prices: SUPPORTED_ASSETS[..MAX_ASSETS].iter().map(|asset| (
                asset.symbol,
                Price(u128::MAX.to_string(), vec![Source::Coinbase, Source::Kraken, Source::Binance], u64::MAX),
            )).collect(),
        };
        let payload = encode_prices_payload(&output).unwrap();
        assert!(payload.len() <= MAX_SIGNED_PAYLOAD_BYTES);
        let envelope = SignedPrices {
            payload,
            signature: "A".repeat(86) + "==",
            public_key: "ed25519:".to_string() + &"1".repeat(44),
        };
        assert!(encode_signed_output(&envelope).unwrap().len() <= MAX_SIGNED_OUTPUT_BYTES);
        let oversized = SignedPrices { payload: "x".repeat(MAX_SIGNED_OUTPUT_BYTES), ..envelope };
        assert_eq!(encode_signed_output(&oversized), Err("signed output exceeds 4096 bytes"));
    }

    #[test]
    fn deterministic_test_seed_signs_exact_payload_and_tampering_fails() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use ed25519_dalek::{Signature, VerifyingKey};

        // Public RFC 8032 test vector, never a key used for live prices.
        let signer = ProtectedPriceSigner::from_protected_seed(
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        ).unwrap();
        let expected_public = [
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
            0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
            0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
            0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
        ];
        let output = signed_fixture();
        let envelope = signer.sign_prices(&output).unwrap();
        let public_bytes = bs58::decode(envelope.public_key.strip_prefix("ed25519:").unwrap())
            .into_vec().unwrap();
        assert_eq!(public_bytes, expected_public);
        assert_eq!(envelope.payload, encode_prices_payload(&output).unwrap());
        let signature_bytes = STANDARD.decode(&envelope.signature).unwrap();
        assert_eq!(signature_bytes.len(), 64);
        assert_eq!(envelope.signature.len(), 88);
        assert!(envelope.signature.ends_with("=="));
        let signature = Signature::from_slice(&signature_bytes).unwrap();
        let public = VerifyingKey::from_bytes(&expected_public).unwrap();
        public.verify_strict(envelope.payload.as_bytes(), &signature).unwrap();
        for tampered in [
            envelope.payload.replace("ketos:prices:v1", "ketos:prices:v2"),
            envelope.payload.replace("12300000000", "12300000001"),
            envelope.payload.replace("1790000000", "1790000001"),
            envelope.payload.replace("coinbase", "binance"),
        ] {
            assert!(public.verify_strict(tampered.as_bytes(), &signature).is_err());
        }
        assert_eq!(signer.sign_prices(&output).unwrap().signature, envelope.signature);
        let encoded: serde_json::Value = serde_json::from_slice(&encode_signed_output(&envelope).unwrap()).unwrap();
        assert_eq!(encoded.as_object().unwrap().len(), 3);
        assert_eq!(encoded["payload"], envelope.payload);
    }

    #[test]
    fn protected_seed_accepts_only_exact_hex32_without_echoing_input() {
        for invalid in ["", "abc", &"0".repeat(63), &"0".repeat(65), &"z".repeat(64), &"é".repeat(32)] {
            assert!(matches!(
                ProtectedPriceSigner::from_protected_seed(invalid),
                Err("invalid protected price seed")
            ));
        }
    }

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
            || 2,
            |asset, source| {
                calls.push((asset.symbol, source));
                match (asset.symbol, source) {
                    ("BTC", Source::Kraken) => None,
                    ("BTC", _) => Some(Observation { price: 10_000, timestamp_ms: 1 }),
                    ("ETH", Source::Coinbase) => Some(Observation { price: 10_000, timestamp_ms: 1 }),
                    ("ETH", Source::Kraken) => Some(Observation { price: 10_101, timestamp_ms: 2 }),
                    ("DOGE", Source::Coinbase) => Some(Observation { price: 10_000, timestamp_ms: 1 }),
                    _ => None,
                }
            },
        );
        assert_eq!(prices.len(), 1);
        assert_eq!(prices["BTC"].1, vec![Source::Coinbase, Source::Bitstamp]);
        assert!(!prices.contains_key("ETH"));
        assert!(!prices.contains_key("NEAR"));
        assert!(!prices.contains_key("DOGE"));
        assert!(!calls.contains(&("ETH", Source::Bitstamp)));
        assert!(!calls.contains(&("ETH", Source::Binance)));
        assert!(!calls.contains(&("NEAR", Source::Bitstamp)));
        assert!(calls.contains(&("DOGE", Source::Binance)));
    }

    #[test]
    fn parses_coinbase_timestamp_and_checks_both_freshness_boundaries() {
        let source_ms = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let body = br#"{"bids":[["12.34","1",1]],"asks":[["12.35","1",1]],"auction_mode":false,"time":"2026-01-01T00:00:00.000Z"}"#;
        assert_eq!(
            parse_source(Source::Coinbase, asset("BTC"), body, source_ms),
            Ok(Observation { price: 1_234_500_000, timestamp_ms: source_ms })
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
        for time in [serde_json::Value::Null, serde_json::json!("bad"), serde_json::json!("1969-01-01T00:00:00Z")] {
            let mut bad: serde_json::Value = serde_json::from_slice(body).unwrap();
            bad["time"] = time;
            assert!(parse_source(Source::Coinbase, asset("BTC"), &serde_json::to_vec(&bad).unwrap(), source_ms).is_err());
        }
    }

    #[test]
    fn coinbase_book_rejects_indicative_empty_crossed_and_wide_quotes() {
        let now = 1_767_225_600_000;
        let valid = serde_json::json!({
            "bids": [["100", "1", 1]], "asks": [["101", "1", 1]],
            "auction_mode": false, "time": "2026-01-01T00:00:00Z",
        });
        assert_eq!(
            parse_source(Source::Coinbase, asset("BCH"), &serde_json::to_vec(&valid).unwrap(), now),
            Ok(Observation { price: 10_050_000_000, timestamp_ms: now }),
        );
        for (pointer, replacement) in [
            ("/auction_mode", serde_json::json!(true)),
            ("/bids", serde_json::json!([])),
            ("/asks", serde_json::json!([["101", "1", 1], ["102", "1", 1]])),
            ("/asks/0/0", serde_json::json!("99")),
            ("/asks/0/0", serde_json::json!("101.00000001")),
            ("/bids/0/0", serde_json::json!("0")),
            ("/asks/0/1", serde_json::json!("0")),
            ("/bids/0/2", serde_json::json!(0)),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert!(parse_source(Source::Coinbase, asset("BCH"), &serde_json::to_vec(&invalid).unwrap(), now).is_err());
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
                &json!({"error": [], "result": {key: [["2.125", "1", 1767225600.125, "b", "m", "", 1]], "last": "1767225600125000000"}}),
            )
            .unwrap();
            assert_eq!(
                parse_source(Source::Kraken, asset(symbol), &body, 1_767_225_600_125),
                Ok(Observation { price: 212_500_000, timestamp_ms: 1_767_225_600_125 })
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
        let body = br#"[{"price":"0.12345678","time":1767225600000}]"#;
        let raw = parse_source(Source::Binance, asset("TRX"), body, 1_767_225_600_000).unwrap();
        assert_eq!(raw.price, 12_345_678);
        assert_eq!(usdt_to_usd(raw.price, 99_000_000), Ok(12_222_221));
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
        let fx = br#"{"error":[],"result":{"USDTZUSD":[["0.99","1",1767225600,"b","m","",1]],"last":"1767225600000000000"}}"#;
        assert_eq!(
            parse_source(Source::Kraken, USDT_USD, fx, 1_767_225_600_000),
            Ok(Observation { price: 99_000_000, timestamp_ms: 1_767_225_600_000 })
        );
    }

    #[test]
    fn signed_time_is_oldest_contributor_per_asset_not_execution_time() {
        let prices = collect_prices(&[asset("BTC"), asset("ETH")], || 1_790_000_009_999, |asset, source| {
            Some(Observation {
                price: SCALE,
                timestamp_ms: match (asset.symbol, source) {
                    ("BTC", Source::Coinbase) => 1_790_000_003_999,
                    ("BTC", _) => 1_790_000_001_999,
                    ("ETH", Source::Coinbase) => 1_790_000_005_999,
                    _ => 1_790_000_004_999,
                },
            })
        });
        let output = Output { timestamp_ms: 1_790_000_009_999, prices };
        let payload: serde_json::Value = serde_json::from_str(&encode_prices_payload(&output).unwrap()).unwrap();
        assert_eq!(payload["prices"]["BTC"]["publish_time"], 1_790_000_001u64);
        assert_eq!(payload["prices"]["ETH"]["publish_time"], 1_790_000_004u64);
    }

    #[test]
    fn stale_primary_is_replaced_before_quorum_instead_of_poisoning_the_asset() {
        let now = 100_000;
        let prices = collect_prices(&[asset("BTC")], || now, |_, source| Some(Observation {
            price: SCALE,
            timestamp_ms: match source {
                Source::Coinbase => now - MAX_COLLECTION_AGE_MS - 1,
                Source::Kraken => now - 2_000,
                Source::Bitstamp | Source::Binance => now - 1_000,
            },
        }));
        assert_eq!(prices["BTC"].0, SCALE.to_string());
        assert_eq!(prices["BTC"].1, vec![Source::Kraken, Source::Bitstamp]);
        assert_eq!(prices["BTC"].2, now - 2_000);
    }

    #[test]
    fn slow_fallback_cannot_leave_an_expired_primary_in_the_quorum() {
        let clock = std::cell::Cell::new(100_000);
        let prices = collect_prices(&[asset("BTC")], || clock.get(), |_, source| match source {
            Source::Coinbase => Some(Observation { price: SCALE, timestamp_ms: 100_000 }),
            Source::Kraken => None,
            Source::Bitstamp | Source::Binance => {
                clock.set(100_000 + MAX_COLLECTION_AGE_MS + 1);
                Some(Observation { price: SCALE, timestamp_ms: clock.get() })
            }
        });
        assert!(!prices.contains_key("BTC"));
    }

    #[test]
    fn timestamped_venues_reject_missing_stale_and_future_trades() {
        let now = 1_767_225_600_000;
        for timestamp in [0, now - MAX_SOURCE_AGE_MS - 1, now + MAX_FUTURE_SKEW_MS + 1] {
            let binance = serde_json::to_vec(&json!([{"price":"1","time":timestamp}])).unwrap();
            assert!(parse_source(Source::Binance, asset("BTC"), &binance, now).is_err());
            let kraken = serde_json::to_vec(&json!({"error":[],"result":{
                "XXBTZUSD":[["1","1",timestamp as f64 / 1000.0,"b","m","",1]],"last":"9999999999999999999"
            }})).unwrap();
            assert!(parse_source(Source::Kraken, asset("BTC"), &kraken, now).is_err());
        }
        for body in [r#"[{"price":"1"}]"#, r#"[]"#, r#"[{"price":"1","time":null}]"#] {
            assert!(parse_source(Source::Binance, asset("BTC"), body.as_bytes(), now).is_err());
        }
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
                    1,
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
