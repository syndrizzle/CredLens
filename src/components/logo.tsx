import { cn } from "@/lib/utils"

// Lifted corner mark: the source page's corner lifts off and becomes the arrow to the next step.
function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="6 4 36 40" fill="currentColor" aria-hidden="true" className={cn("size-6", className)}>
      <path d="M6 8H20L38 26V44H6ZM26 4H42V20Z" />
    </svg>
  )
}

export { Logo }
