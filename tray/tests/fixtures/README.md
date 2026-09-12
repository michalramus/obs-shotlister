Payloads captured verbatim from a running socket.io server speaking the main app's
protocol (`cargo run --example spike`). They exist so a change to the `Shot` shape in
`src/shared/types.ts` shows up here as a failing test rather than as a tray that quietly
stops beeping.
