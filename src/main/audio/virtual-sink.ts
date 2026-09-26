/**
 * The Virtual output: a loopback device the Intercom output plays into, so an
 * intercom client on this machine can record what the show produces.
 *
 * Only Linux is served by code. PipeWire and PulseAudio both take a null sink
 * from an unprivileged process at runtime, and its monitor is immediately
 * recordable. macOS and Windows want an installed driver, which this app has no
 * business installing — see ADR 0008. There, the work is detection, and that
 * happens in the renderer where the device API is; all this side contributes is
 * the sentence telling the operator what to install.
 *
 * Nothing here runs during a Live session. The sink is made at start or when the
 * setting is switched on, and removed at quit.
 */

import { execFile } from 'node:child_process'
import type { VirtualOutputState } from '../../shared/ipc-contract'

/** PulseAudio sink name. Also what `pactl unload-module` is matched against. */
export const SINK_NAME = 'shotlister_out'

/** What the device calls itself everywhere a human sees it. */
export const SINK_DESCRIPTION = 'Shotlister Out'

/** What to record in the intercom client once the sink exists. */
export const MONITOR_DESCRIPTION = `Monitor of ${SINK_DESCRIPTION}`

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs a command and never throws: a missing `pactl` is an answer, not an
 * exception, and every caller here wants to turn it into a sentence rather than
 * to unwind.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr: stderr || error.message })
        return
      }
      resolve({ code: 0, stdout, stderr })
    })
  })

/**
 * True when `pactl list short sinks` already lists our sink.
 *
 * The output is tab separated — `<id>\t<name>\t<driver>\t<spec>\t<state>` — and
 * the name is matched whole: a sink called `shotlister_out_2` that somebody made
 * by hand is not ours to reuse or to unload.
 */
export function sinkPresent(stdout: string): boolean {
  return stdout
    .split('\n')
    .map((line) => line.split('\t')[1]?.trim())
    .some((name) => name === SINK_NAME)
}

/**
 * The module index `pactl load-module` prints on success.
 *
 * Kept so quit can unload exactly what this process loaded. A sink that was
 * already there when we looked has no index here and is deliberately left alone.
 */
export function parseModuleId(stdout: string): number | null {
  const first = stdout.trim().split('\n')[0]?.trim() ?? ''
  if (!/^\d+$/.test(first)) return null
  return Number.parseInt(first, 10)
}

/** What the operator has to do themselves on a platform that cannot be served. */
export function platformGuidance(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return (
      'macOS cannot create a loopback device from inside an app. Install BlackHole — ' +
      '`brew install blackhole-2ch`, or the installer from existential.audio — then choose it here.'
    )
  }
  if (platform === 'win32') {
    return (
      'Windows cannot create a loopback device from inside an app. Install VB-CABLE from ' +
      'vb-audio.com (or VoiceMeeter), then choose "CABLE Input" here.'
    )
  }
  return 'No supported audio server was found. The Virtual output needs PipeWire or PulseAudio.'
}

/** Labels that mean "this device loops back", per platform, lower case. */
export const LOOPBACK_DEVICE_HINTS: Readonly<Record<string, readonly string[]>> = {
  linux: [SINK_DESCRIPTION.toLowerCase()],
  darwin: ['blackhole', 'loopback audio'],
  win32: ['cable input', 'vb-audio', 'voicemeeter'],
}

/** The hints for a platform, empty for one nobody has a device list for. */
export function loopbackHints(platform: NodeJS.Platform): readonly string[] {
  return LOOPBACK_DEVICE_HINTS[platform] ?? []
}

export interface VirtualSinkManager {
  /** Current state, without creating anything. */
  state: () => Promise<VirtualOutputState>
  /**
   * Makes sure the sink exists, and reports what happened.
   *
   * Idempotent: an existing `shotlister_out` — ours from a crashed run, or the
   * operator's own — is reused rather than duplicated.
   */
  ensure: () => Promise<VirtualOutputState>
  /** Unloads the module this process loaded. A reused sink is left behind. */
  remove: () => Promise<void>
}

/**
 * @param platform Injected so the mac and Windows branches are testable from
 *   Linux CI and from a mac laptop, which are never the same machine.
 */
export function createVirtualSinkManager(
  run: CommandRunner = runCommand,
  platform: NodeJS.Platform = process.platform,
): VirtualSinkManager {
  /** Set only while a module we loaded is still loaded. */
  let ownedModuleId: number | null = null

  function unsupported(): VirtualOutputState {
    return {
      creatable: false,
      present: false,
      label: null,
      monitorLabel: null,
      guidance: platformGuidance(platform),
    }
  }

  function created(): VirtualOutputState {
    return {
      creatable: true,
      present: true,
      label: SINK_DESCRIPTION,
      monitorLabel: MONITOR_DESCRIPTION,
      guidance: null,
    }
  }

  function unavailable(reason: string): VirtualOutputState {
    return {
      creatable: true,
      present: false,
      label: SINK_DESCRIPTION,
      monitorLabel: null,
      guidance: reason,
    }
  }

  async function listSinks(): Promise<CommandResult> {
    return run('pactl', ['list', 'short', 'sinks'])
  }

  /** The reason a pactl call failed, short enough for a settings panel. */
  function failureReason(result: CommandResult): string {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? ''
    if (/ENOENT|not found/i.test(detail) || result.code === 127) {
      return 'pactl was not found. The Virtual output needs PipeWire or PulseAudio.'
    }
    return detail === '' ? `pactl failed (exit ${result.code}).` : detail
  }

  return {
    async state() {
      if (platform !== 'linux') return unsupported()

      const listed = await listSinks()
      if (listed.code !== 0) return unavailable(failureReason(listed))
      return sinkPresent(listed.stdout) ? created() : unavailable('Not created yet.')
    },

    async ensure() {
      if (platform !== 'linux') return unsupported()

      const listed = await listSinks()
      if (listed.code !== 0) return unavailable(failureReason(listed))
      // Reused rather than replaced, and not recorded as ours: unloading a sink
      // this process did not load would take away something the operator set up.
      if (sinkPresent(listed.stdout)) return created()

      const loaded = await run('pactl', [
        'load-module',
        'module-null-sink',
        `sink_name=${SINK_NAME}`,
        `sink_properties=device.description="${SINK_DESCRIPTION}"`,
      ])
      if (loaded.code !== 0) return unavailable(failureReason(loaded))

      ownedModuleId = parseModuleId(loaded.stdout)
      return created()
    },

    async remove() {
      if (ownedModuleId === null) return
      const id = ownedModuleId
      // Cleared first: a failed unload must not leave a stale id that a later
      // quit tries again on a module index the server has since reused.
      ownedModuleId = null
      const result = await run('pactl', ['unload-module', String(id)])
      if (result.code !== 0) {
        console.error('[audio] could not unload the virtual sink:', failureReason(result))
      }
    },
  }
}
