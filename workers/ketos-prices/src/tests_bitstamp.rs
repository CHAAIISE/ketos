use super::*;
use serde_json::json;

fn eth() -> Asset { *SUPPORTED_ASSETS.iter().find(|asset| asset.symbol == "ETH").unwrap() }

#[test]
fn usd_midpoint_uses_snapshot_timestamp_and_never_the_last_trade() {
    let body = br#"{"bid":"2051.48","ask":"2051.51000001","last":"1000","timestamp":"1794398696","market_type":"SPOT"}"#;
    assert_eq!(parse_source(Source::Bitstamp, eth(), body, 1_794_398_697_000),
        Ok(Observation { price: 205_149_500_000, timestamp_ms: 1_794_398_696_000 }));
}

#[test]
fn invalid_books_and_untrustworthy_timestamps_are_unavailable() {
    let now = 1_794_398_696_000;
    let base = json!({"bid":"100","ask":"100.5","timestamp":"1794398696","market_type":"SPOT"});
    for (field, value) in [
        ("bid", "0"), ("ask", "99"), ("ask", "101.00000001"),
        ("market_type", "PERPETUAL"), ("timestamp", "0"),
        ("timestamp", "1794398575"), ("timestamp", "1794398702"),
        ("timestamp", "18446744073709551615"), ("timestamp", "+1794398696"),
    ] {
        let mut quote = base.clone();
        quote[field] = json!(value);
        assert!(parse_source(Source::Bitstamp, eth(), &serde_json::to_vec(&quote).unwrap(), now).is_err(), "{field}={value}");
    }
    for field in ["bid", "ask", "timestamp", "market_type"] {
        let mut quote = base.clone();
        quote.as_object_mut().unwrap().remove(field);
        assert!(parse_source(Source::Bitstamp, eth(), &serde_json::to_vec(&quote).unwrap(), now).is_err());
    }
}

#[test]
fn quiet_trade_venue_does_not_require_a_fresh_stablecoin_trade_for_quorum() {
    let now = 1_794_398_697_000;
    let quote = br#"{"bid":"2051.48","ask":"2051.52","timestamp":"1794398696","market_type":"SPOT"}"#;
    let prices = collect_prices(&[eth()], || now, |asset, source| match source {
        Source::Coinbase => Some(Observation { price: 205_150_000_000, timestamp_ms: now - 2_000 }),
        Source::Kraken => Some(Observation { price: 205_150_000_000, timestamp_ms: now - 20_000 }),
        Source::Bitstamp => parse_source(source, asset, quote, now).ok(),
        Source::Binance => panic!("USD quorum must not depend on a USDT/USD last trade"),
    });
    assert_eq!(prices["ETH"], Price("205150000000".into(), vec![Source::Coinbase, Source::Bitstamp], now - 2_000));
}
