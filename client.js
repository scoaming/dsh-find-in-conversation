window.__ModuleLoader__.load({
  id: 'dsh-find-in-conversation',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The conversation surface this bar searches; anchors are layout-neutral wrappers. */
    const FLOW_ANCHOR = '[data-slot="conversation.chat.flow"]'
    const MAX_MATCHES = 500
    const QUERY_DEBOUNCE_MS = 120
    const ROW_MUTATION_DEBOUNCE_MS = 300

    /** Registry names used by the CSS Custom Highlight API. */
    const HIGHLIGHT_ALL = 'dsh-find'
    const HIGHLIGHT_ACTIVE = 'dsh-find-active'

    /**
     * Matches are painted with the CSS Custom Highlight API instead of styled boxes: the
     * ranges live in another plugin's DOM, and letting the engine paint them means the
     * transcript's own clipping and scrolling stay authoritative.
     */
    const HIGHLIGHT_CSS = [
      '::highlight(' + HIGHLIGHT_ALL + ') { background-color: rgba(250, 204, 21, 0.45); }',
      '::highlight(' + HIGHLIGHT_ACTIVE + ') { background-color: rgba(249, 115, 22, 0.60); }'
    ].join('\n')

    const DICTIONARIES = {
      zh: {
        'find.placeholder': '在当前会话中查找',
        'find.count': '第 {index} / 共 {total}',
        'find.empty': '无匹配',
        'find.previous': '上一个',
        'find.next': '下一个',
        'find.close': '关闭'
      },
      en: {
        'find.placeholder': 'Find in this conversation',
        'find.count': '{index} of {total}',
        'find.empty': 'No matches',
        'find.previous': 'Previous match',
        'find.next': 'Next match',
        'find.close': 'Close'
      }
    }

    /** Used only when the host synthesizes no `t` seat for this entry. */
    const FALLBACK = DICTIONARIES.en

    function text(t, key, params) {
      const translate = typeof t === 'function' ? t : (name) => FALLBACK[name]
      const value = translate(key, params)
      return typeof value === 'string' ? value : FALLBACK[key]
    }

    const highlightsSupported = typeof CSS !== 'undefined' && CSS.highlights !== undefined && typeof Highlight === 'function'

    /** One constructed stylesheet for this document; CSP does not apply to constructed sheets. */
    let highlightSheet

    function retainHighlightSheet() {
      if (!highlightsSupported || highlightSheet !== undefined) return
      try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(HIGHLIGHT_CSS)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        highlightSheet = sheet
      } catch (error) {
        highlightSheet = undefined
      }
    }

    function releaseHighlightSheet() {
      if (highlightSheet === undefined) return
      const sheet = highlightSheet
      highlightSheet = undefined
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet)
      } catch (error) {
        // Leave the sheet behind rather than fail a teardown path.
      }
    }

    function clearHighlights() {
      if (!highlightsSupported) return
      CSS.highlights.delete(HIGHLIGHT_ALL)
      CSS.highlights.delete(HIGHLIGHT_ACTIVE)
    }

    /** The rendered conversation rows, or undefined when no conversation is open. */
    function conversationRoot() {
      const root = document.querySelector(FLOW_ANCHOR)
      return root === null ? undefined : root
    }

    /**
     * Slot anchors are `display: contents` wrappers, so they lay out no box. Climb to the
     * first ancestor that occupies space — and prefer the nearest scroll surface, because a
     * scrolled transcript's content column starts above the viewport and would otherwise
     * place the bar underneath the sticky Session header.
     */
    function scrollSurface(node) {
      let firstBox
      for (let current = node; current !== null; current = current.parentElement) {
        const rect = current.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          if (firstBox === undefined) firstBox = current
          const overflowY = window.getComputedStyle(current).overflowY
          if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') return current
        }
        if (current === document.body) break
      }
      return firstBox
    }

    /** Height of the desktop window's native caption strip, which drags the window. */
    function titlebarHeight() {
      const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')
      const value = Number.parseFloat(raw)
      return Number.isFinite(value) && value > 0 ? value : 0
    }

    function rangeFor(match) {
      const length = match.node.nodeValue === null ? 0 : match.node.nodeValue.length
      if (match.node.isConnected !== true || match.end > length) return undefined
      try {
        const range = document.createRange()
        range.setStart(match.node, match.start)
        range.setEnd(match.node, match.end)
        return range
      } catch (error) {
        return undefined
      }
    }

    /** True once the text actually paints: collapsed turns and folded branches paint nothing. */
    function paints(node, at, end) {
      if (node.isConnected !== true) return false
      const host = node.parentElement
      if (host === null) return false
      if (typeof host.checkVisibility === 'function' && host.checkVisibility() === false) return false
      try {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, end)
        const rects = range.getClientRects()
        for (let i = 0; i < rects.length; i += 1) {
          if (rects[i].width > 0 && rects[i].height > 0) return true
        }
        return false
      } catch (error) {
        return false
      }
    }

    /** Case-insensitive, non-overlapping matches over the painted conversation text. */
    function collect(root, query) {
      const needle = query.toLowerCase()
      if (needle.length === 0) return []
      const matches = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null && matches.length < MAX_MATCHES) {
        const value = node.nodeValue
        if (value !== null && value.length > 0) {
          const haystack = value.toLowerCase()
          let from = 0
          while (matches.length < MAX_MATCHES) {
            const at = haystack.indexOf(needle, from)
            if (at === -1) break
            // Folded turns stay in the DOM, so counting them would inflate the total and leave
            // Enter pressing through matches that cannot be scrolled to.
            if (paints(node, at, at + needle.length)) {
              matches.push({ node, start: at, end: at + needle.length })
            }
            from = at + needle.length
          }
        }
        node = walker.nextNode()
      }
      return matches
    }

    function FindBar(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [matches, setMatches] = React.useState([])
      const [index, setIndex] = React.useState(0)
      const [geometry, setGeometry] = React.useState(undefined)
      const [focused, setFocused] = React.useState(false)
      const inputRef = React.useRef(null)
      const barRef = React.useRef(null)
      const matchesRef = React.useRef([])
      const indexRef = React.useRef(0)
      const surfaceRef = React.useRef(undefined)
      const focusRef = React.useRef(null)
      const lastQueryRef = React.useRef('')

      /** Lays the bar just under the Session header, horizontally centered on the transcript. */
      const measure = React.useCallback(() => {
        const root = conversationRoot()
        const surface = root === undefined ? undefined : scrollSurface(root)
        surfaceRef.current = surface
        const rect = surface === undefined ? undefined : surface.getBoundingClientRect()
        if (rect === undefined) {
          setGeometry((previous) => (previous === undefined ? previous : undefined))
          return
        }
        const top = Math.max(Math.min(rect.top + 8, window.innerHeight - 64), titlebarHeight() + 40)
        const center = rect.left + rect.width / 2
        const half = Math.min(190, (window.innerWidth - 32) / 2)
        const left = Math.max(Math.min(center, window.innerWidth - half - 16), half + 16)
        setGeometry((previous) => (
          previous !== undefined && previous.left === left && previous.top === top
            ? previous
            : { left, top }
        ))
      }, [])

      /** Re-registers the painted ranges; the engine keeps them glued to their text. */
      const paintHighlights = React.useCallback((found, active) => {
        if (!highlightsSupported) return
        try {
          const ranges = []
          for (let i = 0; i < found.length; i += 1) {
            const range = rangeFor(found[i])
            if (range !== undefined) ranges.push(range)
          }
          if (ranges.length === 0) {
            clearHighlights()
            return
          }
          CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges))
          const current = found[active] === undefined ? undefined : rangeFor(found[active])
          if (current === undefined) CSS.highlights.delete(HIGHLIGHT_ACTIVE)
          else CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(current))
        } catch (error) {
          clearHighlights()
        }
      }, [])

      /** Never scrolls while the reader types: only explicit navigation moves the transcript. */
      const search = React.useCallback((nextQuery) => {
        measure()
        const root = conversationRoot()
        const found = root === undefined ? [] : collect(root, nextQuery)
        const fresh = lastQueryRef.current !== nextQuery
        lastQueryRef.current = nextQuery
        const next = fresh ? 0 : Math.min(indexRef.current, Math.max(0, found.length - 1))
        matchesRef.current = found
        indexRef.current = next
        setMatches(found)
        setIndex(next)
        paintHighlights(found, next)
      }, [measure, paintHighlights])

      /** Brings the current match into the middle of the transcript without touching focus. */
      const scrollToMatch = React.useCallback((match) => {
        const range = rangeFor(match)
        if (range === undefined) return
        const rect = range.getBoundingClientRect()
        // Folded branches paint nothing; the match cannot be centred and must not be counted.
        if (rect.width === 0 && rect.height === 0) return
        const host = range.startContainer.parentElement
        if (host !== null && typeof host.scrollIntoView === 'function') {
          // Native scrolling walks up to whatever really scrolls the transcript, so the bar does
          // not have to guess which ancestor owns the overflow.
          host.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
          return
        }
        const surface = surfaceRef.current
        if (surface === undefined) return
        const box = surface.getBoundingClientRect()
        const target = surface.scrollTop + (rect.top - box.top) - (box.height / 2) + (rect.height / 2)
        surface.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
      }, [])

      const step = React.useCallback((delta) => {
        const found = matchesRef.current
        if (found.length === 0) return
        const next = (indexRef.current + delta + found.length) % found.length
        indexRef.current = next
        setIndex(next)
        paintHighlights(found, next)
        scrollToMatch(found[next])
      }, [paintHighlights, scrollToMatch])

      const close = React.useCallback(() => {
        setOpen(false)
        matchesRef.current = []
        indexRef.current = 0
        lastQueryRef.current = ''
        setMatches([])
        setIndex(0)
        surfaceRef.current = undefined
        clearHighlights()
        releaseHighlightSheet()
      }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          const primary = event.ctrlKey || event.metaKey
          const chord = primary && !event.altKey && !event.shiftKey && event.code === 'KeyF'
          if (open) {
            if (chord) {
              event.preventDefault()
              event.stopPropagation()
              if (inputRef.current !== null) {
                inputRef.current.focus()
                inputRef.current.select()
              }
              return
            }
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          }
          if (!chord) return
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open, close])

      React.useEffect(() => {
        if (!open) return undefined
        focusRef.current = document.activeElement
        retainHighlightSheet()
        measure()
        const input = inputRef.current
        if (input !== null) {
          input.focus()
          input.select()
        }
        return () => {
          const previous = focusRef.current
          focusRef.current = null
          if (previous !== null && previous.isConnected === true && typeof previous.focus === 'function') previous.focus()
          clearHighlights()
        }
      }, [open, measure])

      React.useEffect(() => {
        if (!open) return undefined
        const handle = window.setTimeout(() => search(query), QUERY_DEBOUNCE_MS)
        return () => window.clearTimeout(handle)
      }, [open, query, search])

      React.useEffect(() => {
        if (!open) return undefined
        let handle = null
        const observer = new MutationObserver((records) => {
          // The bar's own counter and highlight updates must not schedule another search.
          if (barRef.current !== null && records.every((record) => barRef.current.contains(record.target))) return
          if (handle !== null) window.clearTimeout(handle)
          handle = window.setTimeout(() => {
            handle = null
            search(query)
          }, ROW_MUTATION_DEBOUNCE_MS)
        })
        observer.observe(document.body, { childList: true, characterData: true, subtree: true })
        return () => {
          observer.disconnect()
          if (handle !== null) window.clearTimeout(handle)
        }
      }, [open, query, search])

      React.useEffect(() => {
        if (!open) return undefined
        const onResize = () => measure()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [open, measure])

      const onInputKeyDown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          step(event.shiftKey ? -1 : 1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }

      if (!open) return null

      const position = geometry === undefined
        ? { top: (titlebarHeight() + 12) + 'px', left: '50%', transform: 'translateX(-50%)' }
        : { top: geometry.top + 'px', left: geometry.left + 'px', transform: 'translateX(-50%)' }

      const barStyle = {
        ...position,
        position: 'fixed',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        width: '380px',
        maxWidth: 'calc(100vw - 32px)',
        boxSizing: 'border-box',
        padding: '6px 8px',
        pointerEvents: 'auto',
        // The desktop caption strip is a window-drag region, and Electron resolves those
        // geometrically rather than by stacking: without this the bar would swallow the
        // press as a window drag, leaving the buttons dead to the mouse.
        WebkitAppRegion: 'no-drag',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid ' + (focused ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        borderRadius: '10px'
      }

      const button = (label, hint, delta) => h('button', {
        type: 'button',
        style: BUTTON_STYLE,
        title: hint,
        'aria-label': hint,
        // Keep the caret in the input: a press here must not steal typing focus.
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => step(delta)
      }, label)

      const total = matches.length >= MAX_MATCHES ? MAX_MATCHES + '+' : String(matches.length)
      const count = matches.length === 0
        ? text(t, 'find.empty')
        : text(t, 'find.count', { index: Math.min(index + 1, matches.length), total })

      return h(
        'div',
        { ref: barRef, style: barStyle, role: 'search', 'data-dsh-find-bar': '' },
        h('input', {
          ref: inputRef,
          type: 'text',
          value: query,
          placeholder: text(t, 'find.placeholder'),
          'aria-label': text(t, 'find.placeholder'),
          style: INPUT_STYLE,
          onChange: (event) => setQuery(event.target.value),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onKeyDown: onInputKeyDown
        }),
        h('span', { style: COUNT_STYLE, 'aria-live': 'polite' }, count),
        button('↑', text(t, 'find.previous'), -1),
        button('↓', text(t, 'find.next'), 1),
        h('button', {
          type: 'button',
          style: BUTTON_STYLE,
          title: text(t, 'find.close'),
          'aria-label': text(t, 'find.close'),
          onMouseDown: (event) => event.preventDefault(),
          onClick: close
        }, '✕')
      )
    }

    const INPUT_STYLE = {
      flex: '1 1 auto',
      minWidth: '0',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px'
    }

    const COUNT_STYLE = {
      flex: '0 0 auto',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums'
    }

    const BUTTON_STYLE = {
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '24px',
      height: '24px',
      padding: '0',
      background: 'transparent',
      border: 'none',
      borderRadius: '6px',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '14px',
      lineHeight: '1',
      cursor: 'pointer'
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('find-in-conversation', DICTIONARIES), 'find-in-conversation: dictionaries')
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'find-in-conversation',
              order: 100,
              locale: 'find-in-conversation'
            },
            FindBar
          )
        )
      }
    }
  }
})
