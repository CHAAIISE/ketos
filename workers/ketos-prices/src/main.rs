#[cfg(all(target_arch = "wasm32", target_os = "wasi", target_env = "p2"))]
mod worker {
    use ketos_prices::{
        collect_prices, encode_output, encode_signed_output, parse_request, parse_source,
        usdt_to_usd, Asset, Output, ProtectedPriceSigner, Request, Source, MAX_RESPONSE_BYTES,
        USDT_USD,
    };
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use wasi_http_client::Client;
    use zeroize::Zeroizing;

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
    const REQUEST_BUDGET: Duration = Duration::from_secs(5);
    const EXECUTION_BUDGET: Duration = Duration::from_secs(20);

    fn now_ms() -> Result<u64, String> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock precedes Unix epoch".to_string())?;
        u64::try_from(elapsed.as_millis()).map_err(|_| "system clock overflow".to_string())
    }

    fn check_budget(start: Instant, execution_start: Instant) -> Result<(), String> {
        if start.elapsed() >= REQUEST_BUDGET || execution_start.elapsed() >= EXECUTION_BUDGET {
            return Err("HTTP or execution time budget exceeded".to_string());
        }
        Ok(())
    }

    fn fetch(asset: Asset, source: Source, execution_start: Instant) -> Result<u128, String> {
        let start = Instant::now();
        check_budget(start, execution_start)?;
        let url = source.url(asset);
        // 0.2.1 exposes only connect_timeout. Blocking send/chunk may exceed the
        // cooperative budgets below: the OutLayer host must bound total execution
        // and response I/O. Never relabel a late response with a fresh timestamp.
        let response = Client::new()
            .get(&url)
            .header("accept", b"application/json".to_vec())
            .header("user-agent", b"ketos-prices/0.1".to_vec())
            .connect_timeout(CONNECT_TIMEOUT)
            .send()
            .map_err(|error| format!("HTTP request failed: {error}"))?;
        check_budget(start, execution_start)?;
        if response.status() != 200 {
            return Err(format!("HTTP status {}", response.status()));
        }
        if let Some(length) = response.headers().get("content-length") {
            let length = length
                .parse::<u64>()
                .map_err(|_| "invalid content-length".to_string())?;
            if length > MAX_RESPONSE_BYTES as u64 {
                return Err("source response too large".to_string());
            }
        }
        let mut body = Vec::with_capacity(1024);
        loop {
            check_budget(start, execution_start)?;
            let remaining = MAX_RESPONSE_BYTES + 1 - body.len();
            let chunk = response
                .chunk(remaining.min(4096) as u64)
                .map_err(|error| format!("HTTP body failed: {error}"))?;
            check_budget(start, execution_start)?;
            let Some(chunk) = chunk else { break };
            if chunk.is_empty() {
                return Err("empty HTTP body chunk".to_string());
            }
            if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
                return Err("source response too large".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        parse_source(source, asset, &body, now_ms()?).map_err(str::to_string)
    }

    fn observed(asset: Asset, source: Source, execution_start: Instant) -> Option<u128> {
        match fetch(asset, source, execution_start) {
            Ok(price) => Some(price),
            Err(error) => {
                eprintln!("{} {} omitted: {error}", asset.symbol, source.name());
                None
            }
        }
    }

    fn price_signer() -> Result<ProtectedPriceSigner, String> {
        // The keystore injects this TEE-generated profile value into WASI env.
        // Never log the environment, seed, or a parse error containing its value.
        let seed = Zeroizing::new(
            std::env::var("PROTECTED_KETOS_PRICE_KEY")
                .map_err(|_| "protected price signing secret unavailable".to_string())?,
        );
        ProtectedPriceSigner::from_protected_seed(&seed).map_err(str::to_string)
    }

    pub fn run() -> Result<(), String> {
        let input = outlayer::env::input();
        let (assets, signer) = match parse_request(&input).map_err(str::to_string)? {
            Request::Unsigned(assets) => (assets, None),
            Request::SignedPrices(assets) => (assets, Some(price_signer()?)),
            Request::GetPublicKey => {
                let public_key = price_signer()?.public_key();
                let output = serde_json::to_vec(&serde_json::json!({ "public_key": public_key }))
                    .map_err(|_| "public key serialization failed".to_string())?;
                outlayer::env::output(&output);
                return Ok(());
            }
        };
        // Capture before every source/FX fetch, not when slow network calls finish.
        let timestamp_ms = now_ms()?;
        let execution_start = Instant::now();
        let mut fx: Option<Option<u128>> = None;
        let prices = collect_prices(&assets, |asset, source| {
            if source != Source::Binance {
                return observed(asset, source, execution_start);
            }
            // Binance spot is quoted in USDT. A real Kraken USDT/USD last trade
            // converts it to USD; no peg assumption or made-up missing FX value.
            let usd_per_usdt =
                *fx.get_or_insert_with(|| observed(USDT_USD, Source::Kraken, execution_start));
            let usd_per_usdt = usd_per_usdt?;
            let price_usdt = observed(asset, Source::Binance, execution_start)?;
            match usdt_to_usd(price_usdt, usd_per_usdt) {
                Ok(price) => Some(price),
                Err(error) => {
                    eprintln!("{} binance omitted: {error}", asset.symbol);
                    None
                }
            }
        });
        let prices = Output {
            timestamp_ms,
            prices,
        };
        let output = match signer {
            Some(signer) => {
                let envelope = signer.sign_prices(&prices).map_err(str::to_string)?;
                encode_signed_output(&envelope)
            }
            None => encode_output(&prices),
        }
        .map_err(str::to_string)?;
        outlayer::env::output(&output);
        Ok(())
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi", target_env = "p2"))]
fn main() {
    if let Err(error) = worker::run() {
        eprintln!("ketos-prices: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi", target_env = "p2")))]
fn main() {
    eprintln!("ketos-prices executable requires wasm32-wasip2; the library supports native tests");
    std::process::exit(1);
}
