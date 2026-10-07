/**
 * The canvas surface.
 *
 * Phase 0 renders the substrate only: an infinite plane with no chrome, no toolbar,
 * no input box, no status bar. Every affordance Phase 1 adds must be a spatial node.
 */
export function App() {
  return (
    <main
      data-testid="canvas-surface"
      aria-label="Penumbra spatial canvas"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'var(--color-void)',
        // A faint dot grid gives the infinite plane a sense of scale and motion
        // without drawing anything that could be mistaken for content.
        backgroundImage: 'radial-gradient(circle at 1px 1px, var(--color-slate) 1px, transparent 0)',
        backgroundSize: '32px 32px',
      }}
    />
  )
}
