type AvatarProps = {
  seed: string
  label?: string
  className?: string
}

const swatches = [
  '#5e11d1',
  '#3f6f5f',
  '#7a5b2e',
  '#315b7d',
  '#7a3f57',
  '#4b6451',
]

const hashSeed = (seed: string) =>
  Array.from(seed).reduce((hash, char) => hash + char.charCodeAt(0), 0)

export default function Avatar({ seed, label, className = '' }: AvatarProps) {
  const hash = hashSeed(seed)
  const backgroundColor = swatches[hash % swatches.length]
  const display = label?.trim() || seed
  const initials = display.replace(/\s+/g, '').slice(-2).toUpperCase()

  return (
    <div
      className={`w-9 h-9 rounded-full border-2 border-[#2d2d2d] flex items-center justify-center text-[11px] text-white/85 tabular-nums ${className}`}
      style={{ backgroundColor }}
      title={label}
      aria-label={label}
    >
      {initials}
    </div>
  )
}
