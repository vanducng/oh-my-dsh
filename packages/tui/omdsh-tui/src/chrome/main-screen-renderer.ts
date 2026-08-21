/**
 * Main-screen renderer.
 *
 * The terminal owns native scrollback. This renderer owns only the current
 * screen and a logical boundary for rows already frozen above it. Routine
 * updates and explicit transcript epochs both preserve host history.
 *
 * Finalized rows cross the boundary by being painted at the top of the screen
 * immediately before a newline scrolls them into history. Mutable assistant
 * and tool surfaces use the alternate buffer until settlement, so terminal
 * resizes cannot freeze provisional rows into native history.
 *
 * reset() repairs the visible screen without replaying history. A logical
 * conversation replacement calls startEpoch() to append a new visual epoch
 * after clearing only the visible screen.
 *
 * The renderer never enables mouse tracking (1000/1006) and wraps every paint
 * in one DEC 2026 synchronized write.
 * @module @vanducng/dsh-tui
 */
import { sanitizeDisplayLine, type Frame, type RenderSink } from './renderer.ts'

const DISABLE_AUTOWRAP = '\x1b[?7l'
const ENABLE_AUTOWRAP = '\x1b[?7h'
const SYNC_OUTPUT_BEGIN = '\x1b[?2026h'
const SYNC_OUTPUT_END = '\x1b[?2026l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'
const CLEAR_SCREEN = '\x1b[2J\x1b[H'
const CLEAR_LINE = '\x1b[2K'

function csi(row: number, column: number): string {
  return `\x1b[${Math.max(1, row + 1)};${Math.max(1, column + 1)}H`
}

export interface MainScreenRendererOptions {
  /** Terminal height in rows. */
  height: number
  /** Terminal width in columns. */
  width?: number
  /** Wrap the paint in synchronized output (DEC 2026). */
  synchronized?: boolean
  /** Borrow the alternate buffer for transient full-screen surfaces. */
  alternateScreenOverlays?: boolean
  /** Keep mutable assistant and tool surfaces out of native scrollback. */
  alternateScreenMutable?: boolean
  /** Scroll the pre-existing terminal screen into history before first paint. */
  preserveInitialScreen?: boolean
}

export interface EpochOptions {
  /** Full freezes the restored snapshot; pinned preserves its mutable suffix. */
  replay?: 'full' | 'pinned'
}

interface ResizeTransition {
  oldHeight: number
  widthChanged: boolean
}

interface ScreenTarget {
  rows: string[]
  start: number
  offset: number
}

interface ResizeBaseline {
  rows: string[]
  clear: boolean
}

/** Render frames into the terminal main screen while preserving native history. */
export class MainScreenRenderer {
  readonly #sink: RenderSink
  readonly #synchronized: boolean
  readonly #alternateScreenOverlays: boolean
  readonly #alternateScreenMutable: boolean
  readonly #preserveInitialScreen: boolean
  #width: number
  #height: number
  #resize: ResizeTransition | undefined
  #hasFrame = false
  #reanchor = false
  #newEpoch = false
  #fullReplayOnNextEpoch = true
  #adoptPhysicalAfterTransient = false
  /** First logical row not frozen above the screen in the current epoch. */
  #physical = 0
  /** Exact visible rows expected on the physical screen. */
  #screen: string[]
  #transient = false
  #altActive = false
  #altMutable = false
  #altGeometryDirty = false
  #altScreen: string[]
  #frameLines: readonly string[] = []
  #frameLiveStart = 0
  #preserveScreenOnNextRender = false
  #cursorRow = 0
  #cursorCol = 0
  #cursorVisible = true

  constructor(sink: RenderSink, options: MainScreenRendererOptions) {
    this.#sink = sink
    this.#width = options.width ?? 0
    this.#height = Math.max(1, options.height)
    this.#screen = this.#blankScreen()
    this.#altScreen = this.#blankScreen()
    this.#synchronized = options.synchronized === true
    this.#alternateScreenOverlays = options.alternateScreenOverlays === true
    this.#alternateScreenMutable = options.alternateScreenMutable === true
    this.#preserveInitialScreen = options.preserveInitialScreen === true
  }

  /** Record terminal geometry; the terminal has already performed the resize. */
  resize(width: number, height: number): void {
    const nextHeight = Math.max(1, height)
    if (width === this.#width && nextHeight === this.#height) return
    const transition = this.#resize ?? { oldHeight: this.#height, widthChanged: false }
    transition.widthChanged ||= width !== this.#width
    this.#resize = transition
    this.#width = width
    this.#height = nextHeight
    this.#altGeometryDirty = true
  }

  /** Repaint the current viewport without replaying frozen history. */
  reset(): void {
    this.#reanchor = true
  }

  /** Abandon terminal state changed by another foreground process. */
  reacquire(): void {
    this.#resize = undefined
    this.#hasFrame = false
    this.#reanchor = true
    this.#newEpoch = true
    this.#fullReplayOnNextEpoch = true
    this.#adoptPhysicalAfterTransient = false
    this.#physical = 0
    this.#screen = this.#blankScreen()
    this.#transient = false
    this.#altActive = false
    this.#altMutable = false
    this.#altGeometryDirty = false
    this.#altScreen = this.#blankScreen()
    this.#frameLines = []
    this.#frameLiveStart = 0
    this.#preserveScreenOnNextRender = true
    this.#cursorRow = 0
    this.#cursorCol = 0
    this.#cursorVisible = true
  }

  /** Append a new logical transcript epoch on the next paint. */
  startEpoch(options: EpochOptions = {}): void {
    this.#newEpoch = true
    this.#fullReplayOnNextEpoch = options.replay !== 'pinned'
    this.#reanchor = true
    this.#adoptPhysicalAfterTransient = false
  }

  /** Start a fresh row-index space after presentation changes reflow finalized rows. */
  startLayoutEpoch(): void {
    this.startEpoch()
  }

  /** Put the cursor on a fresh line before terminal ownership is released. */
  finish(): void {
    const targetRow = Math.max(0, this.#height - 1)
    let out = ''
    if (this.#altActive) {
      out += EXIT_ALT_SCREEN
      this.#altActive = false
      this.#altMutable = false
      this.#altScreen = this.#blankScreen()
    }
    if (!this.#cursorVisible) out += SHOW_CURSOR
    out += csi(targetRow, 0) + '\r\n'
    this.#sink.write(out)
    this.#cursorRow = targetRow
    this.#cursorCol = 0
    this.#cursorVisible = true
  }

  /** Commit the latest finalized rows before terminal ownership is released. */
  prepareForRelease(frame: Frame): void {
    const liveStart = Math.max(0, Math.min(frame.liveStart ?? 0, frame.lines.length))
    if (liveStart === 0) return
    const stable = frame.lines.slice(0, liveStart)
    const paint = this.#paintFollow(
      stable,
      stable.length,
      false,
      { row: stable.length, column: 0 },
      false,
    )
    if (paint !== '') this.#sink.write(paint)
  }

  /** Render a frame, appending only finalized rows during a stable geometry epoch. */
  render(frame: Frame): void {
    const next = frame.lines
    const liveStart = Math.max(0, Math.min(frame.liveStart ?? 0, next.length))
    const livePinned = frame.livePinned !== false
    const cursor = frame.cursor ?? { row: next.length, column: 0 }
    const cursorVisible = frame.cursorVisible !== false
    const paint = liveStart === 0
      ? this.#paintTransient(next, cursor, cursorVisible)
      : livePinned && this.#alternateScreenMutable
        ? this.#paintPinned(next, liveStart, cursor, cursorVisible)
        : this.#paintFollow(next, liveStart, livePinned, cursor, cursorVisible)
    if (paint !== '') this.#sink.write(paint)
  }

  #paintTransient(
    next: readonly string[],
    cursor: { row: number; column: number },
    cursorVisible: boolean,
  ): string {
    const target = this.#target(next, 0, 'top')
    if (this.#alternateScreenOverlays) {
      const clear = !this.#altActive || this.#altGeometryDirty
      let body = this.#altActive ? '' : ENTER_ALT_SCREEN
      body += this.#paintScreen(target.rows, clear ? this.#blankScreen() : this.#altScreen, clear)
      const targetRow = this.#screenRow(cursor.row, target, next.length)
      body += csi(targetRow, cursor.column)
      body += cursorVisible ? SHOW_CURSOR : HIDE_CURSOR
      this.#altActive = true
      this.#altMutable = false
      this.#altGeometryDirty = false
      this.#altScreen = target.rows
      this.#cursorVisible = cursorVisible
      return this.#wrap(body)
    }
    const resized = this.#takeResizeBaseline()
    const body = this.#paintScreen(target.rows, resized.rows, this.#reanchor || resized.clear)
    this.#reanchor = false
    this.#transient = true
    return this.#finishPaint(body, target, next.length, cursor, cursorVisible)
  }

  #paintPinned(
    next: readonly string[],
    liveStart: number,
    cursor: { row: number; column: number },
    cursorVisible: boolean,
  ): string {
    let body = ''
    if (!this.#hasFrame || this.#newEpoch || this.#resize !== undefined || this.#stableChanged(next, liveStart)) {
      const stable = next.slice(0, liveStart)
      if (this.#altActive) {
        body += EXIT_ALT_SCREEN
        this.#altActive = false
        this.#altMutable = false
        this.#altScreen = this.#blankScreen()
      }
      body += !this.#hasFrame || this.#newEpoch
        ? this.#preparePinnedEpoch(stable)
        : this.#promotePinnedStable(stable)
    }
    const viewStart = Math.max(0, next.length - this.#height)
    const target = this.#target(next, viewStart, 'bottom')
    const clear = !this.#altActive || this.#altGeometryDirty
    body += this.#altActive ? '' : ENTER_ALT_SCREEN
    body += this.#paintScreen(target.rows, clear ? this.#blankScreen() : this.#altScreen, clear)
    const targetRow = this.#screenRow(cursor.row, target, next.length)
    body += csi(targetRow, cursor.column)
    body += cursorVisible ? SHOW_CURSOR : HIDE_CURSOR
    this.#altActive = true
    this.#altMutable = true
    this.#altGeometryDirty = false
    this.#altScreen = target.rows
    this.#cursorRow = targetRow
    this.#cursorCol = cursor.column
    this.#cursorVisible = cursorVisible
    return this.#wrap(body)
  }

  #stableChanged(next: readonly string[], liveStart: number): boolean {
    if (liveStart !== this.#frameLiveStart) return true
    const start = Math.max(this.#physical, liveStart - this.#height)
    for (let index = start; index < liveStart; index += 1) {
      if (next[index] !== this.#frameLines[index]) return true
    }
    return false
  }

  #preparePinnedEpoch(stable: readonly string[]): string {
    const viewStart = Math.max(0, stable.length - this.#height)
    const preserveHost = this.#preserveHostScreen()
    const epochPrefix = this.#newEpoch ? this.#epochPrefix() : []
    const body = preserveHost
      + this.#freezeRows(epochPrefix)
      + this.#paintFlush(stable, 0, viewStart, viewStart, true)
    this.#physical = viewStart
    this.#screen = this.#target(stable, viewStart, 'bottom').rows
    this.#frameLines = stable
    this.#frameLiveStart = stable.length
    this.#hasFrame = true
    this.#newEpoch = false
    this.#fullReplayOnNextEpoch = true
    this.#resize = undefined
    this.#reanchor = false
    return body
  }

  #promotePinnedStable(stable: readonly string[]): string {
    const viewStart = Math.max(0, stable.length - this.#height)
    const target = this.#target(stable, viewStart, 'bottom')
    let body = ''
    if (this.#resize?.widthChanged === true) {
      this.#resize = undefined
      body = this.#paintFlush(stable, 0, viewStart, viewStart, true)
      this.#physical = viewStart
    } else {
      if (this.#resize !== undefined) this.#adoptMainResizeBoundary()
      if (stable.length <= this.#physical) {
        body = this.#paintFlush(stable, 0, viewStart, viewStart, true)
        this.#physical = viewStart
      } else if (viewStart > this.#physical) {
        body = this.#paintFlush(stable, this.#physical, viewStart, viewStart, false)
        this.#physical = viewStart
      } else {
        body = this.#paintScreen(target.rows, this.#screen, true)
      }
    }
    this.#screen = target.rows
    this.#frameLines = stable
    this.#frameLiveStart = stable.length
    this.#reanchor = false
    return body
  }

  #paintFollow(
    next: readonly string[],
    liveStart: number,
    livePinned: boolean,
    cursor: { row: number; column: number },
    cursorVisible: boolean,
  ): string {
    const exitAlt = this.#altActive ? EXIT_ALT_SCREEN : ''
    const leavingMutable = this.#altActive && this.#altMutable
    if (this.#altActive) {
      this.#altActive = false
      this.#altMutable = false
      this.#altScreen = this.#blankScreen()
    }
    const viewStart = Math.max(0, next.length - this.#height)
    const candidatePhysical = livePinned ? Math.min(liveStart, viewStart) : viewStart
    let effectiveStart = viewStart
    let target = this.#target(next, effectiveStart, 'bottom')
    let body = ''

    if (!this.#hasFrame || this.#newEpoch) {
      const preserveHost = this.#preserveHostScreen()
      const epochPrefix = this.#newEpoch ? this.#epochPrefix() : []
      const replayPhysical = this.#newEpoch && this.#fullReplayOnNextEpoch ? viewStart : candidatePhysical
      body = preserveHost
        + this.#freezeRows(epochPrefix)
        + this.#paintFlush(next, 0, replayPhysical, viewStart, true)
      this.#physical = replayPhysical
      this.#newEpoch = false
      this.#fullReplayOnNextEpoch = true
      this.#resize = undefined
    } else if (leavingMutable) {
      const widthChanged = this.#resize?.widthChanged === true
      if (widthChanged) {
        this.#resize = undefined
        body = this.#paintFlush(next, 0, viewStart, viewStart, true)
        this.#physical = viewStart
      } else {
        if (this.#resize !== undefined) this.#adoptMainResizeBoundary()
        if (candidatePhysical > this.#physical) {
          body = this.#paintFlush(next, this.#physical, candidatePhysical, viewStart, true)
          this.#physical = candidatePhysical
        } else {
          body = this.#paintScreen(target.rows, this.#screen, true)
        }
      }
      this.#reanchor = false
    } else if (this.#resize !== undefined) {
      const transition = this.#resize
      const baseline = this.#resizedScreen(transition.oldHeight)
      body = this.#paintScreen(target.rows, baseline, transition.widthChanged)
      // The terminal has already moved rows between screen and scrollback.
      // Adopt that physical boundary rather than replaying those rows.
      this.#physical = viewStart
      this.#resize = undefined
    } else if (this.#reanchor) {
      if (candidatePhysical > this.#physical) {
        body = this.#paintFlush(next, this.#physical, candidatePhysical, viewStart, true)
        this.#physical = candidatePhysical
      } else if (next.length <= this.#physical) {
        body = this.#paintFlush(next, 0, candidatePhysical, viewStart, true)
        this.#physical = candidatePhysical
      } else {
        effectiveStart = Math.max(this.#physical, viewStart)
        target = this.#target(next, effectiveStart, 'bottom')
        body = this.#paintScreen(target.rows, this.#screen, true)
      }
      this.#reanchor = false
    } else if (this.#transient) {
      if (this.#adoptPhysicalAfterTransient) {
        body = this.#paintScreen(target.rows, this.#screen, true)
        this.#physical = viewStart
        this.#adoptPhysicalAfterTransient = false
      } else if (candidatePhysical > this.#physical) {
        body = this.#paintFlush(next, this.#physical, candidatePhysical, viewStart, false)
        this.#physical = candidatePhysical
      } else {
        effectiveStart = candidatePhysical < this.#physical && next.length > this.#physical
          ? Math.max(this.#physical, viewStart)
          : viewStart
        target = this.#target(next, effectiveStart, 'bottom')
        body = this.#paintScreen(target.rows, this.#screen, true)
      }
    } else if (next.length <= this.#physical) {
      // A logical clear/replace that was not explicitly signalled still needs
      // an independent index space. Keep old history and append the new epoch.
      body = this.#paintFlush(next, 0, candidatePhysical, viewStart, true)
      this.#physical = candidatePhysical
    } else if (candidatePhysical > this.#physical) {
      body = this.#paintFlush(next, this.#physical, candidatePhysical, viewStart, false)
      this.#physical = candidatePhysical
    } else {
      if (candidatePhysical < this.#physical) effectiveStart = Math.max(this.#physical, viewStart)
      target = this.#target(next, effectiveStart, 'bottom')
      body = this.#paintScreen(target.rows, this.#screen, false)
    }

    this.#transient = false
    this.#frameLines = next
    this.#frameLiveStart = liveStart
    return this.#finishPaint(exitAlt + body, target, next.length, cursor, cursorVisible)
  }

  #preserveHostScreen(): string {
    const preserve = this.#preserveScreenOnNextRender || (!this.#hasFrame && this.#preserveInitialScreen)
    this.#preserveScreenOnNextRender = false
    return preserve ? csi(this.#height - 1, 0) + '\r\n'.repeat(this.#height) : ''
  }

  #epochPrefix(): string[] {
    if (this.#resize !== undefined) this.#adoptMainResizeBoundary()
    const end = Math.max(this.#physical, Math.min(this.#frameLiveStart, this.#frameLines.length))
    return this.#frameLines.slice(this.#physical, end).map(line => sanitizeDisplayLine(String(line)))
  }

  #adoptMainResizeBoundary(): void {
    const transition = this.#resize
    if (transition === undefined) return
    this.#screen = transition.widthChanged ? this.#blankScreen() : this.#resizedScreen(transition.oldHeight)
    this.#physical = Math.max(0, this.#frameLines.length - this.#height)
    this.#resize = undefined
  }

  #freezeRows(rows: readonly string[]): string {
    if (rows.length === 0) return ''
    const frozen = rows.map(line => sanitizeDisplayLine(String(line)))
    const tape = [...frozen, ...this.#blankScreen()]
    let out = CLEAR_SCREEN
    for (let index = 0; index < tape.length; index += 1) {
      if (index > 0) out += '\r\n'
      out += CLEAR_LINE + (tape[index] ?? '')
    }
    return out
  }

  /** Emit finalized rows followed by the bounded live tail. */
  #paintFlush(
    next: readonly string[],
    start: number,
    committedEnd: number,
    viewStart: number,
    clearScreen: boolean,
    prefix: readonly string[] = [],
  ): string {
    const rows = [
      ...prefix,
      ...next.slice(start, committedEnd).map(line => sanitizeDisplayLine(String(line))),
      ...next.slice(viewStart, viewStart + this.#height).map(line => sanitizeDisplayLine(String(line))),
    ]
    let out = clearScreen ? CLEAR_SCREEN : csi(0, 0)
    if (rows.length < this.#height) out += csi(this.#height - rows.length, 0)
    for (let i = 0; i < rows.length; i += 1) {
      if (i > 0) out += '\r\n'
      // EL is required before a shorter final row scrolls into history.
      out += CLEAR_LINE + (rows[i] ?? '')
    }
    return out
  }

  #paintScreen(next: readonly string[], old: readonly string[], clear: boolean): string {
    return (clear ? CLEAR_SCREEN : '') + this.#paintDiff(next, clear ? this.#blankScreen() : old)
  }

  #paintDiff(next: readonly string[], old: readonly string[]): string {
    let out = ''
    let runStart = -1
    let runEnd = -1
    for (let row = 0; row < this.#height; row += 1) {
      const before = old[row] ?? ''
      const after = next[row] ?? ''
      if (before !== after) {
        if (runStart === -1) runStart = row
        runEnd = row
      } else if (runStart !== -1) {
        out += this.#writeRun(next, runStart, runEnd)
        runStart = -1
        runEnd = -1
      }
    }
    if (runStart !== -1) out += this.#writeRun(next, runStart, runEnd)
    return out
  }

  #writeRun(lines: readonly string[], start: number, end: number): string {
    let out = csi(start, 0)
    for (let row = start; row <= end; row += 1) {
      if (row > start) out += '\r\n'
      out += CLEAR_LINE + (lines[row] ?? '')
    }
    return out
  }

  #target(next: readonly string[], start: number, anchor: 'top' | 'bottom'): ScreenTarget {
    const content = next.slice(start, start + this.#height).map(line => sanitizeDisplayLine(String(line ?? '')))
    const offset = anchor === 'bottom' ? Math.max(0, this.#height - content.length) : 0
    const rows = this.#blankScreen()
    for (let i = 0; i < content.length; i += 1) rows[offset + i] = content[i] ?? ''
    return { rows, start, offset }
  }

  #takeResizeBaseline(): ResizeBaseline {
    if (this.#resize === undefined) return { rows: this.#screen, clear: false }
    const transition = this.#resize
    this.#resize = undefined
    this.#adoptPhysicalAfterTransient = true
    return {
      rows: transition.widthChanged ? this.#blankScreen() : this.#resizedScreen(transition.oldHeight),
      clear: transition.widthChanged,
    }
  }

  #resizedScreen(oldHeight: number): string[] {
    if (this.#height < oldHeight) return this.#screen.slice(oldHeight - this.#height)
    if (this.#height > oldHeight) {
      return [...Array.from({ length: this.#height - oldHeight }, () => ''), ...this.#screen]
    }
    return this.#screen.slice(0, this.#height)
  }

  #finishPaint(
    body: string,
    target: ScreenTarget,
    length: number,
    cursor: { row: number; column: number },
    cursorVisible: boolean,
  ): string {
    const targetRow = this.#screenRow(cursor.row, target, length)
    const targetCol = cursor.column
    const hide = !cursorVisible && this.#cursorVisible ? HIDE_CURSOR : ''
    const show = cursorVisible && !this.#cursorVisible ? SHOW_CURSOR : ''
    const moved = targetRow !== this.#cursorRow || targetCol !== this.#cursorCol
    const visibilityChanged = cursorVisible !== this.#cursorVisible
    const cursorOut = body !== '' || moved || visibilityChanged ? csi(targetRow, targetCol) : ''

    this.#cursorRow = targetRow
    this.#cursorCol = targetCol
    this.#cursorVisible = cursorVisible
    this.#screen = target.rows
    this.#hasFrame = true
    return this.#wrap(body + cursorOut + hide + show)
  }

  #screenRow(logicalRow: number, target: ScreenTarget, length: number): number {
    const clamped = Math.max(0, Math.min(Math.max(0, length - 1), logicalRow))
    return Math.max(0, Math.min(this.#height - 1, target.offset + clamped - target.start))
  }

  #blankScreen(): string[] {
    return Array.from({ length: this.#height }, () => '')
  }

  #wrap(payload: string): string {
    if (payload === '') return ''
    return this.#synchronized
      ? SYNC_OUTPUT_BEGIN + DISABLE_AUTOWRAP + payload + ENABLE_AUTOWRAP + SYNC_OUTPUT_END
      : DISABLE_AUTOWRAP + payload + ENABLE_AUTOWRAP
  }
}
