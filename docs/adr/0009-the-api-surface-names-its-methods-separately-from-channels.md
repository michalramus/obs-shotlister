# The api surface names its methods separately from its channel names

`window.api` is derived from one declaration. `API_SURFACE` in `src/shared/ipc-contract.ts` maps
each api method to its channel name, `ElectronApi` is a mapped type over that value, and both
`IPC_CHANNELS` and the preload's exposed object are walks of it. Adding a channel no longer means
restating its name in the contract map, the `ElectronApi` group and the `IPC_CHANNELS` array, and
the preload names no channel at all — it lost 147 lines.

The obvious next step is to delete `API_SURFACE` too and derive the method name from the channel
name, grouping on the segment before the first `:`. **That does not work, and this is the record of
why, so it stops being re-proposed.**

The api renames deliberately, and the renames are information:

| channel | api method |
| --- | --- |
| `speech:renderSummary` | `speech.status` |
| `voice:settings:get` | `voice.getSettings` |
| `audio:devices:get` | `audioDevices.get` |
| `rundown:media:get` | `rundownMedia.get` |
| `export:project` | `exportImport.exportProject` |
| `obs:transitions:list` | `obs.listTransitionMappings` |
| `media:file-exists` | `mediaFileExists` — no group at all |

A channel name is a wire address, grouped by the area that owns the handler. An api method is what
the renderer reads at the call site. They agree often enough to look derivable and disagree often
enough that a rule would have to be fought with exceptions, which is a worse declaration than the
map it replaced. So the method name stays written down, once, in the one place that also carries
the channel it reaches.

## Consequences

A new channel costs two declarations — the contract entry, which carries its payload and result
types, and the surface entry, which carries its api name — plus its handler registration in
`src/main/index.ts` and its implementation. Both declarations say something nothing else states.

`API_SURFACE` must be a runtime value, not a type, because a type erases and the preload has to
walk something at run time to build the object it exposes. It is `as const satisfies SurfaceGroup`
so it stays a literal the mapped type can read.

A leaf is either a channel name or `{ push: 'channel' }`. The wrapper is load-bearing rather than
decorative: `obs:status` is both a request channel and a push channel, so a bare string cannot say
which one a leaf means. A symmetric proof, `PushChannelsIn<typeof API_SURFACE> ≡ IpcPushChannel`,
catches a push channel declared but never subscribed — which nothing checked while `ElectronApi`
was hand-written — and catches `{ push: … }` pointed at a request channel, which would otherwise
read as a group with a method called `push` and compile.

Two of the four regex checks in `src/shared/ipc-contract.test.ts` are gone, because the
restatement they policed is gone. The check that the main process actually registers every declared
channel stays, and stays a regex over `src/main/index.ts`: registration is imperative code the
compiler cannot see, so `registerIpcHandler('channel:name', …)` calls must remain literal in that
file.
