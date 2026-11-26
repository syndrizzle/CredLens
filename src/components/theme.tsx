import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { HugeiconsIcon } from "@hugeicons/react"
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type Theme = "light" | "dark" | "system"

// Keep in sync with the pre-paint script in index.html.
const STORAGE_KEY = "credlens-theme"
const THEMES: Theme[] = ["light", "dark", "system"]

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
})

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(
    () => THEMES.find((item) => item === localStorage.getItem(STORAGE_KEY)) ?? "system",
  )

  // Layout effect so the class is applied inside flushSync during a view transition.
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      // Without this, each component's own colour transition makes the switch ripple unevenly.
      const freeze = document.createElement("style")
      freeze.textContent = "*,*::before,*::after{transition:none!important}"
      document.head.append(freeze)
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      )
      void window.getComputedStyle(document.body).color
      requestAnimationFrame(() => freeze.remove())
    }
    apply()
    if (theme !== "system") return
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme])

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: (next) => {
          localStorage.setItem(STORAGE_KEY, next)
          // Cross-fade the whole page so light and dark do not swap with a hard brightness jump.
          if (!document.startViewTransition) return setTheme(next)
          document.startViewTransition(() => flushSync(() => setTheme(next)))
        },
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

function ModeToggle() {
  const { theme, setTheme } = useContext(ThemeContext)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Theme" />}>
        <HugeiconsIcon icon={Sun03Icon} className="dark:hidden" />
        <HugeiconsIcon icon={Moon02Icon} className="hidden dark:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value: Theme) => setTheme(value)}>
          <DropdownMenuRadioItem value="light" closeOnClick>Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" closeOnClick>Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" closeOnClick>System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ModeToggle, ThemeProvider }
