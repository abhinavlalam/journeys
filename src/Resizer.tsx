import { useRef } from 'react'

interface ResizerProps {
  width: number
  onWidth: (width: number) => void
  min: number
  max: number
  /** Where a double-click resets it. */
  reset: number
  label: string
}

/**
 * Drag handle between two panes. Pointer capture, not window listeners, so
 * `pointerup` arrives even off the 5px strip or the window; with listeners
 * it could be missed and the handle kept resizing with no button held.
 */
export function Resizer({ width, onWidth, min, max, reset, label }: ResizerProps) {
  const start = useRef<{ x: number; width: number } | null>(null)

  return (
    <div
      className="resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        start.current = { x: e.clientX, width }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const delta = e.clientX - start.current.x
        onWidth(Math.min(max, Math.max(min, start.current.width + delta)))
      }}
      onPointerUp={(e) => {
        start.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={() => {
        start.current = null
      }}
      onDoubleClick={() => onWidth(reset)}
    />
  )
}
