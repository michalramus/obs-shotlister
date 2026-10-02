import React, { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { isInTransition } from '../../shared/timing'

const s = {
  bar: (uiMode: 'edit' | 'live'): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    borderLeft: uiMode === 'edit' ? '4px solid #2980b9' : '4px solid #e74c3c',
  }),

  btn: (
    variant: 'primary' | 'danger' | 'secondary' | 'mode-live' | 'mode-edit',
  ): React.CSSProperties => ({
    padding: '6px 16px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 700,
    fontSize: '13px',
    background:
      variant === 'primary'
        ? '#27ae60'
        : variant === 'danger'
          ? '#e74c3c'
          : variant === 'mode-live'
            ? '#e74c3c'
            : variant === 'mode-edit'
              ? '#2980b9'
              : '#3a3a3a',
    color: '#fff',
  }),

  liveBadge: {
    marginLeft: 'auto',
    fontSize: '14px',
    color: '#e74c3c',
    fontWeight: 700,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,
}

export function LiveControls(): React.JSX.Element {
  const running = useAppStore((s) => s.running)
  const shots = useAppStore((s) => s.shots)
  const startedAt = useAppStore((s) => s.startedAt)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const liveStart = useAppStore((s) => s.liveStart)
  const unrenderedCount = useAppStore((s) => s.renderSummary?.unrenderedCount ?? 0)
  const rundownKind = useAppStore(
    (s) => s.rundowns.find((r) => r.id === s.activeRundownId)?.kind ?? 'camera',
  )
  const liveStop = useAppStore((s) => s.liveStop)
  const liveNext = useAppStore((s) => s.liveNext)
  const liveSkipNext = useAppStore((s) => s.liveSkipNext)
  const liveRestart = useAppStore((s) => s.liveRestart)
  const liveIndex = useAppStore((s) => s.liveIndex)
  const uiMode = useAppStore((s) => s.uiMode)
  const setUiMode = useAppStore((s) => s.setUiMode)

  const [inTransition, setInTransition] = useState(false)
  /**
   * The last transport failure, shown in whichever bar is on screen until
   * something works.
   *
   * Every action routes through `runAction`, so a Next that fails mid-show has to
   * be visible then — not held until the session ends and shown beside the Start
   * button, reading as a start failure that never happened — and a Next that then
   * succeeds has to take it away again.
   */
  const [actionError, setActionError] = useState<string | null>(null)
  const transitionRafRef = useRef<number | null>(null)
  const [previewFirst, setPreviewFirst] = useState(() => {
    try {
      const stored = localStorage.getItem('obs-queuer-preview-first')
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })

  // The stored setting is the source of truth — localStorage is only a cache so
  // the checkbox paints right on the first frame instead of flipping.
  useEffect(() => {
    window.api.live
      .getPreviewFirst()
      .then((v) => {
        setPreviewFirst(v)
        try {
          localStorage.setItem('obs-queuer-preview-first', String(v))
        } catch {
          /* ignore */
        }
      })
      .catch((err: unknown) => console.error('[LiveControls] getPreviewFirst:', err))
  }, [])

  // 60fps RAF loop to track transition state. Only worth running while a shot is
  // actually live — otherwise it re-rendered this component 60x/s forever.
  //
  // And only for as long as the answer can still change. `isInTransition` is true
  // for `transitionMs` after `startedAt` and false ever after, so a Shot taken on
  // a cut has no window at all and a Shot with one closes it in well under a
  // second — while the loop ran for the whole of every Shot, all show.
  useEffect(() => {
    if (!running || liveIndex === null || startedAt === null) {
      setInTransition(false)
      return
    }
    if ((shots[liveIndex]?.transitionMs ?? 0) <= 0) {
      setInTransition(false)
      return
    }
    function tick(): void {
      const still = isInTransition(running, liveIndex, startedAt, shots, Date.now())
      setInTransition(still)
      // The window only ever closes, so the frame that finds it shut is the last
      // one worth asking for.
      if (!still) {
        transitionRafRef.current = null
        return
      }
      transitionRafRef.current = requestAnimationFrame(tick)
    }
    transitionRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (transitionRafRef.current !== null) {
        cancelAnimationFrame(transitionRafRef.current)
        transitionRafRef.current = null
      }
    }
  }, [running, liveIndex, startedAt, shots])

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `@keyframes pulse-live { 0%,100% { opacity:1 } 50% { opacity:0.4 } }`
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, [])

  function handleError(label: string, err: unknown): void {
    console.error(`[LiveControls] ${label}:`, err)
    setActionError(err instanceof Error ? err.message : String(err))
  }

  /**
   * Runs one transport action and owns the fault message around it.
   *
   * Cleared by the next thing that works, not by the next press: the message is
   * meant to be read mid-show, so it has to survive the operator's eyes reaching
   * it, and a transient OBS failure used to leave red text beside a transport
   * that had been switching cameras happily for the rest of the night.
   */
  function runAction(label: string, run: () => Promise<void>): void {
    run()
      .then(() => setActionError(null))
      .catch((err: unknown) => handleError(label, err))
  }

  /**
   * Starts the Rundown, warning first about anything unrendered.
   *
   * The warning never blocks (ADR 0002): the operator knows things about their
   * own show that the software does not, and a Part with no audio still counts
   * down — the band just does not hear its name. A *refusal* is different and
   * comes from the main process, which will not start a Rundown with an
   * unassigned item at all; that message is surfaced rather than swallowed,
   * because a silent dead button is how an operator finds out during the show.
   */
  function startRundown(): void {
    if (!activeRundownId) return

    if (rundownKind === 'voice' && unrenderedCount > 0) {
      const parts = unrenderedCount === 1 ? '1 Part has' : `${unrenderedCount} Parts have`
      const proceed = window.confirm(
        `${parts} no up-to-date audio. Their names will not be spoken, though the countdown still plays.\n\nStart anyway?`,
      )
      if (!proceed) return
    }

    runAction('start', () => liveStart(activeRundownId))
  }

  function canStart(): boolean {
    return !running && shots.length > 0 && activeRundownId !== null
  }

  /**
   * Whether the Live queue still holds something to go to.
   *
   * By the queue, not by the array's length: a skipped item stays in `shots` and
   * is marked `hidden` by the main process, and Next steps over it. Counting it
   * left ⏭ lit and enabled on the last Shot of a Rundown whose tail had been
   * skipped, with every press a no-op, and kept the "last shot" hint off the one
   * Shot it exists for.
   */
  function hasNextShot(): boolean {
    if (!running || liveIndex === null) return false
    return shots.some((shot, i) => i > liveIndex && !shot.hidden)
  }

  function canSkipNext(): boolean {
    return hasNextShot()
  }

  const errorNotice =
    actionError === null ? null : (
      <span role="alert" style={{ color: '#ff8a80', fontSize: 12, maxWidth: 420, lineHeight: 1.3 }}>
        {actionError}
      </span>
    )

  if (!running) {
    return (
      <div style={s.bar(uiMode)} data-testid="live-controls">
        <button
          style={s.btn(uiMode === 'live' ? 'mode-live' : 'mode-edit')}
          onClick={() => setUiMode(uiMode === 'edit' ? 'live' : 'edit')}
          aria-label={uiMode === 'edit' ? 'Switch to live layout' : 'Switch to edit layout'}
        >
          {uiMode === 'edit' ? 'EDIT MODE' : 'LIVE MODE'}
        </button>
        {uiMode === 'live' && (
          <>
            <button
              style={s.btn('primary')}
              disabled={!canStart()}
              onClick={startRundown}
              aria-label="Start rundown"
            >
              ▶ Start
            </button>
            {errorNotice}
            {/*
              Preview-first loads the opening Shot's scene into OBS preview when a
              Rundown is opened. A Voice-over Rundown never reaches OBS, so the
              choice does not exist there and the control must not either.
            */}
            {rundownKind === 'camera' && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '12px',
                  color: '#aaa',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={previewFirst}
                  onChange={(e) => {
                    const v = e.target.checked
                    setPreviewFirst(v)
                    try {
                      localStorage.setItem('obs-queuer-preview-first', String(v))
                    } catch {
                      /* ignore */
                    }
                    window.api.live
                      .savePreviewFirst(v)
                      .catch((err: unknown) =>
                        console.error('[LiveControls] savePreviewFirst:', err),
                      )
                  }}
                />
                Preview first
              </label>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div style={s.bar(uiMode)} data-testid="live-controls">
      <button
        style={s.btn(uiMode === 'live' ? 'mode-live' : 'mode-edit')}
        onClick={() => setUiMode(uiMode === 'edit' ? 'live' : 'edit')}
        aria-label={uiMode === 'edit' ? 'Switch to live layout' : 'Switch to edit layout'}
      >
        {uiMode === 'edit' ? 'EDIT MODE' : 'LIVE MODE'}
      </button>
      <button
        style={s.btn('danger')}
        onClick={() => runAction('stop', liveStop)}
        aria-label="Stop rundown"
      >
        ■ Stop
      </button>

      {errorNotice}

      <button
        style={s.btn('secondary')}
        onClick={() => runAction('restart', liveRestart)}
        aria-label="Restart rundown"
      >
        ↺ Restart
      </button>

      <button
        style={s.btn('secondary')}
        disabled={!canSkipNext() || inTransition}
        onClick={() => runAction('skip-next', liveSkipNext)}
        aria-label="Skip next shot"
      >
        ⏭ Skip next
      </button>

      <button
        style={s.btn('primary')}
        disabled={inTransition}
        onClick={() => runAction('next', liveNext)}
        aria-label="Next shot"
      >
        → Next
      </button>

      {!hasNextShot() && liveIndex !== null && (
        <span style={{ fontSize: '12px', color: '#888' }}>last shot</span>
      )}

      <span style={{ ...s.liveBadge, animation: 'pulse-live 1.2s ease-in-out infinite' }}>
        ● LIVE
      </span>
    </div>
  )
}
