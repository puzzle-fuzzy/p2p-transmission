type AvatarProps = {
  seed: string
  label?: string
  highlighted?: boolean
  className?: string
}

type AvatarPalette = {
  background: string
  primary: string
  highlight: string
}

const palettes: AvatarPalette[] = [
  { background: '#241846', primary: '#8b6cff', highlight: '#d9d0ff' },
  { background: '#12382f', primary: '#52c995', highlight: '#b8f5dd' },
  { background: '#3b2a17', primary: '#e2aa5f', highlight: '#ffe2ad' },
  { background: '#153149', primary: '#5fb8ff', highlight: '#c7ebff' },
  { background: '#411d35', primary: '#ee77ae', highlight: '#ffd0e5' },
  { background: '#233b32', primary: '#93d86f', highlight: '#e0fac8' },
]

const hashSeed = (seed: string) => {
  let hash = 2_166_136_261

  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }

  return hash >>> 0
}

const createPattern = (seed: number) => {
  let state = seed || 1
  const pattern: boolean[] = []

  for (let index = 0; index < 15; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    pattern.push((state & 3) < 2)
  }

  if (!pattern.some(Boolean)) pattern[7] = true

  return pattern
}

const createCells = (pattern: readonly boolean[]) => {
  const cells: Array<{ column: number; row: number; highlight: boolean }> = []

  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const patternIndex = row * 3 + column
      if (!pattern[patternIndex]) continue

      const mirroredColumn = 4 - column
      cells.push({
        column,
        row,
        highlight: pattern[(patternIndex + 5) % pattern.length] ?? false,
      })

      if (mirroredColumn !== column) {
        cells.push({
          column: mirroredColumn,
          row,
          highlight: pattern[(patternIndex + 5) % pattern.length] ?? false,
        })
      }
    }
  }

  return cells
}

export default function Avatar({ seed, label, highlighted = false, className = '' }: AvatarProps) {
  const hash = hashSeed(seed)
  const palette = palettes[hash % palettes.length] ?? palettes[0]
  const cells = createCells(createPattern(hash))

  return (
    <div
      className={`relative isolate size-12 shrink-0 ${highlighted ? 'avatar--highlighted z-10' : ''} ${className}`}
      title={label}
      aria-label={label}
      role="img"
    >
      {highlighted && (
        <>
          <span className="avatar__ripple" aria-hidden="true" />
          <span className="avatar__ripple avatar__ripple--delayed" aria-hidden="true" />
        </>
      )}
      <div
        data-avatar-face="true"
        className="avatar__face relative z-10 flex size-full items-center justify-center overflow-hidden rounded-full border-2 border-surface"
        style={{
          backgroundColor: palette.background,
          borderColor: highlighted ? '#fff' : undefined,
        }}
      >
        <svg
          className="size-full"
          viewBox="0 0 5 5"
          role="presentation"
          focusable="false"
          aria-hidden="true"
        >
          {cells.map(cell => (
            <rect
              key={`${cell.column}-${cell.row}`}
              x={cell.column + 0.14}
              y={cell.row + 0.14}
              width="0.72"
              height="0.72"
              rx="0.22"
              fill={cell.highlight ? palette.highlight : palette.primary}
            />
          ))}
        </svg>
      </div>
    </div>
  )
}
