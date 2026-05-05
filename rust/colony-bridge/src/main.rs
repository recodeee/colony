// colony-bridge: tiny native client for `colony bridge lifecycle --json ...`.
//
// Why: the shell wrapper at apps/cli/bin/colony.sh costs ~50ms per event
// (sh + curl + temp-file dance). A static binary doing the same work runs
// in ~5-10ms. This is the second-pass optimization on top of the daemon
// endpoint added in the same PR series.
//
// Behavior:
//   1. Parse argv expected as `bridge lifecycle --json [--ide X] [--cwd Y]`
//      (the shell wrapper guarantees this shape; anything else is rejected
//      here so we fall through to Node.)
//   2. Read entire stdin into memory (lifecycle envelopes are tiny — well
//      under 64 KiB in practice).
//   3. Open a TCP connection to 127.0.0.1:$COLONY_WORKER_PORT (default 37777)
//      with a hard 1s connect timeout, send a single HTTP/1.1 POST, read
//      the response with a 2s read timeout.
//   4. On any failure (connect refused, timeout, non-200, parse error),
//      fall back to invoking the Node CLI in-process by exec'ing
//      `node $DIR/../dist/index.js bridge lifecycle ...` with stdin
//      reconnected from our buffered envelope. This preserves the
//      rule-#10 "writes never depend on the daemon" contract end-to-end.
//   5. On success, write the daemon's response body to stdout and exit 0.
//
// No external crates: keeping deps to std means the binary is small,
// builds fast, and has no supply-chain surface beyond rustc itself.

use std::env;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{exit, Command, Stdio};
use std::time::Duration;

const DEFAULT_PORT: u16 = 37777;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const ENDPOINT: &str = "/api/bridge/lifecycle";

struct Args {
    ide: String,
    cwd: String,
}

fn main() {
    let argv: Vec<String> = env::args().collect();
    let parsed = match parse_args(&argv[1..]) {
        Ok(a) => a,
        Err(_) => fall_back_to_node(&argv[1..], &Vec::new()),
    };

    let mut body = Vec::with_capacity(4096);
    if let Err(_) = std::io::stdin().read_to_end(&mut body) {
        // Stdin is unreadable — there's no envelope to forward and no body
        // to replay to Node. Surface the same error commander would.
        eprintln!("colony-bridge: failed to read stdin");
        exit(1);
    }

    match try_daemon(&parsed, &body) {
        Ok(response_body) => {
            if std::io::stdout().write_all(&response_body).is_err() {
                exit(1);
            }
            exit(0);
        }
        Err(_) => fall_back_to_node(&argv[1..], &body),
    }
}

fn parse_args(args: &[String]) -> Result<Args, ()> {
    // Expected shape (the shell wrapper enforces this; we re-validate).
    //
    //   colony-bridge bridge lifecycle --json [--ide X | --ide=X] [--cwd Y | --cwd=Y]
    //
    // The wrapper passes us its full argv so we mirror its strict parser.
    let mut iter = args.iter();
    let first = iter.next().ok_or(())?;
    let second = iter.next().ok_or(())?;
    if first != "bridge" || second != "lifecycle" {
        return Err(());
    }
    let mut ide = String::new();
    let mut cwd = String::new();
    let mut json = false;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--ide" => ide = iter.next().cloned().ok_or(())?,
            s if s.starts_with("--ide=") => ide = s[6..].to_string(),
            "--cwd" => cwd = iter.next().cloned().ok_or(())?,
            s if s.starts_with("--cwd=") => cwd = s[6..].to_string(),
            "--" => break,
            _ => return Err(()),
        }
    }
    if !json {
        // Without --json the daemon returns JSON and the human-mode caller
        // would see machine output. Punt to Node which formats nicely.
        return Err(());
    }
    Ok(Args { ide, cwd })
}

fn worker_port() -> u16 {
    env::var("COLONY_WORKER_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn try_daemon(args: &Args, body: &[u8]) -> Result<Vec<u8>, ()> {
    let port = worker_port();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|_| ())?;
    stream.set_read_timeout(Some(REQUEST_TIMEOUT)).map_err(|_| ())?;
    stream.set_write_timeout(Some(REQUEST_TIMEOUT)).map_err(|_| ())?;

    // Build request. Headers are written as bytes; the body is sent raw.
    // No keep-alive — we exit immediately after, and the daemon closes the
    // socket cleanly when it sees Connection: close.
    let mut request = Vec::with_capacity(256 + body.len());
    request.extend_from_slice(b"POST ");
    request.extend_from_slice(ENDPOINT.as_bytes());
    request.extend_from_slice(b" HTTP/1.1\r\n");
    write_header(&mut request, "Host", &format!("127.0.0.1:{port}"));
    write_header(&mut request, "Content-Type", "application/json");
    write_header(&mut request, "Content-Length", &body.len().to_string());
    write_header(&mut request, "Connection", "close");
    if !args.ide.is_empty() {
        write_header(&mut request, "X-Colony-Ide", &args.ide);
    }
    if !args.cwd.is_empty() {
        write_header(&mut request, "X-Colony-Cwd", &args.cwd);
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(body);

    stream.write_all(&request).map_err(|_| ())?;

    let mut response = Vec::with_capacity(4096);
    stream.read_to_end(&mut response).map_err(|_| ())?;

    parse_response(&response)
}

fn write_header(buf: &mut Vec<u8>, name: &str, value: &str) {
    // Strip CR/LF defensively — header injection here would be a write
    // out of bounds, not a remote vulnerability (we control both ends),
    // but a misbehaving caller shouldn't be able to break the request.
    let safe_value: String = value
        .chars()
        .filter(|c| *c != '\r' && *c != '\n')
        .collect();
    buf.extend_from_slice(name.as_bytes());
    buf.extend_from_slice(b": ");
    buf.extend_from_slice(safe_value.as_bytes());
    buf.extend_from_slice(b"\r\n");
}

fn parse_response(response: &[u8]) -> Result<Vec<u8>, ()> {
    // Find the header/body separator and check the status line. We do a
    // hand-rolled minimal HTTP/1.1 parse — Hono on the worker side always
    // sends a clean response with Content-Length, and we treat anything
    // unexpected as "fall back to Node".
    let header_end = find_subsequence(response, b"\r\n\r\n").ok_or(())?;
    let head = &response[..header_end];
    let body = &response[header_end + 4..];

    // Status line: first \r\n-terminated line.
    let status_end = find_subsequence(head, b"\r\n").unwrap_or(head.len());
    let status_line = std::str::from_utf8(&head[..status_end]).map_err(|_| ())?;
    let mut parts = status_line.split(' ');
    let _version = parts.next().ok_or(())?;
    let code = parts.next().ok_or(())?;
    if code != "200" {
        return Err(());
    }

    // We sent Connection: close, so Hono either streams Content-Length
    // bytes or just writes the body until close. Either way, body is the
    // entirety of what's after the header separator.
    Ok(body.to_vec())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn fall_back_to_node(args: &[String], buffered_stdin: &[u8]) -> ! {
    // Resolve the Node CLI path relative to this binary. Layout:
    //     <pkg>/bin/colony-bridge-<platform>   (this binary)
    //     <pkg>/dist/index.js                  (Node CLI)
    let exe = match env::current_exe() {
        Ok(p) => match std::fs::canonicalize(&p) {
            Ok(c) => c,
            Err(_) => p,
        },
        Err(_) => {
            eprintln!("colony-bridge: could not resolve own path; daemon path failed");
            exit(1);
        }
    };
    let bin_dir = exe.parent().unwrap_or(&PathBuf::from(".")).to_path_buf();
    let node_cli = bin_dir.join("..").join("dist").join("index.js");

    // Spawn `node <cli> bridge lifecycle [...]`, feed buffered stdin in.
    let mut cmd = Command::new("node");
    cmd.arg(&node_cli).arg("bridge").arg("lifecycle");
    let mut iter = args.iter();
    // Skip the first two args (`bridge lifecycle`); the rest are forwarded.
    iter.next();
    iter.next();
    for arg in iter {
        cmd.arg(arg);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("colony-bridge: failed to spawn node fallback: {err}");
            exit(1);
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        if !buffered_stdin.is_empty() {
            let _ = stdin.write_all(buffered_stdin);
        }
        // drop closes stdin so node sees EOF
    }
    match child.wait() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(_) => exit(1),
    }
}

