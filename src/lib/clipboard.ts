/**
 * Copy text to the clipboard, with a fallback for browsers that refuse the
 * async Clipboard API (Safari outside a user gesture, any non-secure context).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection-based path below.
  }

  try {
    const area = document.createElement("textarea")
    area.value = text
    // Off-screen but still focusable — execCommand ignores hidden elements.
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "-1000px"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
